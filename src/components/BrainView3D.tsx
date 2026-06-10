import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ForceGraph3D, { type ForceGraphMethods } from 'react-force-graph-3d';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {
  loadPointCloud, pcaBasis, projectWithBasis, makePointPicker, pointAt,
  BRAIN_ROT_X, type Vec3, type Basis, type PointPicker,
} from '../lib/brain3d';

interface GNode {
  id: string; label?: string; category?: string; color?: string; val?: number; embedding?: number[];
  x?: number; y?: number; z?: number; fx?: number; fy?: number; fz?: number;
}
interface GLink { source: any; target: any }
interface GraphData { nodes: GNode[]; links: GLink[] }

export type ShellMode = 'translucent' | 'off' | 'textured';
const SHELL_CYCLE: ShellMode[] = ['translucent', 'off', 'textured'];
const ASSET = './brain';
const NODE_BASE_R = 0.0035;
const NEURON_SIZE = 3.75;   // size multiplier for the neuron mesh (×old sphere diameter)
const TAU = Math.PI * 2;
const linkEnd = (e: any) => (typeof e === 'object' && e ? e.id : e);

// Deterministic 0..1 from a node id + salt (FNV-1a). Drives each neuron's random
// rotation and scale jitter so a given neuron always looks the same — no
// Math.random, which would re-roll (and visibly spin/resize) every rebuild.
function hash01(str: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

interface NeuronTpl { geo: THREE.BufferGeometry; matNormal: THREE.Material; matDim: THREE.Material; matFocused: THREE.Material; maxDim: number }

// ── point-cloud shader: faint motes that glow only near neurons ──────────────
const CLOUD_VERT = `
  attribute float aPhase;
  attribute float aProx;     // 0 = far from any neuron, 1 = right next to one
  uniform float uTime;
  uniform float uSize;
  varying float vTwinkle;
  varying float vProx;
  void main() {
    vTwinkle = 0.6 + 0.4 * sin(uTime * 0.5 + aPhase);
    vProx = aProx;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(uSize / -mv.z, 0.5, 2.4) * (0.7 + 0.5 * aProx);
    gl_Position = projectionMatrix * mv;
  }`;
const CLOUD_FRAG = `
  uniform vec3 uColor;
  uniform vec3 uGlow;
  uniform float uOpacity;
  varying float vTwinkle;
  varying float vProx;
  void main() {
    float r = length(gl_PointCoord - vec2(0.5));
    if (r > 0.5) discard;
    float soft = smoothstep(0.5, 0.0, r);
    vec3 col = mix(uColor, uGlow, vProx);
    // far points: barely visible; near points: glow
    float a = soft * uOpacity * (0.08 + 0.92 * vProx) * (0.6 + 0.4 * vTwinkle);
    gl_FragColor = vec4(col, a);
  }`;

export function BrainView3D({
  graph, focusedId, highlightIds, onNodeClick, onBackground,
}: {
  graph: GraphData;
  focusedId?: string | null;
  highlightIds?: Set<string>;
  onNodeClick?: (id: string) => void;
  onBackground?: () => void;
}) {
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [shell, setShell] = useState<ShellMode>('translucent');
  const [autoRotate, setAutoRotate] = useState(true);
  const autoRotateRef = useRef(autoRotate); autoRotateRef.current = autoRotate;

  const cloudRef = useRef<THREE.Points | null>(null);
  const cloudPosRef = useRef<Float32Array | null>(null);   // subsampled positions
  const cloudProxRef = useRef<THREE.BufferAttribute | null>(null);
  const shellRef = useRef<THREE.Mesh | null>(null);
  const texRef = useRef<THREE.Texture[] | null>(null);
  const neuronTplRef = useRef<NeuronTpl | null>(null);   // shared neuron mesh + 3 material variants
  const [neuronReady, setNeuronReady] = useState(false); // flips nodeObject from sphere → mesh
  const rafRef = useRef<number>(0);

  // stable placement state (persists across cluster toggles / graph rebuilds)
  const pickerRef = useRef<PointPicker | null>(null);
  const basisRef = useRef<Basis | null>(null);
  const baseRef = useRef<Map<string, Vec3>>(new Map());     // id → pinned base point
  const idToIdxRef = useRef<Map<string, number>>(new Map()); // id → cloud point index (for release)
  const driftRef = useRef<{ n: any; bx: number; by: number; bz: number; ph: number }[]>([]);

  // custom pulse system (the library floors its particle radius at 0.05, so we
  // roll our own to fully control size + keep it alive across cluster toggles)
  const pulseLinksRef = useRef<{ s: string; t: string }[]>([]);
  // u/v/len/ph are the per-pulse wiggle basis (see PULSE WIGGLE block) — optional
  // so removing the feature needs no type change.
  const pulseActiveRef = useRef<{ m: THREE.Mesh; s: Vec3; e: Vec3; t0: number; u?: Vec3; v?: Vec3; len?: number; ph?: number }[]>([]);
  const pulsePoolRef = useRef<THREE.Mesh[]>([]);

  // ── fit the canvas to the panel (was rendering at window size) ────────────
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── fresh node objects each rebuild (so react-force-graph fully reprocesses
  // nodes AND links → links never get orphaned), but positions are preserved by
  // pinning from the cached coordinates so nothing visually moves on a toggle ─
  const stableGraph = useMemo(() => {
    const base = baseRef.current;
    const nodes = graph.nodes.map((spec) => {
      const n: any = { id: spec.id, label: spec.label, color: spec.color, val: spec.val, category: spec.category, embedding: spec.embedding };
      const p = base.get(spec.id);
      if (p) { n.x = n.fx = p.x; n.y = n.fy = p.y; n.z = n.fz = p.z; }
      return n;
    });
    const links = graph.links.map((l) => ({ source: linkEnd(l.source), target: linkEnd(l.target) }));
    return { nodes, links };
  }, [graph]);

  // ── one-time cinematic scene setup ────────────────────────────────────────
  useEffect(() => {
    const fg = fgRef.current; if (!fg) return;
    const scene = fg.scene();
    const renderer = fg.renderer();
    let disposed = false;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    scene.fog = new THREE.FogExp2(0x04060d, 0.16);

    const sz = renderer.getSize(new THREE.Vector2());
    const bloom = new UnrealBloomPass(new THREE.Vector2(sz.x, sz.y), 0.5, 0.35, 0.6);
    try { fg.postProcessingComposer().addPass(bloom); } catch { /* not ready */ }

    const amb = new THREE.AmbientLight(0x4060a0, 0.5);
    const key = new THREE.DirectionalLight(0x88bbff, 1.0); key.position.set(2, 3, 2);
    const rim = new THREE.DirectionalLight(0xff6ec7, 0.5); rim.position.set(-2, -1, -2);
    scene.add(amb, key, rim);

    const controls: any = fg.controls();
    if (controls) {
      controls.enableDamping = true; controls.dampingFactor = 0.08;
      if ('autoRotate' in controls) { controls.autoRotate = true; controls.autoRotateSpeed = 0.3; }
    }
    setTimeout(() => { try { fg.cameraPosition({ x: 0, y: 0, z: 2.4 }, { x: 0, y: 0, z: 0 }, 0); } catch {} }, 60);

    // subsample the cloud to ~10% so it reads as soft structure, not a thick wall
    loadPointCloud(`${ASSET}/points.f32`).then((pts) => {
      if (disposed) return;
      const keep: number[] = [];
      for (let i = 0; i < pts.length / 3; i++) if ((i * 0.61803398875) % 1 < 0.1) keep.push(i);
      const pos = new Float32Array(keep.length * 3);
      keep.forEach((idx, k) => { pos[k * 3] = pts[idx * 3]; pos[k * 3 + 1] = pts[idx * 3 + 1]; pos[k * 3 + 2] = pts[idx * 3 + 2]; });
      cloudPosRef.current = pos;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const phase = new Float32Array(keep.length);
      for (let i = 0; i < phase.length; i++) phase[i] = (i * 0.61803) % (Math.PI * 2);
      geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
      const prox = new THREE.BufferAttribute(new Float32Array(keep.length), 1);
      cloudProxRef.current = prox;
      geo.setAttribute('aProx', prox);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uSize: { value: 5.5 },
          uColor: { value: new THREE.Color(0x3a6bd0) },
          uGlow: { value: new THREE.Color(0x9fe6ff) },
          uOpacity: { value: 0.5 },
        },
        vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geo, mat); points.frustumCulled = false;
      cloudRef.current = points; scene.add(points);
    }).catch((e) => console.error('[brain3d] cloud load failed', e));

    new GLTFLoader().load(`${ASSET}/brainMesh.gltf`, (gltf) => {
      if (disposed) return;
      let geom: THREE.BufferGeometry | null = null;
      gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !geom) geom = (o as THREE.Mesh).geometry; });
      if (!geom) return;
      const mesh = new THREE.Mesh(geom, glassMaterial());
      mesh.rotation.x = BRAIN_ROT_X;
      shellRef.current = mesh; scene.add(mesh); applyShell('translucent');
    }, undefined, (e) => console.error('[brain3d] mesh load failed', e));

    // neuron mesh — loaded once, cloned per node. We bake the Houdini node
    // transforms into the geometry and center it on its bounding box so it sits
    // exactly on each interior point. The mesh carries baked vertex colors
    // (COLOR_0) rather than textures, so we render it unlit with vertexColors.
    new GLTFLoader().load(`${ASSET}/neuronMesh.gltf`, (gltf) => {
      if (disposed) return;
      gltf.scene.updateMatrixWorld(true);
      let found: THREE.Mesh | null = null;
      gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !found) found = o as THREE.Mesh; });
      const src = found as THREE.Mesh | null;
      if (!src) return;
      const geo = src.geometry.clone();
      geo.applyMatrix4(src.matrixWorld);          // bake exporter rotation/scale
      geo.computeBoundingBox();
      const c = geo.boundingBox!.getCenter(new THREE.Vector3());
      geo.translate(-c.x, -c.y, -c.z);            // origin = mesh center
      const sz = geo.boundingBox!.getSize(new THREE.Vector3());
      const maxDim = Math.max(sz.x, sz.y, sz.z) || 1;

      // Houdini baked COLOR_0 with values well outside [0,1] (raw Cd). Normalize
      // by the largest channel so the hues survive the framebuffer clamp.
      const colAttr = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
      const hasVertexColors = !!colAttr;
      if (colAttr) {
        const a = colAttr.array as Float32Array;
        let mx = 0; for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];
        if (mx > 1) for (let i = 0; i < a.length; i++) a[i] /= mx;
        colAttr.needsUpdate = true;
      }

      let matNormal: THREE.Material, matDim: THREE.Material, matFocused: THREE.Material;
      if (hasVertexColors) {
        // unlit so the baked colors read exactly as authored (and bloom-friendly)
        matNormal = new THREE.MeshBasicMaterial({ vertexColors: true });
        matDim = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.28 });
        matFocused = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }); // brighter → bloom glow
      } else {
        matNormal = Array.isArray(src.material) ? src.material[0] : src.material;
        matDim = matNormal.clone(); matDim.transparent = true; matDim.opacity = 0.28;
        matFocused = matNormal.clone();
        const mf = matFocused as THREE.MeshStandardMaterial;
        if ('emissive' in mf) { mf.emissive = new THREE.Color(0x6fd0ff); mf.emissiveIntensity = 0.9; }
      }

      // react-force-graph calls geometry.dispose()/material.dispose()/map.dispose()
      // for EVERY node it removes from the digest (e.g. on cluster toggles). These
      // resources are SHARED across all neurons, so neutralize per-node disposal —
      // we free them ourselves on teardown instead (see cleanup below).
      const noop = () => {};
      geo.dispose = noop;
      for (const mm of [matNormal, matDim, matFocused]) {
        mm.dispose = noop;
        const t = (mm as THREE.MeshStandardMaterial).map; if (t) t.dispose = noop;
      }

      neuronTplRef.current = { geo, matNormal, matDim, matFocused, maxDim };
      setNeuronReady(true);
    }, undefined, (e) => console.error('[brain3d] neuron mesh load failed', e));

    // custom pulse rig — small bright sparks that glide along links. Radius is
    // fully ours (the library can't go below 0.05), so these stay neuron-scale.
    const PULSE_R = 0.002, PULSE_MS = 1300, PULSE_EVERY = 3200, PULSE_CAP = 60;

    // ── PULSE WIGGLE (revertible) ────────────────────────────────────────────
    // Adds chaotic 3D jiggle to sparks instead of a straight A→B line. To revert:
    // set PULSE_WIGGLE = false (or delete this block + the wiggle branch in tick).
    const PULSE_WIGGLE = true;
    const WIGGLE_AMP = 0.045;   // offset as a fraction of link length (peak, mid-flight)
    const WIGGLE_F1 = 6.3, WIGGLE_F2 = 9.7;   // spatial frequencies along the path
    const WIGGLE_T1 = 2.1, WIGGLE_T2 = 3.3;   // temporal frequencies (per second)
    let pulseSeed = 0;        // per-pulse phase so each spark wiggles differently
    // unit basis (u,v) spanning the plane perpendicular to the link direction
    const perpBasis = (s: Vec3, e: Vec3): { u: Vec3; v: Vec3; len: number } => {
      let dx = e.x - s.x, dy = e.y - s.y, dz = e.z - s.z;
      const len = Math.hypot(dx, dy, dz) || 1e-6;
      dx /= len; dy /= len; dz /= len;
      // pick a reference axis not parallel to the direction
      const ax = Math.abs(dy) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      // u = normalize(dir × ax)
      let ux = dy * ax.z - dz * ax.y, uy = dz * ax.x - dx * ax.z, uz = dx * ax.y - dy * ax.x;
      const ul = Math.hypot(ux, uy, uz) || 1e-6; ux /= ul; uy /= ul; uz /= ul;
      // v = dir × u (already unit)
      const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
      return { u: { x: ux, y: uy, z: uz }, v: { x: vx, y: vy, z: vz }, len };
    };
    // ─────────────────────────────────────────────────────────────────────────

    const pulseGeo = new THREE.SphereGeometry(PULSE_R, 8, 8);
    const pulseMat = new THREE.MeshBasicMaterial({ color: 0xcfeeff, transparent: true, opacity: 0.875, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const emitPulses = (now: number) => {
      const base = baseRef.current; let count = 0;
      for (const l of pulseLinksRef.current) {
        if (count >= PULSE_CAP) break;
        const s = base.get(l.s), e = base.get(l.t);
        if (!s || !e) continue;
        const m = pulsePoolRef.current.pop() || new THREE.Mesh(pulseGeo, pulseMat);
        m.position.set(s.x, s.y, s.z); m.visible = true; scene.add(m);
        const w = PULSE_WIGGLE ? perpBasis(s, e) : null;
        pulseActiveRef.current.push({ m, s, e, t0: now, u: w?.u, v: w?.v, len: w?.len, ph: (pulseSeed++ * 1.618) % (Math.PI * 2) });
        count++;
      }
    };

    const start = performance.now();
    const AMP = 0.004;       // drift radius ≈ 0.4% of brain (was 1.2%)
    let lastProx = 0, nextPulse = 600;
    const tick = () => {
      const ms = performance.now() - start;
      const t = ms / 1000;
      if (cloudRef.current) (cloudRef.current.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
      for (const d of driftRef.current) {
        const x = d.bx + AMP * Math.sin(t * 0.25 + d.ph);
        const y = d.by + AMP * Math.sin(t * 0.22 + d.ph * 1.7);
        const z = d.bz + AMP * Math.sin(t * 0.28 + d.ph * 2.3);
        d.n.fx = d.n.x = x; d.n.fy = d.n.y = y; d.n.fz = d.n.z = z;
      }
      // advance + retire active pulses
      const act = pulseActiveRef.current;
      for (let i = act.length - 1; i >= 0; i--) {
        const a = act[i]; const p = (ms - a.t0) / PULSE_MS;
        if (p >= 1) { scene.remove(a.m); pulsePoolRef.current.push(a.m); act.splice(i, 1); continue; }
        let px = a.s.x + (a.e.x - a.s.x) * p, py = a.s.y + (a.e.y - a.s.y) * p, pz = a.s.z + (a.e.z - a.s.z) * p;
        // ── PULSE WIGGLE (revertible): perpendicular noise, zero at both ends ──
        if (a.u && a.v) {
          const ph = a.ph ?? 0;
          const env = Math.sin(p * Math.PI);                 // 0 at A and B, 1 mid-flight
          const amp = WIGGLE_AMP * (a.len ?? 1) * env;
          const o1 = Math.sin(p * WIGGLE_F1 + ph + t * WIGGLE_T1) + 0.5 * Math.sin(p * WIGGLE_F2 + ph * 1.7 + t * WIGGLE_T2);
          const o2 = Math.cos(p * WIGGLE_F2 - ph + t * WIGGLE_T2) + 0.5 * Math.cos(p * WIGGLE_F1 + ph * 0.6 - t * WIGGLE_T1);
          px += (a.u.x * o1 + a.v.x * o2) * amp;
          py += (a.u.y * o1 + a.v.y * o2) * amp;
          pz += (a.u.z * o1 + a.v.z * o2) * amp;
        }
        // ──────────────────────────────────────────────────────────────────────
        a.m.position.set(px, py, pz);
        a.m.scale.setScalar(0.4 + 0.6 * Math.sin(p * Math.PI)); // fade in/out
      }
      if (ms > nextPulse) { nextPulse = ms + PULSE_EVERY; emitPulses(ms); }
      if (t - lastProx > 0.8) { lastProx = t; updateProximity(); }
      if (controls) { controls.autoRotate = autoRotateRef.current; controls.update?.(); }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      disposed = true; cancelAnimationFrame(rafRef.current);
      for (const a of pulseActiveRef.current) scene.remove(a.m);
      pulseActiveRef.current = []; pulsePoolRef.current = [];
      pulseGeo.dispose(); pulseMat.dispose();
      if (cloudRef.current) { scene.remove(cloudRef.current); cloudRef.current.geometry.dispose(); }
      if (shellRef.current) scene.remove(shellRef.current);
      const tpl = neuronTplRef.current;
      if (tpl) {
        // dispose for real (instance .dispose was neutered above) via the prototypes
        THREE.BufferGeometry.prototype.dispose.call(tpl.geo);
        const std = tpl.matNormal as THREE.MeshStandardMaterial;
        for (const t of [std.map, std.metalnessMap, std.roughnessMap, std.normalMap]) if (t) THREE.Texture.prototype.dispose.call(t);
        for (const mm of [tpl.matNormal, tpl.matDim, tpl.matFocused]) THREE.Material.prototype.dispose.call(mm);
        neuronTplRef.current = null;
      }
      scene.remove(amb, key, rim); scene.fog = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // recompute each cloud point's closeness to the nearest neuron (drives glow)
  function updateProximity() {
    const pos = cloudPosRef.current, prox = cloudProxRef.current;
    if (!pos || !prox) return;
    const neurons = [...baseRef.current.values()];
    const arr = prox.array as Float32Array;
    const R2 = 0.10 * 0.10; // glow radius ≈ 10% of brain
    if (!neurons.length) { arr.fill(0); prox.needsUpdate = true; return; }
    for (let i = 0; i < arr.length; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      let best = Infinity;
      for (const n of neurons) {
        const d = (n.x - x) ** 2 + (n.y - y) ** 2 + (n.z - z) ** 2;
        if (d < best) { best = d; if (best < 1e-5) break; }
      }
      arr[i] = Math.max(0, 1 - best / R2); // 1 next to a neuron → 0 beyond the radius
    }
    prox.needsUpdate = true;
  }

  // ── shell materials ───────────────────────────────────────────────────────
  function glassMaterial(): THREE.Material {
    return new THREE.MeshPhysicalMaterial({
      color: 0x4a6cff, transparent: true, opacity: 0.07, roughness: 0.15, metalness: 0,
      transmission: 0.9, thickness: 0.4, ior: 1.3, side: THREE.DoubleSide, depthWrite: false,
      clearcoat: 1, clearcoatRoughness: 0.2,
    });
  }
  async function texturedMaterial(): Promise<THREE.Material> {
    if (!texRef.current) {
      const loader = new THREE.TextureLoader();
      const load = (f: string) => new Promise<THREE.Texture>((res) => loader.load(`${ASSET}/${f}`, (tx) => { tx.flipY = false; res(tx); }));
      const [base, mr, normal] = await Promise.all([
        load('brain_1_texture_pbr_20250901.png'),
        load('brain_2_texture_pbr_20250901_metallic_texture_pbr_20250901_roughness.png'),
        load('brain_0_texture_pbr_20250901_normal.png'),
      ]);
      (base as any).colorSpace = THREE.SRGBColorSpace;
      texRef.current = [base, mr, normal];
    }
    const [base, mr, normal] = texRef.current;
    return new THREE.MeshStandardMaterial({
      map: base, metalnessMap: mr, roughnessMap: mr, normalMap: normal,
      metalness: 0.5, roughness: 0.7, transparent: true, opacity: 0.9, side: THREE.FrontSide,
    });
  }
  async function applyShell(mode: ShellMode) {
    const mesh = shellRef.current; if (!mesh) return;
    if (mode === 'off') { mesh.visible = false; return; }
    mesh.visible = true;
    const old = mesh.material as THREE.Material;
    mesh.material = mode === 'textured' ? await texturedMaterial() : glassMaterial();
    if (old && old !== mesh.material) old.dispose();
  }
  useEffect(() => { applyShell(shell); /* eslint-disable-next-line */ }, [shell]);

  // ── incremental placement: keep existing neurons, place only new ones ─────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
      const fg = fgRef.current; if (!fg) return;
      const pts = await loadPointCloud(`${ASSET}/points.f32`);
      if (cancelled) return;
      if (!pickerRef.current) pickerRef.current = makePointPicker(pts);
      const picker = pickerRef.current;

      // compute the PCA basis ONCE so positions are stable across rebuilds
      if (!basisRef.current) {
        const emb = stableGraph.nodes.filter((n: any) => n.embedding?.length).map((n: any) => n.embedding);
        if (emb.length >= 4) basisRef.current = pcaBasis(emb);
      }
      const basis = basisRef.current;

      const present = new Set(stableGraph.nodes.map((n: any) => n.id));
      // release points of removed nodes (e.g. members folded into a cluster)
      for (const [id, idx] of [...idToIdxRef.current]) {
        if (!present.has(id)) { picker.release(idx); idToIdxRef.current.delete(id); baseRef.current.delete(id); }
      }

      // adjacency for placing new (esp. cluster) nodes near their neighbors
      const adj = new Map<string, string[]>();
      for (const l of stableGraph.links) {
        (adj.get(l.source) || adj.set(l.source, []).get(l.source)!).push(l.target);
        (adj.get(l.target) || adj.set(l.target, []).get(l.target)!).push(l.source);
      }
      const neighborAvg = (id: string): Vec3 | null => {
        const ns = (adj.get(id) || []).map((nid) => baseRef.current.get(nid)).filter(Boolean) as Vec3[];
        if (!ns.length) return null;
        const a = ns.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y, z: s.z + p.z }), { x: 0, y: 0, z: 0 });
        return { x: a.x / ns.length, y: a.y / ns.length, z: a.z / ns.length };
      };

      for (const n of stableGraph.nodes as any[]) {
        if (baseRef.current.has(n.id)) continue; // already placed → leave it put
        let seed: Vec3;
        if (n.embedding?.length && basis) seed = picker.fromNormalized(projectWithBasis(n.embedding, basis), 0.92);
        else seed = neighborAvg(n.id) || picker.bounds.ctr;
        const idx = picker.nearestFree(seed);
        const p = picker.point(idx);
        baseRef.current.set(n.id, p);
        idToIdxRef.current.set(n.id, idx);
      }

      // pin all current nodes to their base + rebuild the drift list
      const drift: typeof driftRef.current = [];
      stableGraph.nodes.forEach((n: any, i) => {
        const p = baseRef.current.get(n.id); if (!p) return;
        n.fx = n.x = p.x; n.fy = n.y = p.y; n.fz = n.z = p.z;
        drift.push({ n, bx: p.x, by: p.y, bz: p.z, ph: (i * 2.399) % (Math.PI * 2) });
      });
      driftRef.current = drift;

      fg.d3Force('charge', null as any);
      fg.d3Force('link', null as any);
      fg.d3Force('center', null as any);
      updateProximity();
      } catch (e) { console.error('[brain3d] placement failed', e); }
    })();
    return () => { cancelled = true; };
  }, [stableGraph]);

  // Which links pulse each wave — top-degree "hubs", but ADAPTIVE so it's never
  // empty (the old fixed ≥8 threshold went empty when clusters collapsed, which
  // is why pulses vanished on toggle). Falls back to all links for small graphs.
  useEffect(() => {
    const links = stableGraph.links;
    if (!links.length) { pulseLinksRef.current = []; return; }
    const deg = new Map<string, number>();
    for (const l of links) for (const id of [l.source, l.target]) deg.set(id, (deg.get(id) || 0) + 1);
    const ranked = [...deg.entries()].sort((a, b) => b[1] - a[1]);
    const hubCount = Math.max(1, Math.ceil(ranked.length * 0.15));
    const hubs = new Set(ranked.slice(0, hubCount).map(([id]) => id));
    let chosen = links.filter((l) => hubs.has(l.source) || hubs.has(l.target));
    if (!chosen.length) chosen = links;
    pulseLinksRef.current = chosen.map((l) => ({ s: l.source, t: l.target }));
  }, [stableGraph]);

  // ── neuron objects ────────────────────────────────────────────────────────
  // Each neuron is a clone of the loaded glTF mesh (shared geometry + one of three
  // shared material variants), given a deterministic random rotation and a 0.85–
  // 1.15 size jitter derived from its id (stable across rebuilds).
  // focused  → larger + emissive glow (the one you clicked)
  // member   → expanded-cluster sibling: SAME look, just half the size
  // normal   → full PBR look at its semantic size
  // dim      → faded (something else is focused)
  const nodeObject = useMemo(() => (node: any) => {
    const n = node as GNode;
    const focused = focusedId === n.id;
    const member = !focused && (highlightIds?.has(n.id) ?? false);
    const dim = (focusedId || (highlightIds && highlightIds.size)) && !focused && !member;
    // semantic radius: base + connection count, then focus/member emphasis
    const r = (NODE_BASE_R + Math.min(Math.cbrt(n.val || 1), 5) * 0.0016) * (focused ? 1.7 : member ? 0.5 : 1);

    const tpl = neuronTplRef.current;
    if (!tpl) {
      // mesh not loaded yet — placeholder dot so nodes aren't invisible
      return new THREE.Mesh(new THREE.SphereGeometry(r, 8, 8), new THREE.MeshBasicMaterial({ color: n.color || '#7fd4ff' }));
    }
    const mat = focused ? tpl.matFocused : dim ? tpl.matDim : tpl.matNormal;
    const m = new THREE.Mesh(tpl.geo, mat);
    m.rotation.set(hash01(n.id, 1) * TAU, hash01(n.id, 2) * TAU, hash01(n.id, 3) * TAU);
    const jitter = 0.85 + hash01(n.id, 4) * 0.30;   // per-neuron scale 0.85–1.15
    m.scale.setScalar((2 * r * jitter * NEURON_SIZE) / tpl.maxDim); // fit longest axis to old sphere diameter × size factor
    return m;
  }, [focusedId, highlightIds, neuronReady]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ForceGraph3D
        ref={fgRef as any}
        width={size.w}
        height={size.h}
        graphData={stableGraph as any}
        backgroundColor="#04060d"
        showNavInfo={false}
        controlType="orbit"
        nodeThreeObject={nodeObject as any}
        nodeLabel={(n: any) => (n.label || '') as string}
        linkColor={() => 'rgba(150,185,255,0.45)'}
        linkOpacity={0.45}
        linkWidth={0}
        enableNodeDrag={false}
        onNodeClick={(n: any) => onNodeClick?.(n.id)}
        onBackgroundClick={() => onBackground?.()}
        cooldownTime={Infinity}
      />
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 5, display: 'flex', gap: 8 }}>
        <Ctl onClick={() => setAutoRotate((v) => !v)} title="Toggle slow auto-rotate">{autoRotate ? '◐ Rotating' : '◯ Static'}</Ctl>
        <Ctl onClick={() => setShell((s) => SHELL_CYCLE[(SHELL_CYCLE.indexOf(s) + 1) % SHELL_CYCLE.length])} title="Cycle shell">Shell: {shell}</Ctl>
      </div>
    </div>
  );
}

function Ctl({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title} style={{
      background: 'rgba(12,16,28,0.8)', color: '#cfe3ff', border: '1px solid #2a3a6a',
      borderRadius: 10, padding: '7px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', backdropFilter: 'blur(6px)',
    }}>{children}</button>
  );
}
