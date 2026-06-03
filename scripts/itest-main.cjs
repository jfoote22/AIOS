// Integration test harness: launches real Electron with a hidden window using
// the actual electron/preload.cjs, then drives the SQLite bridge end-to-end
// from a renderer (including a simulated IndexedDB→SQLite migration).
//
//   ELECTRON_DISABLE_SECURITY_WARNINGS=1 electron scripts/itest-main.cjs
//
// Exits 0 if all renderer assertions pass, 1 otherwise.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqliteStore = require('../electron/sqlite-store.cjs');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-itest-'));
  sqliteStore.init(path.join(dir, 'aios.db'));
  // Same one line as electron/main.cjs:
  ipcMain.handle('aios:db', (_e, op, args) => sqliteStore.call(op, args));

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  let code = 1;
  try {
    await win.loadFile(path.join(__dirname, 'itest-renderer.html'));
    const result = await win.webContents.executeJavaScript('window.runTest()');
    console.log(result.log.join('\n'));
    console.log('');
    console.log(result.ok ? 'INTEGRATION_TEST_PASSED' : `INTEGRATION_TEST_FAILED (${result.failures})`);
    code = result.ok ? 0 : 1;
  } catch (e) {
    console.error('INTEGRATION_TEST_ERROR:', e && e.message ? e.message : e);
    code = 1;
  } finally {
    win.destroy();
    app.exit(code);
  }
});
