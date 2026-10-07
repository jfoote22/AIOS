const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, desktopCapturer, screen, safeStorage, dialog, Notification } = require('electron');
const { ipcMain, protectWindow, installApiTransport } = require('./renderer-security.cjs');
const path = require('path');
const fs = require('fs');
const { getProviderKey, setProviderKey, listConfiguredProviders, isSecureStorageAvailable } = require('./keystore.cjs');
const modelstore = require('./modelstore.cjs');
const apiServer = require('./api-server.cjs');
const terminal = require('./terminal.cjs');
const reportExport = require('./report-export.cjs');
const sqliteStore = require('./sqlite-store.cjs');
const memoryIngest = require('./memory-ingest.cjs');
const mobileGateway = require('./mobile-gateway.cjs');
const { fileAccess, inspectPath } = require('./file-access.cjs');

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

// --- Single instance ---------------------------------------------------------
// Two AIOS processes on one machine share ONE userData dir, so they open the
// same SQLite file and race on writes, and only the first can bind the fixed
// memory-ingest port (8765) — the loser fails silently and external notes stop
// arriving with no visible symptom. The window hides to the tray rather than
// quitting, which makes a lingering first instance easy to miss.
//
// Set AIOS_ALLOW_MULTI=1 to opt out when deliberately running a dev build
// alongside the installed app (accepting the shared-database risk).
if (!process.env.AIOS_ALLOW_MULTI && !app.requestSingleInstanceLock()) {
  console.log('[aios] another instance is already running — focusing it and exiting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

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
  const winIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
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
      sandbox: true,
      // Add Shot minimizes/restores this window during capture; without this,
      // Chromium throttles background timers + promise microtasks, so an
      // in-flight OCR (and its timeout) can stall and never settle.
      backgroundThrottling: false,
      additionalArguments: [`--api-port=${apiPort}`],
    },
  });

  // Keep the menu bar hidden (clean custom UI) but the clipboard accelerators
  // from the application menu still fire — Ctrl+V, Ctrl+C, etc.
  protectWindow(mainWindow, { development: isDev });
  mainWindow.setMenuBarVisibility(false);
  wireContextMenu(mainWindow.webContents);

  // Dictation diagnostics: mirror the renderer's [dictation] console lines and
  // OS-level window focus events to a file so insertion failures (Wispr Flow
  // et al.) can be traced after the fact. Remove once dictation is solid.
  const dictationLog = path.join(app.getPath('userData'), 'dictation-debug.log');
  const logDictation = (line) => {
    if (process.env.AIOS_DICTATION_DEBUG !== '1') return;
    try { fs.appendFileSync(dictationLog, `${new Date().toISOString()} ${line}\n`); } catch { /* best-effort */ }
  };
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    if (typeof message === 'string' && message.includes('[dictation]')) logDictation(message);
  });
  mainWindow.on('focus', () => logDictation('[main] window FOCUS (OS)'));
  mainWindow.on('blur', () => logDictation('[main] window BLUR (OS)'));
  logDictation(`[main] window created; accessibility=${app.isAccessibilitySupportEnabled()}`);

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

// Torn-off terminal windows. Each hosts a single pty session that previously
// lived in the main window's Terminal tab; the renderer adopts the session by
// id (see terminal.cjs "term:adopt"). Closing a popout kills its session,
// same as closing the slot would.
const termPopouts = new Set();

function createTerminalPopout({ id, label } = {}) {
  if (!id || typeof id !== 'string') throw new Error('A terminal session id is required.');
  const winIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  const win = new BrowserWindow({
    width: 920,
    height: 560,
    minWidth: 420,
    minHeight: 280,
    backgroundColor: '#09090b',
    title: label ? `${label} — Terminal` : 'Terminal',
    icon: winIcon.isEmpty() ? undefined : winIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: [`--api-port=${apiPort}`],
    },
  });
  protectWindow(win, { development: isDev });
  win.setMenuBarVisibility(false);
  wireContextMenu(win.webContents);
  termPopouts.add(win);
  win.on('closed', () => termPopouts.delete(win));

  const query = { termPopout: id, label: label || '' };
  if (isDev) {
    win.loadURL(`http://localhost:3000/?${new URLSearchParams(query).toString()}`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });
  }
  return true;
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
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });

  protectWindow(overlayWindow, { role: 'overlay' });
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
  // Windows: give the app an explicit identity so the taskbar shows our icon
  // (and groups windows) instead of the generic Electron one, and so toast
  // notifications are attributed to AIOS. Must match the build appId.
  if (process.platform === 'win32') app.setAppUserModelId('com.aios.app');

  // Chromium builds its accessibility tree lazily — only after an assistive
  // tool first queries it. Dictation tools (e.g. Wispr Flow) target text
  // fields through that tree, so the FIRST focus of a field after launch (or
  // after a long idle) has no tree to target and the transcript is dropped;
  // the second focus works because the first one triggered tree construction.
  // Force accessibility on from the start so dictation lands on first focus.
  app.setAccessibilitySupportEnabled(true);

  migrateLegacyKey();

  try {
    sqliteStore.init(path.join(app.getPath('userData'), 'aios.db'));
  } catch (e) {
    console.error('Failed to open SQLite store:', e);
  }

  try {
    const { port } = await apiServer.start({ development: isDev, approveAgentTool: async ({ agentName, cwd, tool, input, signal }) => {
      if (!mainWindow || mainWindow.isDestroyed() || signal.aborted) return false;
      const detail = JSON.stringify(input, null, 2);
      // Never truncate away the part of a command the user would be approving.
      if (!detail || detail.length > 12000) return false;
      mainWindow.show();
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: 'AIOS agent permission',
        message: `${agentName || 'Agent'} requests ${tool}`,
        detail: `Working directory: ${cwd || '(default)'}\n\n${detail}\n\nApprove only if you trust this exact action. Shell commands can access your files and network.`,
        buttons: ['Deny', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true,
        signal,
      });
      return response === 1 && !signal.aborted;
    } });
    apiPort = port;
    installApiTransport(port);
    mobileGateway.setApiPort(port);
  } catch (e) {
    console.error('Failed to start API server:', e);
  }

  // LAN-facing memory ingest webhook (off by default). Started here so external
  // agents (e.g. Hermes on the Mac) can POST markdown the moment the app is up.
  if (memoryIngest.isEnabled()) {
    try {
      await memoryIngest.start({ getWebContents: () => mainWindow?.webContents });
    } catch (e) {
      // A packaged build has no console anyone reads, so a failed bind used to
      // be completely invisible: AIOS looked fine while external notes stopped
      // arriving. Tell the user, since only they can free the port.
      console.error('Failed to start memory ingest server:', e);
      const detail = memoryIngest.status().lastError || e?.message || String(e);
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: 'AIOS: memory ingest is not running',
            body: `${detail} Incoming notes will not be received. Settings → Hermes to retry.`,
          }).show();
        }
      } catch { /* notifications are best-effort */ }
    }
  }

  // LAN/remote gateway for the Android companion app (off by default).
  if (mobileGateway.isEnabled()) {
    try {
      await mobileGateway.start({ apiPort, getWebContents: () => mainWindow?.webContents });
    } catch (e) {
      console.error('Failed to start mobile gateway:', e);
    }
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
  require('./document-parser.cjs').stopParsers();
  globalShortcut.unregisterAll();
  terminal.killAll();
  mobileGateway.stop();
});

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:get-api-port', () => apiPort);

// Tear a terminal session off into its own window. The renderer detaches its
// local xterm; the new window adopts the pty by id once it loads.
ipcMain.handle('term:open-window', (_e, payload) => createTerminalPopout(payload || {}));

// --- Memory ingest (LAN webhook) config ---
ipcMain.handle('memory:get-config', () => memoryIngest.status());
ipcMain.handle('memory:set-config', async (_e, cfg = {}) => {
  const { enabled, port } = cfg;
  if (typeof port === 'number' && Number.isFinite(port) && port > 0 && port < 65536) {
    setProviderKey('memory_ingest_port', String(Math.floor(port)));
  }
  if (typeof enabled === 'boolean') {
    setProviderKey('memory_ingest_enabled', enabled ? '1' : '');
  }
  // Apply: restart so a port change takes effect; start/stop to match `enabled`.
  memoryIngest.stop();
  if (memoryIngest.isEnabled()) {
    try {
      await memoryIngest.start({ getWebContents: () => mainWindow?.webContents });
    } catch (e) {
      return { ...memoryIngest.status(), error: e?.message || 'Failed to start ingest server.' };
    }
  }
  return memoryIngest.status();
});
ipcMain.handle('memory:regenerate-token', () => {
  memoryIngest.regenerateToken();
  return memoryIngest.status();
});

// --- Mobile gateway (LAN/remote companion app) config ---
ipcMain.handle('mobile:get-config', () => mobileGateway.status());
ipcMain.handle('mobile:set-config', async (_e, cfg = {}) => {
  const { enabled, port } = cfg;
  if (typeof cfg.terminalEnabled === 'boolean') {
    if (cfg.terminalEnabled) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: 'Allow remote terminal access?',
        message: 'Paired devices will be able to run commands as your desktop user.',
        detail: 'Only enable this on a trusted encrypted network. Anyone with your pairing token will have shell access. This is separate from browsing or capturing notes.',
        buttons: ['Cancel', 'Enable remote terminal'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1) return mobileGateway.status();
    }
    setProviderKey('mobile_terminal_enabled', cfg.terminalEnabled ? '1' : '');
  }
  if (typeof port === 'number' && Number.isFinite(port) && port > 0 && port < 65536) {
    setProviderKey('mobile_gateway_port', String(Math.floor(port)));
  }
  if (typeof enabled === 'boolean') {
    setProviderKey('mobile_gateway_enabled', enabled ? '1' : '');
  }
  // Restart so a port change takes effect; start/stop to match `enabled`.
  mobileGateway.stop();
  if (mobileGateway.isEnabled()) {
    try {
      await mobileGateway.start({ apiPort, getWebContents: () => mainWindow?.webContents });
    } catch (e) {
      return { ...mobileGateway.status(), error: e?.message || 'Failed to start gateway.' };
    }
  }
  return mobileGateway.status();
});
ipcMain.handle('mobile:regenerate-token', () => {
  mobileGateway.regenerateToken();
  return mobileGateway.status();
});

// SQLite data store bridge. The renderer's src/lib/db.ts calls these by op
// name; sqlite-store whitelists the op set and throws on anything unknown.
// better-sqlite3 is synchronous, so this returns immediately; a thrown error
// rejects the renderer's invoke() (matching the old IndexedDB reject path).
ipcMain.handle('aios:db', (_e, op, args) => sqliteStore.call(op, args));

const pendingWorkspaceApprovals = new Map();
ipcMain.handle('files:authorize-workspace', async (_e, root) => {
  const { target, stat } = await inspectPath(root);
  if (!stat.isDirectory()) throw new Error('Select a project folder.');
  try { await fileAccess.assertWorkspace(target); return true; } catch { /* request explicit consent */ }
  if (!pendingWorkspaceApprovals.has(target)) {
    const decision = (async () => {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: 'Approve project folder',
        message: 'Allow AIOS to manage agent/skill files and project snapshots in this folder?',
        detail: `${target}\n\nAllows the .claude editor and .aios/project.json operations for this app session. It does not approve agent tool actions or grant attachment access. Deleted editor files go to .aios-trash.`,
        buttons: ['Cancel', 'Allow folder'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1) return false;
      await fileAccess.grantWorkspace(target);
      return true;
    })().finally(() => pendingWorkspaceApprovals.delete(target));
    pendingWorkspaceApprovals.set(target, decision);
  }
  return pendingWorkspaceApprovals.get(target);
});

// Native folder picker (used by Orchestra: project root, agent working dir, card overrides)
ipcMain.handle('dialog:pick-folder', async (_e, opts = {}) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: opts.title || 'Select folder',
    defaultPath: opts.defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return fileAccess.grantWorkspace(result.filePaths[0]);
});

// Native file picker (used by DeepDive research attachments). Returns an array
// of absolute file paths, or [] if cancelled.
ipcMain.handle('dialog:pick-files', async (_e, opts = {}) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: opts.title || 'Attach files',
    properties: ['openFile', 'multiSelections'],
    filters: opts.filters || [
      { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'markdown', 'csv', 'json'] },
      { name: 'Code', extensions: ['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'xml', 'yaml', 'yml', 'sql', 'sh'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return [];
  return Promise.all(result.filePaths.map(file => fileAccess.grantFile(file)));
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

// ── Second Brain export / import ──────────────────────────────────────────────
// Export dumps the entire local store (snippets, threads, messages, imports +
// chunks, agents, skills, runs, meta) to a single JSON file. Import reads such a
// file back and merges it into the store (upsert by id) — so a brain can move
// onto a fresh install. Both show a native dialog and return a small status.
const BRAIN_EXPORT_FORMAT = 'aios-second-brain';
const BRAIN_EXPORT_VERSION = 1;

ipcMain.handle('brain:export', async () => {
  const data = sqliteStore.call('dumpAll');
  const payload = {
    format: BRAIN_EXPORT_FORMAT,
    version: BRAIN_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    data,
  };
  const counts = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
  );
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const stamp = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(win, {
    title: 'Export Second Brain',
    defaultPath: path.join(app.getPath('downloads'), `aios-second-brain-${stamp}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, JSON.stringify(payload), 'utf8');
  return { ok: true, path: result.filePath, counts };
});

ipcMain.handle('brain:import', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: 'Import Second Brain',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
  } catch (e) {
    throw new Error(`Could not read export file: ${e?.message || e}`);
  }
  // Accept both the wrapped export ({ format, data }) and a bare data object.
  const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  if (!data || typeof data !== 'object') throw new Error('File is not a valid Second Brain export.');
  if (parsed.format && parsed.format !== BRAIN_EXPORT_FORMAT) {
    throw new Error(`Unrecognized export format "${parsed.format}".`);
  }

  sqliteStore.call('bulkLoad', [data]);
  const counts = Object.fromEntries(
    ['snippets', 'meta', 'threads', 'messages', 'imports', 'importChunks', 'agents', 'skills', 'runs']
      .map((k) => [k, Array.isArray(data[k]) ? data[k].length : 0]),
  );
  return { ok: true, path: result.filePaths[0], counts };
});

// Provider-only capability: never allow these handlers to read/write gateway
// configuration or authentication tokens in the shared keystore.
const providerIds = new Set(['gemini', 'openai', 'anthropic', 'grok', 'deepgram', 'replicate', 'ollama', 'youtube']);
function validateProviderId(id) {
  if (!providerIds.has(id)) throw new Error('Unknown provider.');
}
ipcMain.handle('keys:preview', (_e, providerId) => {
  validateProviderId(providerId);
  return getProviderKey(providerId) ? '•••••••• (configured)' : '';
});

ipcMain.handle('keys:set', (_e, providerId, key) => {
  validateProviderId(providerId);
  if (typeof key !== 'string') throw new Error('key must be a string');
  setProviderKey(providerId, key.trim());
  return true;
});

ipcMain.handle('keys:clear', (_e, providerId) => {
  validateProviderId(providerId);
  setProviderKey(providerId, '');
  return true;
});

ipcMain.handle('keys:list', () => listConfiguredProviders().filter(id => providerIds.has(id)));
ipcMain.handle('keys:available', () => isSecureStorageAvailable());

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
