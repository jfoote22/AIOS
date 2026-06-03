// Headless smoke test: prove better-sqlite3 loads + works under whatever
// Node ABI is running this script. Run under Electron's bundled Node via
// ELECTRON_RUN_AS_NODE=1 to validate against the Electron ABI.
try {
  console.log('runtime node:', process.versions.node, 'modules(ABI):', process.versions.modules, 'electron:', process.versions.electron || '(plain node)');
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, blob BLOB)');
  const buf = Buffer.from(new Float32Array([1.5, -2.5, 3.25]).buffer);
  db.prepare('INSERT INTO t (v, blob) VALUES (?, ?)').run('hello', buf);
  const row = db.prepare('SELECT v, blob FROM t WHERE id = 1').get();
  const back = new Float32Array(row.blob.buffer, row.blob.byteOffset, row.blob.byteLength / 4);
  console.log('OK: read back v=', row.v, 'floats=', Array.from(back));
  db.close();
  console.log('SMOKE_TEST_PASSED');
  process.exit(0);
} catch (e) {
  console.error('SMOKE_TEST_FAILED:', e && e.message ? e.message : e);
  process.exit(1);
}
