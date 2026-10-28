// Real Electron test for the embedded Hermes dashboard view
// (electron/hermes-view.cjs). A local stand-in server plays the dashboard; no
// Hermes install or network access is needed. Windows stay hidden.
const { app, BrowserWindow, session, shell } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-hermes-view-smoke-')));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => { console.error('Hermes view smoke timed out.'); app.exit(1); }, 60000);

const opened = [];
shell.openExternal = async (url) => { opened.push(url); };

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
  });
}

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Condition not met in time.');
};

app.whenReady().then(async () => {
  const hermesView = require('../electron/hermes-view.cjs');
  const dashboard = await listen((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    // Real Hermes responses forbid framing; a top-level view must not care.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(`<title>hermes-stand-in</title><a id="out" href="http://localhost:1/elsewhere">x</a>${req.url}`);
  });
  const base = `http://127.0.0.1:${dashboard.address().port}`;

  const win = new BrowserWindow({ show: false, width: 1000, height: 700 });
  await win.loadURL('about:blank');
  hermesView.attach(win);

  // Loads despite X-Frame-Options/frame-ancestors, at the requested bounds.
  const shown = await hermesView.show(`${base}/chat`, { x: 240, y: 64, width: 700, height: 500 });
  assert.equal(shown.ok, true, shown.error);
  const [view] = win.contentView.children;
  assert.ok(view, 'view attached to the window');
  assert.equal(view.webContents.getTitle(), 'hermes-stand-in');
  assert.deepEqual(view.getBounds(), { x: 240, y: 64, width: 700, height: 500 });

  // Bounds follow the host window's zoom (CSS px → DIP).
  win.webContents.setZoomFactor(1.25);
  hermesView.setBounds({ x: 100, y: 40, width: 400, height: 300 });
  assert.deepEqual(view.getBounds(), { x: 125, y: 50, width: 500, height: 375 });
  win.webContents.setZoomFactor(1);

  // Isolated: own partition, no preload bridge, no Node.
  assert.notEqual(view.webContents.session, session.defaultSession);
  assert.equal(await view.webContents.executeJavaScript('typeof window.aios'), 'undefined');
  assert.equal(await view.webContents.executeJavaScript('typeof require'), 'undefined');

  // Permissions are refused.
  const perm = await view.webContents.executeJavaScript(
    "navigator.permissions.query({ name: 'notifications' }).then(p => p.state)");
  assert.notEqual(perm, 'granted');

  // Leaving the dashboard's origin goes to the system browser, not the view.
  await view.webContents.executeJavaScript("document.getElementById('out').click()");
  await until(() => opened.length === 1);
  assert.equal(opened[0], 'http://localhost:1/elsewhere');
  assert.equal(new URL(view.webContents.getURL()).origin, base);
  // window.open likewise.
  await view.webContents.executeJavaScript("window.open('https://example.com/x'); 1");
  await until(() => opened.length === 2);
  assert.equal(opened[1], 'https://example.com/x');

  // Rejects non-http(s) and credentialed URLs.
  await assert.rejects(hermesView.show('file:///C:/Windows/win.ini', { x: 0, y: 0, width: 1, height: 1 }));
  await assert.rejects(hermesView.show('http://u:p@127.0.0.1:9/', { x: 0, y: 0, width: 1, height: 1 }));

  // A dashboard that isn't running reports an error, and a later show retries.
  const closed = await listen(() => {});
  const deadPort = closed.address().port;
  await new Promise(r => closed.close(r));
  const dead = await hermesView.show(`http://127.0.0.1:${deadPort}/`, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(dead.ok, false);
  const back = await hermesView.show(`${base}/`, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(back.ok, true, back.error);

  // Saved dashboard login: the Hermes login page is filled in automatically,
  // once — a rejected password doesn't loop.
  const logins = [];
  const authed = await listen((req, res) => {
    const cookie = /session=ok/.test(req.headers.cookie || '');
    if (req.method === 'POST' && req.url === '/auth/password-login') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const j = JSON.parse(body);
        logins.push(j);
        if (j.provider !== 'basic' || j.username !== 'justin' || j.password !== 'pw"1') { res.statusCode = 401; return res.end('{}'); }
        res.setHeader('Set-Cookie', 'session=ok; Path=/; HttpOnly');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, next: '/chat' }));
      });
      return;
    }
    if (req.url.startsWith('/login')) { res.setHeader('Content-Type', 'text/html'); return res.end('<title>login</title>'); }
    if (!cookie) { res.statusCode = 302; res.setHeader('Location', '/login?next=%2Fchat'); return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>signed-in</title>');
  });
  const authedBase = `http://127.0.0.1:${authed.address().port}`;
  const { setProviderKey } = require('../electron/keystore.cjs');
  setProviderKey('hermes_dashboard_user', 'justin');
  setProviderKey('hermes_dashboard_password', 'wrong');
  await hermesView.show(`${authedBase}/`, { x: 0, y: 0, width: 10, height: 10 });
  await until(() => logins.length === 1);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(logins.length, 1, 'a rejected login is not retried');
  assert.equal(view.webContents.getTitle(), 'login');
  setProviderKey('hermes_dashboard_password', 'pw"1');
  view.webContents.reload();
  await until(() => view.webContents.getTitle() === 'signed-in', 8000);
  assert.deepEqual(logins[1], { provider: 'basic', username: 'justin', password: 'pw"1', next: '/chat' });
  authed.close();

  hermesView.hide();
  assert.equal(view.getVisible(), false);

  console.log('HERMES_VIEW_SMOKE_PASSED');
  clearTimeout(timeout);
  dashboard.close();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
