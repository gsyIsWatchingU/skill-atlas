'use strict';

/**
 * Skill Packer 桌面应用 · 主进程
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
const os = require('node:os');
const path = require('node:path');

const scanner = require('./scanner');
const cloud = require('./cloud-client');
const translator = require('./translator');
const { findDuplicateCandidates } = require('./ai/candidates');
const { buildPayload, describePayload } = require('./ai/payload');
const { buildPrompt, parseAdvice } = require('./ai/advice');
const { chatComplete } = require('./ai/llm-client');
const { resolveAdvice } = require('./ai');
const {
  buildUnifyPlan,
  applyUnify,
  rollbackUnify,
  enrichWithFingerprints
} = require('./unify');
const {
  aiMissingFields,
  readSettings,
  writeSettings,
  normalizeSettings,
  attachCustomDescriptions,
  updateAiConfig,
  updateCustomDescriptionZh,
  withMaskedAiConfig
} = require('./settings');

// 历史桌面版用过的做法：扫描结果实时反映磁盘，不做浏览器式缓存
app.commandLine.appendSwitch('disable-http-cache');

const DEFAULT_WINDOW = {
  width: 1440,
  height: 900,
  minWidth: 1080,
  minHeight: 700,
  // 与页面底色（--pixel-page #f4f5ef）一致，避免首帧闪白/闪黑
  backgroundColor: '#f4f5ef'
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
    title: 'Skill Packer',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
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

/* ---------------- AI 整理（数据出网的唯一出口） ---------------- */

/** 读 SKILL.md 正文供「附带正文摘要」使用。
 * 只读 SKILL.md 本身，不读 scripts/，也不读凭据类文件（§7 分层上传的同一条边界）；
 * frontmatter 已在元数据字段里，这里剥掉，避免同一份信息付两次 token。
 */
async function readSkillBody(skill) {
  assertScannedPath(skill.directoryPath);
  let content;
  try {
    content = await fs.readFile(path.join(skill.directoryPath, 'SKILL.md'), 'utf8');
  } catch {
    return '';
  }
  return content.replace(/^\uFEFF/, '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '').trim();
}

/** 正文要异步读，而 payload 构造是同步的 —— 先把候选涉及到的正文全部读进内存 */
async function collectBodies(groups) {
  const bodies = new Map();
  for (const group of groups) {
    for (const skill of group.members) {
      if (bodies.has(skill)) continue;
      bodies.set(skill, await readSkillBody(skill));
    }
  }
  return bodies;
}

/** 扫描结果 + 候选粗筛 + 载荷，三个入口共用的一段准备逻辑 */
async function prepareAiContext(options = {}) {
  if (!lastScan) throw new Error('尚未完成扫描，请先扫描');
  const settings = await readSettings(settingsPath());
  const config = settings.ai || {};
  const { groups, stats } = findDuplicateCandidates(lastScan.skills);
  const includeBody = typeof options.includeBody === 'boolean'
    ? options.includeBody
    : config.includeBody === true;
  const bodies = includeBody ? await collectBodies(groups) : new Map();
  const { payload, skills } = buildPayload(groups, {
    includeBody,
    maxBodyChars: config.maxBodyChars,
    homeDirectory: os.homedir(),
    bodyProvider: includeBody ? (skill) => bodies.get(skill) || '' : null
  });
  return { settings, config, groups, stats, payload, skills, includeBody };
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

  // 手动设置 / 清空某个 Skill 的中文简介
  ipcMain.handle('skills:descriptionZh:set', async (_event, payload) => {
    const id = String((payload && payload.id) || '');
    const descriptionZh = String((payload && payload.descriptionZh) || '').slice(0, 300);
    if (!id) throw new Error('缺少 Skill 标识');
    const settings = await readSettings(settingsPath());
    const { settings: updated } = updateCustomDescriptionZh(settings, id, descriptionZh);
    await writeSettings(settingsPath(), updated);
    return true;
  });

  // 翻译单个 Skill：源文本取当前 displayDescription（中文简介 > 自定义简介 > 原始）
  ipcMain.handle('skills:descriptionZh:translate-one', async (_event, payload) => {
    const id = String((payload && payload.id) || '');
    if (!id) throw new Error('缺少 Skill 标识');
    const skill = lastScan && lastScan.skills.find((s) => s.id === id);
    if (!skill) throw new Error('未找到该 Skill，请先扫描');
    const source = skill.displayDescription || skill.customDescription || skill.description || '';
    const zh = await translator.translateOne(source);
    const settings = await readSettings(settingsPath());
    const { settings: updated } = updateCustomDescriptionZh(settings, id, zh);
    await writeSettings(settingsPath(), updated);
    return { descriptionZh: zh };
  });

  // 一键转中文：批量翻译所有还没有中文简介的 Skill。
  // 每次翻译完一个就落盘一次，避免中途失败丢进度。
  ipcMain.handle('skills:descriptionZh:translate-all', async () => {
    if (!lastScan) throw new Error('尚未完成扫描');
    const settings = await readSettings(settingsPath());
    const missing = lastScan.skills.filter((skill) => {
      const zh = (settings.customDescriptionsZh || {})[skill.id];
      return !zh;
    });
    const sources = missing.map((skill) => skill.displayDescription || skill.customDescription || skill.description || '');
    const { ok, failed } = await translator.translateBatch(sources, { concurrency: 5 });

    let current = await readSettings(settingsPath());
    let saved = 0;
    for (const [indexStr, zh] of Object.entries(ok)) {
      const skill = missing[Number(indexStr)];
      if (!skill) continue;
      const applied = updateCustomDescriptionZh(current, skill.id, zh);
      current = applied.settings;
      saved += 1;
    }
    await writeSettings(settingsPath(), current);
    return {
      total: missing.length,
      saved,
      failed: Object.keys(failed).length,
      errors: failed
    };
  });

  // 导出清单：只导出元数据，不含脚本内容（§7 分层上传）
  ipcMain.handle('skills:export', async () => {
    if (!lastScan || !mainWindow) return null;
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: '导出 Skill 清单',
      defaultPath: 'skill-packer-inventory.json',
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

  /* ---------------- 统一技能库（写操作，manifest 可回滚） ---------------- */

  /** 统一用的扫描：只扫默认根，并给个人 Skill 补内容指纹（识别改名副本） */
  async function runUnifyScan() {
    const result = await scanner.scanRoots({ roots: scanner.DEFAULT_ROOTS, includeFiles: false });
    return enrichWithFingerprints(result);
  }

  // 执行统一：移动正本进中央、各 IDE 建 junction，写 manifest；完成后刷新扫描结果
  ipcMain.handle('unify:apply', async () => {
    const enriched = await runUnifyScan();
    const plan = buildUnifyPlan(enriched);
    if (!plan.items.length) throw new Error('没有可统一的 Skill');
    const { manifest, manifestPath } = await applyUnify(plan);
    const settings = await readSettings(settingsPath());
    lastScan = await runScan(settings);
    return {
      manifestPath,
      summary: {
        moved: manifest.moved.length,
        junctioned: manifest.junctioned.length,
        removedDuplicates: manifest.removedDuplicates.length,
        backedUp: manifest.backedUp.length
      }
    };
  });

  // 回滚：只接受中央目录 .unify-backup 区内的 manifest，不接受任意路径
  ipcMain.handle('unify:rollback', async (_event, manifestPath) => {
    const full = path.resolve(String(manifestPath || ''));
    const result = await scanner.scanRoots({ roots: scanner.DEFAULT_ROOTS, includeFiles: false });
    const central = result.roots.find((root) => root.id === 'shared-agents');
    if (!central) throw new Error('找不到中央目录');
    if (!isInside(full, path.join(central.path, '.unify-backup'))) {
      throw new Error('只允许回滚统一备份区内的 manifest');
    }
    const manifest = JSON.parse(await fs.readFile(full, 'utf8'));
    await rollbackUnify(manifest);
    const settings = await readSettings(settingsPath());
    lastScan = await runScan(settings);
    return true;
  });

  /* ---------------- AI 整理 ---------------- */

  ipcMain.handle('ai:config:read', async () => {
    const settings = await readSettings(settingsPath());
    return withMaskedAiConfig(settings);
  });

  ipcMain.handle('ai:config:set', async (_event, patch) => {
    const settings = await readSettings(settingsPath());
    const { settings: updated } = updateAiConfig(settings, patch || {});
    await writeSettings(settingsPath(), updated);
    return withMaskedAiConfig(updated);
  });

  // 本地粗筛：不出网、不花钱，任何时候都能看
  ipcMain.handle('ai:candidates', async () => {
    const { groups, stats } = await prepareAiContext();
    return {
      stats,
      groups: groups.map((group) => ({
        id: group.id,
        reason: group.reason,
        score: group.score,
        members: group.members.map(publicSkillFields)
      }))
    };
  });

  // 发送前的可见化：把「即将发出去什么」摊开给用户看，这一步不出网
  ipcMain.handle('ai:preview', async (_event, options) => {
    const { payload, stats, config, includeBody } = await prepareAiContext(options);
    if (!payload.groups.length) return { empty: true, stats, preview: null, payload: null };
    return {
      empty: false,
      stats,
      preview: describePayload(payload, { ...config, includeBody }),
      payload
    };
  });

  // 唯一的出网点：配置没开齐就不发，宁可报错也不偷偷请求
  ipcMain.handle('ai:advise', async (_event, options) => {
    const { payload, skills, config, stats, groups } = await prepareAiContext(options);
    if (config.enabled !== true) {
      throw new Error('还没开启「允许发送」。开启后才会有网络请求。');
    }
    const missing = aiMissingFields(config);
    if (missing.length) throw new Error(`还缺：${missing.join('、')}`);
    if (!payload.groups.length) return { empty: true, stats };

    const groupRefs = new Map(payload.groups.map((group) => [group.id, group.refs]));
    const validRefs = new Set(payload.skills.map((entry) => entry.ref));

    const { system, user } = buildPrompt(payload);
    const completion = await chatComplete({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    const parsed = parseAdvice(completion.text, { validRefs, groupRefs });
    const resolved = resolveAdvice(parsed, { skills, groups });

    return {
      empty: false,
      stats,
      model: completion.model,
      endpoint: completion.endpoint,
      usage: completion.usage,
      rawLength: completion.text.length,
      summary: resolved.summary,
      ok: resolved.ok,
      error: resolved.error || '',
      rejected: resolved.rejected,
      missingGroups: resolved.missingGroups || [],
      groups: resolved.groups
    };
  });

  // 导出建议：只写用户自己选的路径，不自动落到任何项目目录
  ipcMain.handle('ai:export', async (_event, payload) => {
    if (!mainWindow) return null;
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: '导出 AI 整理建议',
      defaultPath: 'skill-packer-advice.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (picked.canceled || !picked.filePath) return null;
    await fs.writeFile(picked.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return picked.filePath;
  });

  /* ---------------- 云同步（直连 GPU API） ---------------- */

  ipcMain.handle('cloud:login', async (_event, credentials) => {
    const auth = await cloud.login({
      email: String((credentials && credentials.email) || '').trim(),
      password: String((credentials && credentials.password) || '')
    });
    return { user: auth.user };
  });

  ipcMain.handle('cloud:logout', async () => {
    await cloud.logout();
    return true;
  });

  ipcMain.handle('cloud:me', async () => {
    return cloud.currentUser();
  });

  ipcMain.handle('cloud:list', async (_event, scope) => {
    return cloud.listCloud(scope === 'community' ? 'community' : 'mine');
  });

  ipcMain.handle('cloud:upload', async (_event, payload) => {
    const skill = (payload && payload.skill) || {};
    assertScannedPath(skill.directoryPath);
    return cloud.uploadLocalSkill({
      skill,
      directoryPath: skill.directoryPath,
      visibility: payload.visibility
    });
  });

  ipcMain.handle('cloud:download', async (_event, payload) => {
    if (!mainWindow) return null;
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择保存 Skill 的目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    return cloud.downloadCloudSkill({
      id: String((payload && payload.id) || ''),
      targetDir: picked.filePaths[0]
    });
  });

  ipcMain.handle('cloud:setVisibility', async (_event, payload) => {
    return cloud.setVisibility({
      id: String((payload && payload.id) || ''),
      visibility: payload.visibility
    });
  });
}

/* ---------------- 自检模式（--smoke） ---------------- */

/**
 * `node scripts/desktop.js --smoke`：不弹窗口，跑一遍与真实点击「重新扫描」完全相同的
 * 流水线（settings → scanner → usage），把摘要打到 stdout，退出码表达结果。
 * 用途：本机与 CI 可复现地验证桌面端扫描路径，避免打包完成后才发现应用起不来。
 * 正常启动不受影响（只有显式传 --smoke 才进入）。
 */
function isSmokeMode() {
  return process.argv.includes('--smoke');
}

async function runSmoke() {
  const settings = await readSettings(settingsPath());
  const result = await runScan(settings);
  const readyRoots = result.roots.filter((root) => root.status === 'ready').length;
  const summary = {
    ok: true,
    skills: result.skills.length,
    roots: `${readyRoots}/${result.roots.length}`,
    followedLinks: (result.links.followed || []).length,
    usage: result.usage ? 'read' : 'none'
  };
  console.log(`[smoke] ${JSON.stringify(summary)}`);
}

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  if (isSmokeMode()) {
    try {
      await runSmoke();
      app.exit(0);
    } catch (error) {
      console.error(`[smoke] fail ${error && error.stack ? error.stack : error}`);
      app.exit(1);
    }
    return;
  }
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
