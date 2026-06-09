// One-time (idempotent) prep of the 3D brain assets for the renderer.
//
//  assets/brain_points/brainPoints.csv  ->  public/brain/points.f32   (raw Float32 LE, x,y,z…)
//  assets/brain_mesh/brainMesh (+ .bin + 3 PNGs)  ->  public/brain/   (web-loadable GLTF)
//
// The renderer fetches these from ./brain/* (Vite serves public/ at the root,
// and base:'./' keeps the paths valid in the packaged Electron app).
//
// Run: node scripts/prep-brain-assets.cjs

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'brain');
fs.mkdirSync(OUT, { recursive: true });

// ── points: CSV -> Float32 binary ────────────────────────────────────────────
function prepPoints() {
  const csv = path.join(ROOT, 'assets', 'brain_points', 'brainPoints.csv');
  if (!fs.existsSync(csv)) { console.warn('! points CSV not found:', csv); return; }
  const lines = fs.readFileSync(csv, 'utf8').split(/\r?\n/);
  const start = /[a-z]/i.test(lines[0]) ? 1 : 0; // skip header row
  const coords = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const p = l.split(/[,\s]+/).map(Number);
    if (p.length < 3) continue;
    const [x, y, z] = p;
    // drop any non-finite / absurd rows defensively
    if (![x, y, z].every((v) => Number.isFinite(v) && Math.abs(v) < 100)) continue;
    coords.push(x, y, z);
  }
  const f32 = Float32Array.from(coords);
  fs.writeFileSync(path.join(OUT, 'points.f32'), Buffer.from(f32.buffer));
  console.log(`✓ points.f32: ${coords.length / 3} points`);
}

// ── mesh: copy GLTF + buffer + textures with clean names ─────────────────────
function prepMesh() {
  const src = path.join(ROOT, 'assets', 'brain_mesh');
  if (!fs.existsSync(path.join(src, 'brainMesh'))) { console.warn('! mesh not found in', src); return; }
  // The GLTF's buffer/image URIs are already the sibling filenames, so a straight
  // copy keeps them resolvable. We just give the main JSON a .gltf extension.
  const copy = (from, to) => fs.copyFileSync(path.join(src, from), path.join(OUT, to));
  copy('brainMesh', 'brainMesh.gltf');
  copy('brainMesh_data.bin', 'brainMesh_data.bin');
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith('.png')) copy(f, f);
  }
  console.log('✓ brainMesh.gltf + buffer + textures copied');
}

prepPoints();
prepMesh();
console.log('Done. Assets in public/brain/');
