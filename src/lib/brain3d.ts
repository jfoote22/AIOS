// Placement math for the 3D Second Brain: project neuron embeddings into the
// brain volume and bind each to an interior scaffold point.
//
// No Three.js here — just data prep. The renderer (BrainView3D) consumes this.

export interface Vec3 { x: number; y: number; z: number }

// Houdini exports this brain "lying down" relative to three's Y-up world, so we
// stand it upright with a -90° rotation about X. Applied to the point DATA here
// (so neurons pinned to the points rotate with it) and to the shell mesh OBJECT
// by the same angle in BrainView3D — keeping cloud, neurons, and shell aligned.
export const BRAIN_ROT_X = Math.PI / 2;

function rotateXInPlace(arr: Float32Array, theta: number) {
  const c = Math.cos(theta), s = Math.sin(theta);
  for (let i = 0; i < arr.length; i += 3) {
    const y = arr[i + 1], z = arr[i + 2];
    arr[i + 1] = y * c - z * s;
    arr[i + 2] = y * s + z * c;
  }
}

// ── load the interior scaffold point cloud (public/brain/points.f32) ─────────
let pointsCache: Float32Array | null = null;
export async function loadPointCloud(url = './brain/points.f32'): Promise<Float32Array> {
  if (pointsCache) return pointsCache;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load point cloud (${res.status})`);
  const buf = await res.arrayBuffer();
  const arr = new Float32Array(buf);
  rotateXInPlace(arr, BRAIN_ROT_X);
  pointsCache = arr;
  return pointsCache;
}

// ── PCA → 3D ──────────────────────────────────────────────────────────────
// Project N D-dim embeddings onto their 3 principal axes so semantically
// similar neurons land near each other. Power iteration with deflation — no
// matrix library needed, and N is small (hundreds–thousands of neurons).

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function topComponent(rows: number[][], dim: number, exclude: number[][]): number[] {
  // Deterministic seed (avoid Math.random for reproducible layouts).
  let v = new Array(dim).fill(0).map((_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1 || 0.01);
  const norm = (x: number[]) => { const n = Math.hypot(...x) || 1; return x.map((c) => c / n); };
  v = norm(v);
  for (let iter = 0; iter < 24; iter++) {
    const next = new Array(dim).fill(0);
    for (const r of rows) {
      const p = dot(r, v);
      for (let i = 0; i < dim; i++) next[i] += r[i] * p;
    }
    // Deflate already-found components so we get orthogonal axes.
    for (const e of exclude) {
      const p = dot(next, e);
      for (let i = 0; i < dim; i++) next[i] -= p * e[i];
    }
    v = norm(next);
  }
  return v;
}

/** Returns an array of {x,y,z} seeds (centered, unit-ish scale) for each row. */
export function pca3(embeddings: number[][]): Vec3[] {
  const n = embeddings.length;
  if (!n) return [];
  const dim = embeddings[0].length;
  // Center.
  const mean = new Array(dim).fill(0);
  for (const e of embeddings) for (let i = 0; i < dim; i++) mean[i] += e[i] / n;
  const rows = embeddings.map((e) => e.map((c, i) => c - mean[i]));
  const c1 = topComponent(rows, dim, []);
  const c2 = topComponent(rows, dim, [c1]);
  const c3 = topComponent(rows, dim, [c1, c2]);
  const seeds = rows.map((r) => ({ x: dot(r, c1), y: dot(r, c2), z: dot(r, c3) }));
  // Normalize each axis to [-1, 1] by its max abs so the cloud fills the volume.
  const m = { x: 1e-6, y: 1e-6, z: 1e-6 };
  for (const s of seeds) { m.x = Math.max(m.x, Math.abs(s.x)); m.y = Math.max(m.y, Math.abs(s.y)); m.z = Math.max(m.z, Math.abs(s.z)); }
  return seeds.map((s) => ({ x: s.x / m.x, y: s.y / m.y, z: s.z / m.z }));
}

// ── nearest interior point (voxel grid for speed) ────────────────────────────

interface Grid { cell: number; map: Map<string, number[]>; min: Vec3 }

function pointBounds(points: Float32Array): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < points.length; i += 3) {
    min.x = Math.min(min.x, points[i]); max.x = Math.max(max.x, points[i]);
    min.y = Math.min(min.y, points[i + 1]); max.y = Math.max(max.y, points[i + 1]);
    min.z = Math.min(min.z, points[i + 2]); max.z = Math.max(max.z, points[i + 2]);
  }
  return { min, max };
}
export function cloudBounds(points: Float32Array) { return pointBounds(points); }

function buildGrid(points: Float32Array, cell: number): Grid {
  const { min } = pointBounds(points);
  const map = new Map<string, number[]>();
  for (let i = 0; i < points.length; i += 3) {
    const gx = Math.floor((points[i] - min.x) / cell);
    const gy = Math.floor((points[i + 1] - min.y) / cell);
    const gz = Math.floor((points[i + 2] - min.z) / cell);
    const k = `${gx},${gy},${gz}`;
    (map.get(k) || map.set(k, []).get(k)!).push(i / 3);
  }
  return { cell, map, min };
}

/**
 * Bind each neuron seed to the nearest *unused* interior point (so neurons don't
 * stack). Returns the chosen point index per seed, in seed order.
 */
export function assignToPoints(seeds: Vec3[], points: Float32Array, scale: Vec3): number[] {
  // Map normalized seeds ([-1,1]) into the cloud's bounding box.
  const { min, max } = pointBounds(points);
  const span = { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2, z: (max.z - min.z) / 2 };
  const ctr = { x: (max.x + min.x) / 2, y: (max.y + min.y) / 2, z: (max.z + min.z) / 2 };
  const target = seeds.map((s) => ({
    x: ctr.x + s.x * span.x * scale.x,
    y: ctr.y + s.y * span.y * scale.y,
    z: ctr.z + s.z * span.z * scale.z,
  }));

  const cell = Math.max(span.x, span.y, span.z) / 16 || 0.05;
  const grid = buildGrid(points, cell);
  const used = new Set<number>();
  const result: number[] = [];

  for (const t of target) {
    const gx = Math.floor((t.x - grid.min.x) / cell);
    const gy = Math.floor((t.y - grid.min.y) / cell);
    const gz = Math.floor((t.z - grid.min.z) / cell);
    let best = -1, bestD = Infinity;
    for (let ring = 0; ring < 6 && best < 0; ring++) {
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++)
          for (let dz = -ring; dz <= ring; dz++) {
            if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
            const arr = grid.map.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!arr) continue;
            for (const idx of arr) {
              if (used.has(idx)) continue;
              const px = points[idx * 3], py = points[idx * 3 + 1], pz = points[idx * 3 + 2];
              const d = (px - t.x) ** 2 + (py - t.y) ** 2 + (pz - t.z) ** 2;
              if (d < bestD) { bestD = d; best = idx; }
            }
          }
    }
    if (best < 0) best = 0; // fallback (shouldn't happen with 100k points)
    used.add(best);
    result.push(best);
  }
  return result;
}

/** Read a point's coordinates by index. */
export function pointAt(points: Float32Array, idx: number): Vec3 {
  return { x: points[idx * 3], y: points[idx * 3 + 1], z: points[idx * 3 + 2] };
}

// ── stable PCA basis (computed ONCE, reused) so placement never reshuffles ────
export interface Basis { mean: number[]; comps: number[][]; scale: Vec3 }

export function pcaBasis(embeddings: number[][]): Basis | null {
  const n = embeddings.length;
  if (!n) return null;
  const dim = embeddings[0].length;
  const mean = new Array(dim).fill(0);
  for (const e of embeddings) for (let i = 0; i < dim; i++) mean[i] += e[i] / n;
  const rows = embeddings.map((e) => e.map((c, i) => c - mean[i]));
  const c1 = topComponent(rows, dim, []);
  const c2 = topComponent(rows, dim, [c1]);
  const c3 = topComponent(rows, dim, [c1, c2]);
  const scale = { x: 1e-6, y: 1e-6, z: 1e-6 };
  for (const r of rows) {
    scale.x = Math.max(scale.x, Math.abs(dot(r, c1)));
    scale.y = Math.max(scale.y, Math.abs(dot(r, c2)));
    scale.z = Math.max(scale.z, Math.abs(dot(r, c3)));
  }
  return { mean, comps: [c1, c2, c3], scale };
}

/** Project one embedding through a cached basis → normalized [-1,1] seed. */
export function projectWithBasis(emb: number[], b: Basis): Vec3 {
  const r = emb.map((c, i) => c - b.mean[i]);
  return { x: dot(r, b.comps[0]) / b.scale.x, y: dot(r, b.comps[1]) / b.scale.y, z: dot(r, b.comps[2]) / b.scale.z };
}

// ── incremental point picker: assign nearest FREE interior point, releasable ──
export interface PointPicker {
  bounds: { ctr: Vec3; span: Vec3 };
  fromNormalized(nv: Vec3, scale: number): Vec3;
  nearestFree(target: Vec3): number;
  release(idx: number): void;
  point(idx: number): Vec3;
}

export function makePointPicker(points: Float32Array): PointPicker {
  const { min, max } = pointBounds(points);
  const span = { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2, z: (max.z - min.z) / 2 };
  const ctr = { x: (max.x + min.x) / 2, y: (max.y + min.y) / 2, z: (max.z + min.z) / 2 };
  const cell = Math.max(span.x, span.y, span.z) / 16 || 0.05;
  const grid = buildGrid(points, cell);
  const used = new Set<number>();
  return {
    bounds: { ctr, span },
    fromNormalized: (nv, scale) => ({ x: ctr.x + nv.x * span.x * scale, y: ctr.y + nv.y * span.y * scale, z: ctr.z + nv.z * span.z * scale }),
    point: (idx) => pointAt(points, idx),
    release: (idx) => { used.delete(idx); },
    nearestFree(target) {
      const gx = Math.floor((target.x - grid.min.x) / cell);
      const gy = Math.floor((target.y - grid.min.y) / cell);
      const gz = Math.floor((target.z - grid.min.z) / cell);
      let best = -1, bestD = Infinity;
      for (let ring = 0; ring < 8 && best < 0; ring++) {
        for (let dx = -ring; dx <= ring; dx++)
          for (let dy = -ring; dy <= ring; dy++)
            for (let dz = -ring; dz <= ring; dz++) {
              if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
              const arr = grid.map.get(`${gx + dx},${gy + dy},${gz + dz}`);
              if (!arr) continue;
              for (const idx of arr) {
                if (used.has(idx)) continue;
                const px = points[idx * 3], py = points[idx * 3 + 1], pz = points[idx * 3 + 2];
                const d = (px - target.x) ** 2 + (py - target.y) ** 2 + (pz - target.z) ** 2;
                if (d < bestD) { bestD = d; best = idx; }
              }
            }
      }
      if (best < 0) best = 0;
      used.add(best);
      return best;
    },
  };
}
