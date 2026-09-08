const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getDefaultRoots, scanSkills } = require('./skill-scanner');
const { attachCustomDescriptions, normalizeSettings, updateCustomDescription } = require('./settings');

let mainWindow;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function readSettings() {
  try {
    const value = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    return normalizeSettings(value);
  } catch {
    return normalizeSettings();
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: '#0b0f14',
    title: 'Skill Atlas',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('skills:scan', async () => {
  const settings = await readSettings();
  const result = await scanSkills([...getDefaultRoots(), ...settings.customRoots]);
  return attachCustomDescriptions(result, settings.customDescriptions);
});

ipcMain.handle('skills:description:set', async (_event, payload = {}) => {
  const currentSettings = await readSettings();
  const result = updateCustomDescription(currentSettings, payload.id, payload.description);
  await writeSettings(result.settings);
  return result.description;
});

ipcMain.handle('roots:add', async (_event, platform) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Skill 扫描目录或项目目录',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const settings = await readSettings();
  const rootPath = result.filePaths[0];
  const exists = settings.customRoots.some(
    (root) => path.normalize(root.rootPath).toLowerCase() === path.normalize(rootPath).toLowerCase()
  );
  if (!exists) {
    settings.customRoots.push({
      id: `custom-${Date.now()}`,
      platform: ['codex', 'trae', 'shared'].includes(platform) ? platform : 'shared',
      scope: '自定义',
      label: path.basename(rootPath) || '自定义目录',
      rootPath,
      builtin: false,
      maxDepth: 10
    });
    await writeSettings(settings);
  }
  return rootPath;
});

ipcMain.handle('roots:remove', async (_event, id) => {
  const settings = await readSettings();
  settings.customRoots = settings.customRoots.filter((root) => root.id !== id);
  await writeSettings(settings);
  return true;
});

ipcMain.handle('path:open', async (_event, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return '路径无效';
  return shell.openPath(targetPath);
});

ipcMain.handle('path:reveal', async (_event, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return false;
  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle('clipboard:write', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('skills:export', async (_event, payload) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 Skill 清单',
    defaultPath: `skill-atlas-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
  return result.filePath;
});
