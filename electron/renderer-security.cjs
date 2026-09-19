const { ipcMain: rawIpc, session, shell } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { localAuthHeaders } = require('./http-security.cjs');

const trusted = new Map();
const overlayChannels = new Set(['overlay:get-source', 'overlay:submit', 'overlay:cancel']);

function documentUrl(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function trustedFrame(webContentsId, frame, role) {
  try {
    const record = trusted.get(webContentsId);
    return !!record && record.role === role && !!frame && frame.parent === null &&
      documentUrl(frame.url) === record.url;
  } catch { return false; } // A frame may disappear during navigation/close.
}

function allowedSender(event, channel) {
  return trustedFrame(event.sender.id, event.senderFrame,
    overlayChannels.has(channel) ? 'overlay' : 'desktop');
}

// Register before loading the document. Only this exact document's top frame
// receives IPC authority; popups, iframes, and navigated pages never inherit it.
function protectWindow(win, { role = 'desktop', development = false } = {}) {
  const url = role === 'overlay'
    ? pathToFileURL(path.join(__dirname, 'overlay.html')).href
    : development ? 'http://localhost:3000/'
      : pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
  const wc = win.webContents;
  trusted.set(wc.id, { url, role });
  wc.once('destroyed', () => trusted.delete(wc.id));
  wc.setWindowOpenHandler(({ url: target }) => {
    try {
      const external = new URL(target);
      if (role === 'desktop' && documentUrl(wc.getURL()) === url &&
          ['https:', 'http:'].includes(external.protocol) && !external.username && !external.password) {
        shell.openExternal(external.href).catch(() => {});
      }
    } catch { /* Invalid/privileged protocols are never opened. */ }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, target) => {
    if (documentUrl(target) !== url) event.preventDefault();
  });
  wc.on('will-redirect', (event) => event.preventDefault());
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || documentUrl(event.url) !== url) event.preventDefault();
  });
}

function installApiTransport(port) {
  const apiOrigin = `http://127.0.0.1:${port}`;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${apiOrigin}/*`] }, (details, callback) => {
      if (new URL(details.url).origin !== apiOrigin ||
          !trustedFrame(details.webContentsId, details.frame, 'desktop') ||
          details.resourceType !== 'xhr') return callback({ cancel: true });
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'authorization') delete headers[name];
      }
      callback({ requestHeaders: { ...headers, ...localAuthHeaders() } });
    },
  );
}

const ipcMain = {
  handle(channel, listener) {
    rawIpc.handle(channel, (event, ...args) => {
      if (!allowedSender(event, channel)) throw new Error('Untrusted IPC sender.');
      return listener(event, ...args);
    });
  },
  on(channel, listener) {
    rawIpc.on(channel, (event, ...args) => {
      if (allowedSender(event, channel)) listener(event, ...args);
    });
  },
};

module.exports = { ipcMain, protectWindow, installApiTransport };
