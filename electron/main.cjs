const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, desktopCapturer, ipcMain, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { getProviderKey, setProviderKey, listConfiguredProviders } = require('./keystore.cjs');
const apiServer = require('./api-server.cjs');

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
let apiPort = 0;

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--api-port=${apiPort}`],
    },
  });

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

  overlayWindow.on('closed', () => { overlayWindow = null; });
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
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('snip-image', { dataUrl, targetId });
});

ipcMain.on('overlay:cancel', () => { pendingCaptureTargetId = null; destroyOverlay(); });

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
    const { port } = await apiServer.start();
    apiPort = port;
  } catch (e) {
    console.error('Failed to start API server:', e);
  }

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
});

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:get-api-port', () => apiPort);

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
