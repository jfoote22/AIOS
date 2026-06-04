const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, desktopCapturer, ipcMain, screen, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { getProviderKey, setProviderKey, listConfiguredProviders } = require('./keystore.cjs');
const modelstore = require('./modelstore.cjs');
const apiServer = require('./api-server.cjs');
const terminal = require('./terminal.cjs');
const reportExport = require('./report-export.cjs');
const sqliteStore = require('./sqlite-store.cjs');

// Keep the renderer fully alive when the main window is minimized during a
// capture. "Add Shot" minimizes the window (so AIOS stays out of the shot),
// which otherwise lets Chromium freeze/deprioritize the occluded renderer and
// suspend the in-flight OCR until the window is shown again — the exact cause
// of shots stuck on "Analyzing…" that only complete when the next capture
// restores the window. These switches (set before app ready) prevent that;
// backgroundThrottling:false alone only covers timer throttling, not freezing.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// --- Legacy single-key compatibility (Gemini) ---
function migrateLegacyKey() {
  try {
    const legacy = path.join(app.getPath('userData'), 'gemini-key.bin');
    if (!fs.existsSync(legacy)) return;
    if (!safeStorage.isEncryptionAvailable()) return;
    const buf = fs.readFileSync(legacy);
    const decoded = safeStorage.decryptString(buf);
    if (decoded && !listConfiguredProviders().includes('gemini')) {
      setProviderKey('gemini', decoded);
    }
    fs.unlinkSync(legacy);
  } catch (e) {
    console.error('Legacy key migration failed:', e);
  }
}

const isDev = !app.isPackaged;
let mainWindow = null;
let overlayWindow = null;
let tray = null;
let pendingCaptureTargetId = null;
let pendingRegionResolve = null; // resolver for a promise-based capture:region
let apiPort = 0;

// Application menu. Even with the bar hidden, this is what supplies the
// clipboard keyboard accelerators (Ctrl+C/V/X, Select All). Without it,
// pasting and dictation tools (e.g. Wispr Flow) silently fail in text fields.
function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

// Right-click context menu with clipboard actions for editable fields. Gives
// users a visible Paste even if a keyboard shortcut is intercepted upstream.
function wireContextMenu(webContents) {
  webContents.on('context-menu', (_e, params) => {
    const canPaste = params.editFlags?.canPaste;
    const items = [];
    if (params.isEditable || params.selectionText) {
      if (params.editFlags?.canCut) items.push({ role: 'cut' });
      if (params.editFlags?.canCopy) items.push({ role: 'copy' });
      if (params.isEditable) items.push({ role: 'paste', enabled: !!canPaste });
      if (params.editFlags?.canSelectAll) items.push({ type: 'separator' }, { role: 'selectAll' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(webContents) });
  });
}

function createWindow() {
  const winIcon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon@2x.png'));
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#09090b',
    title: 'AIOS',
    icon: winIcon.isEmpty() ? undefined : winIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Add Shot minimizes/restores this window during capture; without this,
      // Chromium throttles background timers + promise microtasks, so an
      // in-flight OCR (and its timeout) can stall and never settle.
      backgroundThrottling: false,
      additionalArguments: [`--api-port=${apiPort}`],
    },
  });

  // Keep the menu bar hidden (clean custom UI) but the clipboard accelerators
  // from the application menu still fire — Ctrl+V, Ctrl+C, etc.
  mainWindow.setMenuBarVisibility(false);
  wireContextMenu(mainWindow.webContents);

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('AIOS');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open AIOS', click: showMain },
    { label: 'Snip Now (Ctrl+Shift+S)', click: triggerCapture },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', showMain);
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
}

function triggerCapture() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.bounds;

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    frame: false, transparent: true, fullscreenable: false, resizable: false,
    movable: false, minimizable: false, maximizable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true);
  overlayWindow.overlayDisplayId = display.id;
  overlayWindow.overlayDisplaySize = { width: display.size.width, height: display.size.height, scaleFactor: display.scaleFactor };

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    // Safety: if the overlay vanished without submit/cancel, don't leave a
    // capture:region promise hanging forever.
    if (pendingRegionResolve) { const resolve = pendingRegionResolve; pendingRegionResolve = null; resolve(null); }
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.once('ready-to-show', () => { overlayWindow.show(); overlayWindow.focus(); });
}

ipcMain.handle('overlay:get-source', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throw new Error('No overlay window');
  const displayId = win.overlayDisplayId;
  const size = win.overlayDisplaySize ?? { width: 1920, height: 1080, scaleFactor: 1 };
  const thumbWidth = Math.round(size.width * size.scaleFactor);
  const thumbHeight = Math.round(size.height * size.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbWidth, height: thumbHeight },
  });
  if (!sources.length) throw new Error('No screen sources available');
  const match = sources.find(s => String(s.display_id) === String(displayId)) ?? sources[0];
  const thumb = match.thumbnail;
  return { dataUrl: thumb.toDataURL(), width: thumb.getSize().width, height: thumb.getSize().height };
});

ipcMain.on('overlay:submit', (event, dataUrl) => {
  destroyOverlay();
  const targetId = pendingCaptureTargetId;
  pendingCaptureTargetId = null;
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  // Promise-based capture (editor "Add Shot") takes precedence: hand the image
  // straight back to the caller instead of broadcasting it to onSnipImage.
  if (pendingRegionResolve) {
    const resolve = pendingRegionResolve;
    pendingRegionResolve = null;
    resolve({ dataUrl });
    return;
  }
  if (!mainWindow) return;
  mainWindow.webContents.send('snip-image', { dataUrl, targetId });
});

ipcMain.on('overlay:cancel', () => {
  pendingCaptureTargetId = null;
  if (pendingRegionResolve) { const resolve = pendingRegionResolve; pendingRegionResolve = null; resolve(null); }
  destroyOverlay();
});

// Promise-based region capture. Resolves with the cropped image (or null on
// cancel) so the caller can handle it inline — no global broadcast / no
// dependency on a hidden tab to relay the result.
ipcMain.handle('capture:region', () => new Promise((resolve) => {
  // If a prior region capture is somehow still pending, cancel it cleanly.
  if (pendingRegionResolve) { const prev = pendingRegionResolve; pendingRegionResolve = null; prev(null); }
  pendingRegionResolve = resolve;
  pendingCaptureTargetId = null;
  if (mainWindow) mainWindow.minimize();
  setTimeout(triggerCapture, 150);
}));

ipcMain.on('capture:request', () => {
  pendingCaptureTargetId = null;
  if (mainWindow) mainWindow.minimize();
  setTimeout(triggerCapture, 150);
});

ipcMain.on('capture:request-for-item', (_e, itemId) => {
  pendingCaptureTargetId = itemId || null;
  if (mainWindow) mainWindow.minimize();
  setTimeout(triggerCapture, 150);
});

app.whenReady().then(async () => {
  migrateLegacyKey();

  try {
    sqliteStore.init(path.join(app.getPath('userData'), 'aios.db'));
  } catch (e) {
    console.error('Failed to open SQLite store:', e);
  }

  try {
    const { port } = await apiServer.start();
    apiPort = port;
  } catch (e) {
    console.error('Failed to start API server:', e);
  }

  terminal.registerTerminalIpc();

  Menu.setApplicationMenu(buildAppMenu());

  createWindow();
  createTray();

  const ok = globalShortcut.register('Control+Shift+S', triggerCapture);
  if (!ok) console.warn('Global shortcut registration failed (Ctrl+Shift+S may be in use).');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Stay alive in tray; only fully exit on explicit Quit.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  terminal.killAll();
});

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:get-api-port', () => apiPort);

// SQLite data store bridge. The renderer's src/lib/db.ts calls these by op
// name; sqlite-store whitelists the op set and throws on anything unknown.
// better-sqlite3 is synchronous, so this returns immediately; a thrown error
// rejects the renderer's invoke() (matching the old IndexedDB reject path).
ipcMain.handle('aios:db', (_e, op, args) => sqliteStore.call(op, args));

// Native folder picker (used by Orchestra: project root, agent working dir, card overrides)
ipcMain.handle('dialog:pick-folder', async (_e, opts = {}) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: opts.title || 'Select folder',
    defaultPath: opts.defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Native file picker (used by DeepDive research attachments). Returns an array
// of absolute file paths, or [] if cancelled.
ipcMain.handle('dialog:pick-files', async (_e, opts = {}) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: opts.title || 'Attach files',
    properties: ['openFile', 'multiSelections'],
    filters: opts.filters || [
      { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'txt', 'md', 'markdown', 'csv', 'json', 'rtf'] },
      { name: 'Code', extensions: ['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'xml', 'yaml', 'yml', 'sql', 'sh'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return [];
  return result.filePaths;
});

// Export a Deep Research report (md/pdf/docx). Shows a save dialog and writes
// the file. Returns { ok, path } or { canceled: true }.
ipcMain.handle('research:export', async (_e, { format, title, markdown } = {}) => {
  if (!markdown || typeof markdown !== 'string') throw new Error('markdown is required');
  const fmt = ['md', 'pdf', 'docx'].includes(format) ? format : 'md';
  const built = await reportExport.buildExport(fmt, title || 'Research Report', markdown);
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const safeName = (title || 'research-report').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'research-report';
  const result = await dialog.showSaveDialog(win, {
    title: 'Export research report',
    defaultPath: path.join(app.getPath('downloads'), `${safeName}.${built.ext}`),
    filters: [{ name: built.ext.toUpperCase(), extensions: [built.ext] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (built.buffer) fs.writeFileSync(result.filePath, built.buffer);
  else fs.writeFileSync(result.filePath, built.text, 'utf8');
  return { ok: true, path: result.filePath };
});

// Multi-provider key handlers
ipcMain.handle('keys:get', (_e, providerId) => {
  if (typeof providerId !== 'string') throw new Error('providerId must be a string');
  return getProviderKey(providerId);
});

ipcMain.handle('keys:set', (_e, providerId, key) => {
  if (typeof providerId !== 'string') throw new Error('providerId must be a string');
  if (typeof key !== 'string') throw new Error('key must be a string');
  setProviderKey(providerId, key.trim());
  return true;
});

ipcMain.handle('keys:clear', (_e, providerId) => {
  setProviderKey(providerId, '');
  return true;
});

ipcMain.handle('keys:list', () => listConfiguredProviders());
ipcMain.handle('keys:available', () => safeStorage.isEncryptionAvailable());

// Model-ID slot handlers
ipcMain.handle('models:get-all', () => modelstore.getAllModels());
ipcMain.handle('models:set', (_e, slot, modelId) => {
  if (typeof slot !== 'string' || typeof modelId !== 'string') throw new Error('slot and modelId must be strings');
  modelstore.setModelId(slot, modelId);
  return modelstore.getAllModels();
});
ipcMain.handle('models:reset', (_e, slot) => {
  if (typeof slot !== 'string') throw new Error('slot must be a string');
  modelstore.resetSlot(slot);
  return modelstore.getAllModels();
});
ipcMain.handle('models:defaults', () => modelstore.DEFAULTS);
