const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiosOverlay', {
  getScreenSource: () => ipcRenderer.invoke('overlay:get-source'),
  submit: (dataUrl) => ipcRenderer.send('overlay:submit', dataUrl),
  cancel: () => ipcRenderer.send('overlay:cancel'),
});
