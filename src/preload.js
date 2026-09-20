'use strict';

/**
 * preload：渲染进程唯一能触达主进程的桥。
 *
 * 安全基线（与 main.js 的 webPreferences 配套）：
 *   contextIsolation: true + sandbox: true + nodeIntegration: false
 *   渲染进程拿不到 require / process / fs，能力只以具名方法暴露。
 *
 * 这里刻意**不**暴露任何「传路径就执行」的方法：所有涉及文件系统的动作
 * 都先经主进程校验（例如 path:open 只接受本次扫描发现过的 Skill 文件）。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skillPacker', {
  version: () => ipcRenderer.invoke('app:version'),
  reloadUi: () => ipcRenderer.invoke('app:reload-ui'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

  readSettings: () => ipcRenderer.invoke('settings:read'),

  scan: () => ipcRenderer.invoke('skills:scan'),
  exportInventory: () => ipcRenderer.invoke('skills:export'),

  addRoot: () => ipcRenderer.invoke('roots:add'),
  removeRoot: (rootId) => ipcRenderer.invoke('roots:remove', rootId),

  setDescription: (id, description) => ipcRenderer.invoke('skills:description:set', { id, description }),
  setDescriptionZh: (id, descriptionZh) => ipcRenderer.invoke('skills:descriptionZh:set', { id, descriptionZh }),
  translateDescriptionZh: (id) => ipcRenderer.invoke('skills:descriptionZh:translate-one', { id }),
  translateAllDescriptionZh: () => ipcRenderer.invoke('skills:descriptionZh:translate-all'),

  openSkillFile: (filePath) => ipcRenderer.invoke('path:open', filePath),
  revealSkillFile: (filePath) => ipcRenderer.invoke('path:reveal', filePath),

  // AI 整理：candidates / preview 不出网，advise 是唯一的出网点
  aiConfig: () => ipcRenderer.invoke('ai:config:read'),
  aiSetConfig: (patch) => ipcRenderer.invoke('ai:config:set', patch),
  aiCandidates: () => ipcRenderer.invoke('ai:candidates'),
  aiPreview: (options) => ipcRenderer.invoke('ai:preview', options),
  aiAdvise: (options) => ipcRenderer.invoke('ai:advise', options),
  aiExport: (payload) => ipcRenderer.invoke('ai:export', payload),

  cloudLogin: (credentials) => ipcRenderer.invoke('cloud:login', credentials),
  cloudLogout: () => ipcRenderer.invoke('cloud:logout'),
  cloudMe: () => ipcRenderer.invoke('cloud:me'),
  cloudList: (scope) => ipcRenderer.invoke('cloud:list', scope),
  cloudUpload: (payload) => ipcRenderer.invoke('cloud:upload', payload),
  cloudDownload: (payload) => ipcRenderer.invoke('cloud:download', payload),
  cloudSetVisibility: (payload) => ipcRenderer.invoke('cloud:setVisibility', payload)
});