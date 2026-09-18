'use strict';

/**
 * Skill Dock 桌面应用 · 主进程
 *
 * 通道归属（docs/solution.md §2，2026-09-18 修订）：
 *   本应用是 **C 通道（本地可信宿主）的主载体**，不是新通道。
 *   C 的定义从「扩展 + Native Messaging」提升为「可读取并修改受管目录的本地可信宿主」，
 *   载体可以是 Electron 桌面应用，也可以是扩展 + Native Messaging。
 *   当前版本只启用 C 的 **read capability**（只读扫描），写入能力留给 M2。
 *
 * 本轮不做的事（避免与 §2 原则 1 冲突）：
 *   - 不申请任何写入权限，不建/删链接，不碰 config.toml
 *   - 不启动本地 HTTP 服务（历史 helper 的 127.0.0.1:18787 在这里不存在，
 *     顺带消掉 §11 缺陷 #2「配对令牌走 URL hash + Allow-Private-Network」）
 *   - 不联网上传（用户要上传时走既有 Web 的显式动作）
 */

const { app, BrowserWindow, ipcMain, clipboard, shell, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const scanner = require('./scanner');
const {
  readSettings,
  writeSettings,
  normalizeSettings,
  attachCustomDescriptions
} = require('./settings');

// 历史桌面版用过的做法：扫描结果实时反映磁盘，不做浏览器式缓存
app.commandLine.appendSwitch('disable-http-cache');

const DEFAULT_WINDOW = {
  width: 1440,
  height: 900,
  minWidth: 1080,
  minHeight: 700,
  backgroundColor: '#0b0f14'
};

let mainWindow = null;
/** 最近一次扫描结果留在内存（§7 纯本地：不落盘、不上传） */
let lastScan = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function resolvedRoots(settings) {
  const customRoots = (settings.customRoots || []).map((root) => ({
    ...root,
    custom: true
  }));
  return [...scanner.DEFAULT_ROOTS, ...customRoots];
}

async function runScan(settings) {
  const roots = resolvedRoots(settings);
  const result = await scanner.scanRoots({
    roots,
    // 首启 §7「纯本地模式」：不外传脚本内容，扫描结果只留内存
    includeFiles: false
  });
  const skills = attachCustomDescriptions(
    scanner.dedupeByDirectory(result.skills),
    settings
  );
  let usage = null;
  try {
    // 使用统计读 Codex session 日志，口径是 referenced（SKILL.md 被工具调用引用），
    // 不是 invoked —— Codex 不记录技能实际调用，详见 usage-scanner.js 模块头注释
    usage = await require('./usage-scanner').scanCodexUsage(skills);
  } catch {
    usage = null;
  }
  return {
    ...result,
    skills,
    usage,
    scannedAt: new Date().toISOString()
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...DEFAULT_WINDOW,
    show: false,
    autoHideMenuBar: true,
    title: 'Skill Dock',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 安全基线：渲染进程拿不到 Node，能力只能通过白名单 IPC 暴露
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 判断 target 是否落在 base 目录内。
 * 不能用 startsWith：`/skills/abc` 会错误匹配 `/skills/abcdef`，
 * 必须比较到路径分隔符边界。
 */
function isInside(target, base) {
  const full = path.resolve(target);
  const root = path.resolve(base);
  if (full === root) return true;
  const relative = path.relative(root, full);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 只允许操作本次扫描发现的 Skill 目录内的路径 */
function assertScannedPath(target) {
  if (!lastScan) throw new Error('尚未完成扫描');
  if (!lastScan.skills.some((skill) => isInside(target, skill.directoryPath))) {
    throw new Error('只允许操作本次扫描发现的 Skill 文件');
  }
}

/* ---------------- IPC ---------------- */

/**
 * 白名单 IPC。渲染进程唯一能触达主进程的入口。
 * 规则：只暴露具名动作，不接受任意路径读/任意命令执行。
 */
function registerIpc() {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('app:reload-ui', () => {
    if (mainWindow) mainWindow.webContents.reload();
    return true;
  });

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  ipcMain.handle('settings:read', async () => {
    const settings = await readSettings(settingsPath());
    return normalizeSettings(settings);
  });

  ipcMain.handle('skills:scan', async () => {
    const settings = await readSettings(settingsPath());
    lastScan = await runScan(settings);
    return lastScan;
  });

  // 打开 SKILL.md：只允许打开本机文件路径，且必须落在某个扫描根里
  ipcMain.handle('path:open', async (_event, target) => {
    assertScannedPath(target);
    await shell.openPath(path.resolve(String(target)));
    return true;
  });

  ipcMain.handle('path:reveal', async (_event, target) => {
    assertScannedPath(target);
    shell.showItemInFolder(path.resolve(String(target)));
    return true;
  });

  // 添加自定义扫描根：走系统目录选择器，不接受渲染进程传入的任意路径
  ipcMain.handle('roots:add', async () => {
    if (!mainWindow) return null;
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择要扫描的 Skill 目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    const directory = picked.filePaths[0];
    const settings = await readSettings(settingsPath());
    const id = `custom-${Buffer.from(directory).toString('base64url').slice(0, 16)}`;
    if (!(settings.customRoots || []).some((root) => root.id === id)) {
      settings.customRoots = [
        ...(settings.customRoots || []),
        { id, label: path.basename(directory) || directory, absolutePath: directory }
      ];
      await writeSettings(settingsPath(), settings);
    }
    lastScan = await runScan(settings);
    return lastScan;
  });

  ipcMain.handle('roots:remove', async (_event, rootId) => {
    const settings = await readSettings(settingsPath());
    settings.customRoots = (settings.customRoots || []).filter((root) => root.id !== rootId);
    await writeSettings(settingsPath(), settings);
    lastScan = await runScan(settings);
    return lastScan;
  });

  ipcMain.handle('skills:description:set', async (_event, payload) => {
    const id = String((payload && payload.id) || '');
    const description = String((payload && payload.description) || '').slice(0, 300);
    if (!id) throw new Error('缺少 Skill 标识');
    const settings = await readSettings(settingsPath());
    if (description) settings.customDescriptions[id] = description;
    else delete settings.customDescriptions[id];
    await writeSettings(settingsPath(), settings);
    return true;
  });

  // 导出清单：只导出元数据，不含脚本内容（§7 分层上传）
  ipcMain.handle('skills:export', async () => {
    if (!lastScan || !mainWindow) return null;
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: '导出 Skill 清单',
      defaultPath: 'skill-dock-inventory.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (picked.canceled || !picked.filePath) return null;
    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      roots: lastScan.roots.map((root) => ({
        id: root.id, label: root.label, status: root.status, skillCount: root.skillCount
      })),
      links: scanner.summarizeLinks(lastScan.links),
      skills: lastScan.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        platform: skill.platform,
        scope: skill.scope,
        versionHash: skill.versionHash,
        fileCount: skill.fileCount,
        sizeBytes: skill.sizeBytes,
        skippedSensitive: skill.skippedSensitive
      }))
    };
    await fs.writeFile(picked.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return picked.filePath;
  });
}

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
