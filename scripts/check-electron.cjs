const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let checked = 0;
for (const directory of ['electron', 'scripts']) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.cjs')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(directory, entry.name)], {
      stdio: 'inherit', windowsHide: true,
    });
    if (result.error) console.error(result.error);
    if (result.status !== 0) process.exit(result.status ?? 1);
    checked++;
  }
}
console.log(`Syntax checked ${checked} Electron/test CommonJS files.`);
