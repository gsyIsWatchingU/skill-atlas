const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skillAtlas', {
  scan: () => ipcRenderer.invoke('skills:scan'),
  addRoot: (platform) => ipcRenderer.invoke('roots:add', platform),
  removeRoot: (id) => ipcRenderer.invoke('roots:remove', id),
  openPath: (targetPath) => ipcRenderer.invoke('path:open', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('path:reveal', targetPath),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  exportSkills: (payload) => ipcRenderer.invoke('skills:export', payload)
});
