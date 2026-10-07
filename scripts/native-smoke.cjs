// Run with Electron's Node runtime; only an in-memory DB and a fixed echo command.
const assert = require('node:assert/strict');
const path = require('node:path');
assert.ok(process.versions.electron, 'Native checks must use Electron, not system Node.');
const Database = require('better-sqlite3');
const database = new Database(':memory:');
assert.equal(database.prepare('SELECT 42 AS value').get().value, 42);
database.close();
const windows = process.platform === 'win32';
const shell = windows ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : '/bin/sh';
const args = windows ? ['/d', '/c', 'echo AIOS_NATIVE_PTY_OK'] : ['-c', 'echo AIOS_NATIVE_PTY_OK'];
const terminal = require('node-pty').spawn(shell, args, { cols: 80, rows: 24, env: process.env });
let output = '';
const timer = setTimeout(() => { terminal.kill(); console.error('Native PTY smoke timed out.'); process.exit(1); }, 10000);
terminal.onData(data => { output += data; });
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  assert.equal(exitCode, 0);
  assert.ok(output.includes('AIOS_NATIVE_PTY_OK'), 'PTY did not deliver the expected output.');
  console.log(`PASS: SQLite and PTY on Electron ${process.versions.electron} (${process.platform}/${process.arch}).`);
  // ConPTY can retain background handles after exit; this standalone probe is done.
  process.exit(0);
});
