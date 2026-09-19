// Real Electron + Chromium test. Uses only an isolated temporary profile/DB,
// no cloud requests or user credentials. Windows stay hidden.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { ipcMain, protectWindow, installApiTransport } = require('../electron/renderer-security.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-security-smoke-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => { console.error('Electron smoke timed out.'); app.exit(1); }, 45000);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') return Promise.reject(new Error('External networking disabled in smoke tests.'));
  return originalFetch(input, options);
};

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' });
    },
  );
  const store = require('../electron/sqlite-store.cjs');
  store.init(path.join(profile, 'test.db'));
  const { server, port } = await require('../electron/api-server.cjs').start();
  installApiTransport(port);
  ipcMain.handle('app:get-api-port', () => port);
  ipcMain.handle('keys:list', () => []);
  ipcMain.handle('models:get-all', () => ({}));
  ipcMain.handle('models:defaults', () => ({}));
  ipcMain.handle('memory:get-config', () => ({ enabled: false, running: false }));
  ipcMain.handle('mobile:get-config', () => ({ enabled: false, running: false }));
  ipcMain.handle('aios:db', (_e, op, args) => store.call(op, args));
  ipcMain.handle('keys:available', () => false);
  ipcMain.handle('term:available', () => ({ available: false }));
  const makeWindow = () => new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  const win = makeWindow();
  protectWindow(win);
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("#root").childElementCount > 0'), true);
  assert.equal(await win.webContents.executeJavaScript('window.aios.getApiPort()'), port);
  assert.equal(await win.webContents.executeJavaScript('typeof window.aios.getProviderKey'), 'undefined');
  assert.equal(await win.webContents.executeJavaScript(`fetch('http://127.0.0.1:${port}/api/health').then(r => r.status)`), 200);
  // JSON POST requires a Chromium CORS preflight: exercise it, not just GET.
  const postStatus = await win.webContents.executeJavaScript(`fetch('http://127.0.0.1:${port}/api/gemini/generate', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
  }).then(r => r.status)`);
  assert.equal(postStatus, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 401);

  // Exercise the actual gateway with an in-memory test credential provider.
  // Do not require a desktop keyring on headless Linux CI or touch real keys.
  const keyModule = require.cache[require.resolve('../electron/keystore.cjs')];
  const originalKeys = keyModule.exports;
  const keys = new Map([['mobile_gateway_token', 'test-mobile-token']]);
  keyModule.exports = {
    getProviderKey: id => keys.get(id) || '',
    setProviderKey: (id, value) => keys.set(id, value),
  };
  const gateway = require('../electron/mobile-gateway.cjs');
  keyModule.exports = originalKeys;
  gateway.setApiPort(port);
  const mobileServer = await new Promise(resolve => {
    const listener = gateway.buildApp().listen(0, '127.0.0.1', () => resolve(listener));
  });
  const mobileBase = `http://127.0.0.1:${mobileServer.address().port}`;
  const mobileHeaders = { Authorization: 'Bearer test-mobile-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${mobileBase}/api/mobile/ping?token=test-mobile-token`)).status, 401);
  assert.equal((await fetch(`${mobileBase}/api/mobile/ping`, { headers: mobileHeaders })).status, 200);
  assert.equal((await fetch(`${mobileBase}/api/mobile/term/spawn`, { method: 'POST', headers: mobileHeaders, body: '{}' })).status, 403);
  for (const route of ['agents/run', 'agents/write-md', 'deepgram', 'hermes/config', 'project/load']) {
    assert.equal((await fetch(`${mobileBase}/api/proxy/${route}`, { method: 'POST', headers: mobileHeaders, body: '{}' })).status, 403, route);
  }
  const drafted = await fetch(`${mobileBase}/api/proxy/research/find-links`, { method: 'POST', headers: mobileHeaders, body: '{}' });
  assert.equal(drafted.status, 400); // input validation, NOT loopback auth failure
  gateway.regenerateToken();
  assert.equal((await fetch(`${mobileBase}/api/mobile/ping`, { headers: mobileHeaders })).status, 401);
  gateway.stop();
  await new Promise(resolve => { mobileServer.close(resolve); mobileServer.closeAllConnections(); });

  const untrusted = makeWindow();
  await untrusted.loadURL('about:blank');
  assert.equal(await untrusted.webContents.executeJavaScript("window.aios.getApiPort().then(() => 'allowed', () => 'denied')"), 'denied');
  assert.equal(await untrusted.webContents.executeJavaScript(`fetch('http://127.0.0.1:${port}/api/health').then(() => 'allowed', () => 'denied')`), 'denied');
  // Navigation away revokes IPC even for a previously registered window.
  await win.loadURL('about:blank');
  assert.equal(await win.webContents.executeJavaScript("window.aios.getApiPort().then(() => 'allowed', () => 'denied')"), 'denied');
  win.destroy(); untrusted.destroy();
  const keystoreFile = path.join(profile, 'provider-keys.json');
  if (originalKeys.isSecureStorageAvailable()) {
    originalKeys.setProviderKey('gemini', 'synthetic-smoke-credential');
    assert.equal(originalKeys.getProviderKey('gemini'), 'synthetic-smoke-credential');
    assert.equal(fs.readFileSync(keystoreFile, 'utf8').includes('synthetic-smoke-credential'), false);
  }
  // Corruption must preserve the file and block saves, without crashing reads
  // during startup. This is a fixture in the temporary test profile only.
  fs.writeFileSync(keystoreFile, '{malformed-fixture');
  assert.deepEqual(originalKeys.listConfiguredProviders(), []);
  assert.throws(() => originalKeys.setProviderKey('gemini', 'replacement'), /Cannot read/);
  assert.equal(fs.readFileSync(keystoreFile, 'utf8'), '{malformed-fixture');
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  clearTimeout(timeout);
  console.log('PASS: Chromium API/CORS, sandboxed preload, untrusted/navigated IPC, mobile proxy allowlist, terminal default-deny, token rotation, and credential-file preservation.');
  console.log(`Isolated test profile retained at ${profile}`);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
