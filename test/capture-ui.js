const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getDefaultRoots, scanSkills } = require('../src/skill-scanner');

ipcMain.handle('skills:scan', () => scanSkills(getDefaultRoots()));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const image = await window.webContents.capturePage();
  const target = path.join(__dirname, '..', 'work', 'skill-atlas-qa.png');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, image.toPNG());
  console.log(target);
  app.quit();
});
