const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aios', {
  isElectron: true,
  // Capture
  requestCapture: () => ipcRenderer.send('capture:request'),
  requestCaptureForItem: (itemId) => ipcRenderer.send('capture:request-for-item', itemId),
  onSnipImage: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('snip-image', listener);
    return () => ipcRenderer.removeListener('snip-image', listener);
  },
  // App info
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getApiPort: () => ipcRenderer.invoke('app:get-api-port'),
  // Native folder picker
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pick-folder', opts || {}),
  // Native multi-file picker (DeepDive research attachments)
  pickFiles: (opts) => ipcRenderer.invoke('dialog:pick-files', opts || {}),
  // Deep Research report export (md/pdf/docx) — save dialog handled in main.
  exportReport: (payload) => ipcRenderer.invoke('research:export', payload),
  // Multi-provider keys
  getProviderKey: (providerId) => ipcRenderer.invoke('keys:get', providerId),
  setProviderKey: (providerId, key) => ipcRenderer.invoke('keys:set', providerId, key),
  clearProviderKey: (providerId) => ipcRenderer.invoke('keys:clear', providerId),
  listProviders: () => ipcRenderer.invoke('keys:list'),
  isSecureStorageAvailable: () => ipcRenderer.invoke('keys:available'),
  // Configurable model IDs (per-slot)
  getModels: () => ipcRenderer.invoke('models:get-all'),
  setModel: (slot, modelId) => ipcRenderer.invoke('models:set', slot, modelId),
  resetModel: (slot) => ipcRenderer.invoke('models:reset', slot),
  getModelDefaults: () => ipcRenderer.invoke('models:defaults'),

  // Terminal (Kanban → Terminal pane)
  term: {
    available: () => ipcRenderer.invoke('term:available'),
    spawn: (opts) => ipcRenderer.invoke('term:spawn', opts),
    write: (id, data) => ipcRenderer.invoke('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('term:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('term:kill', id),
    onData: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('term:data', listener);
      return () => ipcRenderer.removeListener('term:data', listener);
    },
    onExit: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('term:exit', listener);
      return () => ipcRenderer.removeListener('term:exit', listener);
    },
  },
});
