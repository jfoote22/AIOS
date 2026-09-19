const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(require('electron'), [path.join(__dirname, 'native-smoke.cjs')], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20000,
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
