const { spawnSync } = require('node:child_process');
const electron = require('electron');
const result = spawnSync(electron, ['scripts/sqlite-store-test.cjs'], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
