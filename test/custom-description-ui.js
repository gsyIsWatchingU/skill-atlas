const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const customDescription = '审查代码变更并输出按优先级排序的改进建议。';
let savedDescription = '';

function createResult() {
  return {
    skills: [{
      id: 'review-agent',
      name: 'review-agent',
      description: 'Review code changes and report actionable findings.',
      localizedDescription: '审查代码变更并报告可操作问题。',
      customDescription: savedDescription,
      body: '# Review agent\nReview the requested changes.',
      platform: 'codex',
      scope: '全局',
      source: 'Codex 用户技能',
      rootId: 'codex-user',
      path: 'C:\\skills\\review-agent',
      filePath: 'C:\\skills\\review-agent\\SKILL.md',
      modifiedAt: new Date().toISOString(),
      size: 128,
      resourceFiles: 0,
      resourceDirectories: 0,
      valid: true,
      duplicate: false
    }],
    roots: [{
      id: 'codex-user',
      platform: 'codex',
      scope: '全局',
      label: 'Codex 用户技能',
      rootPath: 'C:\\skills',
      builtin: true,
      exists: true
    }],
    errors: [],
    scannedAt: new Date().toISOString()
  };
}

ipcMain.handle('skills:scan', () => createResult());
ipcMain.handle('skills:description:set', (_event, payload) => {
  savedDescription = String(payload.description || '').trim();
  return savedDescription;
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const wait = () => document.querySelector('.skill-card') ? resolve() : setTimeout(wait, 20);
      wait();
    })`);
    const initialDescription = await window.webContents.executeJavaScript(
      `document.querySelector('.skill-card p').textContent`
    );
    if (initialDescription !== '审查代码变更并报告可操作问题。') {
      throw new Error('未优先展示内置中文简介');
    }
    await window.webContents.executeJavaScript(`(() => {
      document.querySelector('.skill-card').click();
      document.querySelector('#edit-description').click();
      const input = document.querySelector('#description-input');
      input.value = ${JSON.stringify(customDescription)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#description-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const wait = () => {
        const cardText = document.querySelector('.skill-card p')?.textContent;
        const detailText = document.querySelector('#detail-description')?.textContent;
        const badge = document.querySelector('.custom-pill')?.textContent;
        if (cardText === ${JSON.stringify(customDescription)} && detailText === ${JSON.stringify(customDescription)} && badge === '自定义简介') return resolve();
        if (attempts++ > 100) return reject(new Error('中文简介未正确展示'));
        setTimeout(wait, 20);
      };
      wait();
    })`);
    const cancelState = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#edit-description').click();
      document.querySelector('#description-input').value = '这段内容不应保存';
      document.querySelector('#description-form button[value="cancel"]').click();
      return {
        dialogOpen: document.querySelector('#description-dialog').open,
        detailText: document.querySelector('#detail-description').textContent
      };
    })()`);
    if (cancelState.dialogOpen || cancelState.detailText !== customDescription || savedDescription !== customDescription) {
      throw new Error('取消编辑时不应修改中文简介');
    }
    console.log('内置与自定义中文简介界面验收通过');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
