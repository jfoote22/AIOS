const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
(async () => {
  const root = path.resolve(__dirname, '..');
  const ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
  const binary = process.platform === 'win32' ? 'conpty.node' : 'pty.node';
  const prebuilt = fs.existsSync(path.join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, binary));
  const usePrebuilt = prebuilt && process.env.npm_config_build_from_source !== 'true';
  console.log(usePrebuilt ? 'Using bundled node-pty prebuild; verifying it under Electron.' : 'Building node-pty from source for this platform.');
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({ buildPath: root, electronVersion: require('electron/package.json').version,
    force: true, onlyModules: ['better-sqlite3', ...(usePrebuilt ? [] : ['node-pty'])] });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'test-native.cjs')], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native runtime verification failed; install the platform build tools and rebuild from source.');
})().catch(error => { console.error(error.message); process.exit(1); });
