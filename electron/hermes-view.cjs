// Embeds a Hermes Agent web dashboard (hermes dashboard, default port 9119) in
// the Hermes tab. The renderer blocks iframes and <webview> (renderer-security),
// so the dashboard runs in a native WebContentsView laid over the tab's content
// area. It gets its own session partition, no preload and no IPC authority: it
// is just a sandboxed browser pinned to the one origin the user configured.

const { WebContentsView, shell, session } = require('electron');
const { getProviderKey } = require('./keystore.cjs');

const PARTITION = 'persist:hermes-dashboard';

let host = null;     // BrowserWindow the view is attached to
let view = null;
let origin = '';     // origin the view is pinned to
let sessionReady = false;

function dashboardUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Dashboard URL must be http(s) without credentials.');
  }
  return url;
}

function prepareSession() {
  if (sessionReady) return;
  sessionReady = true;
  // The dashboard asks for nothing AIOS should grant on its behalf (camera,
  // mic, notifications, ...). Deny everything; Hermes still works without it.
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function openOutside(target) {
  try {
    const url = new URL(target);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      shell.openExternal(url.href).catch(() => {});
    }
  } catch { /* not a URL — ignore */ }
}

// Sign in with the dashboard login saved in Settings → Hermes (encrypted in
// the keystore) when Hermes shows its login page: the same request its own
// form makes, run inside the page so Hermes sets its session cookie normally.
// One try per saved login while on the login page, so a wrong password
// can't loop; saving a new one tries again.
const LOGIN_SCRIPT = `(async (username, password) => {
  const prefix = location.pathname.replace(/[/]login[/]?$/, '');
  const next = new URLSearchParams(location.search).get('next') || '';
  const res = await fetch(prefix + '/auth/password-login', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'basic', username, password, next }),
  });
  if (!res.ok) return res.status;
  const data = await res.json().catch(() => ({}));
  location.href = data.next || prefix + '/';
  return 200;
})`;

let triedLogin = ''; // the login last tried while on the login page
function autoLogin(wc) {
  let url;
  try { url = new URL(wc.getURL()); } catch { return; }
  if (!/\/login\/?$/.test(url.pathname)) { triedLogin = ''; return; }
  if (url.origin !== origin) return;
  const username = getProviderKey('hermes_dashboard_user');
  const password = getProviderKey('hermes_dashboard_password');
  if (!username || !password) return;
  const attempt = JSON.stringify([username, password]);
  if (triedLogin === attempt) return;
  triedLogin = attempt;
  wc.executeJavaScript(`${LOGIN_SCRIPT}(${JSON.stringify(username)}, ${JSON.stringify(password)})`)
    .then((status) => { if (status !== 200) console.warn(`[hermes-view] saved dashboard login was rejected (HTTP ${status})`); })
    .catch(() => {});
}

function createView() {
  prepareSession();
  const next = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  next.setBackgroundColor('#09090b');
  const wc = next.webContents;
  // Stay on the configured origin; anything else opens in the system browser.
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  wc.on('will-navigate', (event, target) => {
    let same = false;
    try { same = new URL(target).origin === origin; } catch {}
    if (!same) { event.preventDefault(); openOutside(target); }
  });
  wc.on('will-redirect', (event, target) => {
    let same = false;
    try { same = new URL(target).origin === origin; } catch {}
    if (!same) event.preventDefault();
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('did-finish-load', () => autoLogin(wc));
  return next;
}

function scaledBounds(bounds) {
  // The renderer measures in CSS pixels; the view is placed in window DIPs.
  // They differ by the main window's zoom (View → Zoom In/Out).
  const zoom = host && !host.isDestroyed() ? host.webContents.getZoomFactor() : 1;
  const n = (v) => Math.max(0, Math.round((Number(v) || 0) * zoom));
  return { x: n(bounds?.x), y: n(bounds?.y), width: n(bounds?.width), height: n(bounds?.height) };
}

function attach(win) {
  host = win;
  win.once('closed', () => { host = null; view = null; origin = ''; });
}

async function show(url, bounds) {
  if (!host || host.isDestroyed()) throw new Error('No window to attach the dashboard to.');
  const target = dashboardUrl(url);
  if (!view) {
    view = createView();
    host.contentView.addChildView(view);
  }
  view.setBounds(scaledBounds(bounds));
  view.setVisible(true);
  if (target.origin !== origin) {
    origin = target.origin;
    // A load failure (dashboard not running) is reported to the renderer.
    // Forget the origin on failure so the next show() retries the load.
    try { await view.webContents.loadURL(target.href); }
    catch (e) { origin = ''; return { ok: false, error: e?.message || 'Could not load the dashboard.' }; }
  }
  return { ok: true, url: view.webContents.getURL() };
}

function setBounds(bounds) {
  if (view) view.setBounds(scaledBounds(bounds));
}

function hide() {
  if (view) view.setVisible(false);
}

function reload() {
  if (view) view.webContents.reload();
}

module.exports = { attach, show, setBounds, hide, reload };
