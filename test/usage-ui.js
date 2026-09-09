const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getDefaultRoots, scanSkills } = require('../src/skill-scanner');
const { scanCodexUsage } = require('../src/usage-scanner');
const { attachCustomDescriptions } = require('../src/settings');

const testDataDirectory = path.join(app.getPath('temp'), `skill-atlas-usage-ui-${process.pid}`);
app.setPath('userData', testDataDirectory);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

ipcMain.handle('app:version', () => '1.0.2');
ipcMain.handle('app:reload-ui', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return false;
  window.webContents.reloadIgnoringCache();
  return true;
});
ipcMain.handle('skills:scan', async () => {
  const localized = attachCustomDescriptions(await scanSkills(getDefaultRoots()));
  const usage = await scanCodexUsage(localized.skills, {
    cachePath: path.join(testDataDirectory, 'usage-index.json')
  });
  return {
    ...localized,
    skills: usage.skills,
    usage: {
      summary: usage.summary,
      daily: usage.daily,
      topSkills: usage.topSkills,
      meta: usage.meta
    }
  };
});

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
      sandbox: true,
      backgroundThrottling: false
    }
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const wait = () => {
        if (document.querySelector('.skill-card')) return resolve();
        if (attempts++ > 300) return reject(new Error('技能扫描超时'));
        setTimeout(wait, 25);
      };
      wait();
    })`);
    const result = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-view="usage"]').click();
      return {
        heading: document.querySelector('#page-heading').textContent,
        total: Number(document.querySelector('#metric-usage-total').textContent),
        trendBars: document.querySelectorAll('#usage-trend .trend-item').length,
        rankingRows: document.querySelectorAll('#usage-ranking .ranking-row').length,
        usageVisible: !document.querySelector('#usage-view').classList.contains('hidden')
      };
    })()`);
    if (result.heading !== '使用分析' || !result.usageVisible) throw new Error('使用分析页面未显示');
    if (result.trendBars !== 30) throw new Error('近 30 天趋势未完整渲染');
    if (result.total > 0 && result.rankingRows === 0) throw new Error('高频 Skill 排行未渲染');

    window.showInactive();
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 700));
    const image = await window.webContents.capturePage();
    const target = path.join(__dirname, '..', 'work', 'skill-atlas-usage-qa.png');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, image.toPNG());

    const catalogResult = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-platform="all"]').click();
      const sort = document.querySelector('#sort-order');
      sort.value = 'usage';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        heading: document.querySelector('#page-heading').textContent,
        firstUsage: document.querySelector('.skill-card .card-usage')?.textContent || '',
        catalogVisible: !document.querySelector('#catalog-view').classList.contains('hidden')
      };
    })()`);
    if (catalogResult.heading !== '技能总览' || !catalogResult.catalogVisible) throw new Error('技能总览未恢复');
    if (!catalogResult.firstUsage.includes('次使用')) throw new Error('技能卡片未显示使用次数');
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const catalogImage = await window.webContents.capturePage();
    const catalogTarget = path.join(__dirname, '..', 'work', 'skill-atlas-catalog-usage-qa.png');
    await fs.writeFile(catalogTarget, catalogImage.toPNG());

    window.setSize(1100, 800);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const compactResult = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-view="usage"]').click();
      return getComputedStyle(document.querySelector('.analytics-grid')).gridTemplateColumns;
    })()`);
    if (compactResult.trim().split(/\s+/).length !== 1) throw new Error('窄窗口分析卡片未切换为单列');
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const compactImage = await window.webContents.capturePage();
    const compactTarget = path.join(__dirname, '..', 'work', 'skill-atlas-usage-compact-qa.png');
    await fs.writeFile(compactTarget, compactImage.toPNG());

    const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-platform="all"]').click();
      const search = document.querySelector('#search');
      search.value = 'openai';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const sort = document.querySelector('#sort-order');
      sort.value = 'usage';
      sort.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#reload-ui').click();
    })()`);
    await reloaded;
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const wait = () => {
        if (document.querySelector('.skill-card')) return resolve();
        if (attempts++ > 300) return reject(new Error('重新加载后技能扫描超时'));
        setTimeout(wait, 25);
      };
      wait();
    })`);
    const restoredState = await window.webContents.executeJavaScript(`({
      heading: document.querySelector('#page-heading').textContent,
      search: document.querySelector('#search').value,
      sort: document.querySelector('#sort-order').value
    })`);
    if (restoredState.heading !== '技能总览' || restoredState.search !== 'openai' || restoredState.sort !== 'usage') {
      throw new Error('重新加载后未恢复界面状态');
    }
    console.log(`使用分析界面验收通过：${target}`);
    console.log(`使用频率排序验收通过：${catalogTarget}`);
    console.log(`窄窗口布局验收通过：${compactTarget}`);
    console.log('界面重新加载与状态恢复验收通过');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
