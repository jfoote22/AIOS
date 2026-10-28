// Embeds a Hermes Agent web dashboard (hermes dashboard, default port 9119) in
// the Hermes tab. The renderer blocks iframes and <webview> (renderer-security),
// so the dashboard runs in a native WebContentsView laid over the tab's content
// area. It gets its own session partition, no preload and no IPC authority: it
// is just a sandboxed browser pinned to the one origin the user configured.

const { WebContentsView, shell, session } = require('electron');

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
