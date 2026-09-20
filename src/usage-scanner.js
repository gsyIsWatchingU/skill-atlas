'use strict';

/**
 * 使用统计：从 Codex 本地会话日志里抽 SKILL.md 的**被引用记录**。
 *
 * ⚠️ 事件语义（2026-09-18 实测修正）：这不是 invoked。
 *
 * 对全部 475 个真实会话日志（含 345 个 sessions / 130 个 archived_sessions）抽样后确认：
 * Codex **不会把"技能被调用"记成一条工具调用**。日志里 63 处"工具调用引用了 SKILL.md 路径"，
 * 经逐条分类后全部是 agent 在**读取或编辑 SKILL.md 文件**本身
 * （`read` 647 条次、`write` 8 条次、其余为补丁上下文），没有一条是"这个技能被用来完成任务"。
 *
 * 所以本模块产出的事件类型是 **referenced**（该 SKILL.md 在工具调用中出现过），
 * 它是 invoked 的**弱代理指标**，不是等价物。上层展示必须如实标注口径，
 * 不得把它渲染成"调用次数"或"使用频率" —— 这正是 §4 要防的那类错误。
 *
 * 真正可靠的 invoked 数据只有两条来源，都还没接通：
 *   1. Codex 侧显式上报（需要 hook 或官方接口）
 *   2. Skill Packer 自己在 C 通道落盘后记录启用历史（M2）
 *
 * 隐私边界（§0「不上传对话内容、不采集使用语境，只上传调用次数」）：
 *   本模块只从会话日志里提取 **SKILL.md 的路径与时间戳**，
 *   其余对话内容在解析时即丢弃，不落盘、不外传。
 *
 * 缓存只写 app 自己的 userData 目录（索引文件），可随时删除重建。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const CACHE_VERSION = 2;
const SESSION_FILE_PATTERN = /\.jsonl$/i;
const WINDOWS_SKILL_PATH = /[A-Za-z]:(?:\\+|\/)[^'"`\r\n]*?SKILL\.md/gi;
const POSIX_SKILL_PATH = /\/(?:[^'"`\r\n]+\/)*SKILL\.md/gi;

/** 路径归一化：大小写与分隔符差异不应产生两个不同的 Skill */
function normalizeFilePath(value = '') {
  return String(value)
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLocaleLowerCase('en-US');
}

function getCodexSessionRoots(homeDirectory = os.homedir()) {
  return [
    path.join(homeDirectory, '.codex', 'sessions'),
    path.join(homeDirectory, '.codex', 'archived_sessions')
  ];
}

async function listSessionFiles(roots) {
  const files = [];
  const pending = [...roots];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      if (entry.isFile() && SESSION_FILE_PATTERN.test(entry.name)) files.push(target);
    }
  }
  return files;
}

function isToolCall(payload = {}) {
  const type = String(payload.type || '');
  return type === 'function_call' || type === 'custom_tool_call' ||
    (type.endsWith('_tool_call') && !type.endsWith('_tool_call_output'));
}

function extractToolInput(payload = {}) {
  const values = [payload.input, payload.arguments, payload.params].filter((value) => value != null);
  return values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n');
}

function extractSkillPaths(value = '') {
  const input = String(value);
  const windowsMatches = [...input.matchAll(WINDOWS_SKILL_PATH)];
  const posixMatches = [...input.matchAll(POSIX_SKILL_PATH)].filter((match) => {
    const prefix = input.slice(Math.max(0, match.index - 2), match.index);
    return !/^[A-Za-z]:$/.test(prefix);
  });
  const matches = [...windowsMatches, ...posixMatches];
  return [...new Set(matches.map((match) => normalizeFilePath(match[0])).filter(Boolean))];
}

/**
 * 只保留 SKILL.md 的路径与时间戳，其余内容立即丢弃。
 * 先做字符串预筛（不含 response_item 或 SKILL.md 的行直接跳过）再 JSON.parse，避免无谓开销。
 */
function parseSessionContent(content, fallbackSessionId = '') {
  const events = [];
  for (const line of String(content).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!line.includes('SKILL.md') || !line.includes('response_item')) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.type !== 'response_item' || !isToolCall(item.payload)) continue;
    const skillPaths = extractSkillPaths(extractToolInput(item.payload));
    if (!skillPaths.length) continue;
    const timestamp = new Date(item.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;
    for (const skillPath of skillPaths) {
      events.push({ skillPath, timestamp: timestamp.toISOString(), sessionId: fallbackSessionId });
    }
  }
  return events;
}

async function readCache(cachePath) {
  if (!cachePath) return { version: CACHE_VERSION, files: {} };
  try {
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (cache.version === CACHE_VERSION && cache.files && typeof cache.files === 'object') return cache;
  } catch {
    // 首次运行、缓存损坏或旧版本缓存都直接重建。
  }
  return { version: CACHE_VERSION, files: {} };
}

async function writeCache(cachePath, cache) {
  if (!cachePath) return;
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache), 'utf8');
}

function localDayKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function createDailySeries(days, now) {
  const values = [];
  const today = startOfDay(now);
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - index);
    values.push({ date: localDayKey(date), count: 0 });
  }
  return values;
}

/** 按 SKILL.md 的逻辑路径把事件归到 Skill 上 */
function aggregateUsage(skills, events, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const today = startOfDay(now);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 6);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 29);

  const statsByPath = new Map(skills.map((skill) => [
    normalizeFilePath(path.join(skill.directoryPath, 'SKILL.md')),
    { total: 0, last7: 0, last30: 0, lastUsedAt: null, sessionIds: new Set() }
  ]));
  const daily = new Map(createDailySeries(30, now).map((item) => [item.date, item]));

  for (const event of events) {
    const stats = statsByPath.get(normalizeFilePath(event.skillPath));
    if (!stats) continue;
    const timestamp = new Date(event.timestamp);
    if (Number.isNaN(timestamp.getTime()) || timestamp > now) continue;
    stats.total += 1;
    if (timestamp >= sevenDaysAgo) stats.last7 += 1;
    if (timestamp >= thirtyDaysAgo) {
      stats.last30 += 1;
      const day = daily.get(localDayKey(timestamp));
      if (day) day.count += 1;
    }
    if (!stats.lastUsedAt || timestamp > new Date(stats.lastUsedAt)) stats.lastUsedAt = timestamp.toISOString();
    if (event.sessionId) stats.sessionIds.add(event.sessionId);
  }

  const enrichedSkills = skills.map((skill) => {
    const stats = statsByPath.get(normalizeFilePath(path.join(skill.directoryPath, 'SKILL.md')));
    const usage = stats || { total: 0, last7: 0, last30: 0, lastUsedAt: null, sessionIds: new Set() };
    return {
      ...skill,
      usage: {
        total: usage.total,
        last7: usage.last7,
        last30: usage.last30,
        lastUsedAt: usage.lastUsedAt,
        sessions: usage.sessionIds.size,
        // 口径必须诚实：这是"被引用"，不是"被调用"（见模块头注释）
        event: 'referenced'
      }
    };
  });

  const usedSkills = enrichedSkills.filter((skill) => skill.usage.total > 0);
  const topSkills = [...usedSkills]
    .sort((a, b) => b.usage.total - a.usage.total || String(a.name).localeCompare(String(b.name), 'zh-CN'))
    .slice(0, 10)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      platform: skill.platform,
      total: skill.usage.total,
      last30: skill.usage.last30,
      lastUsedAt: skill.usage.lastUsedAt
    }));

  return {
    skills: enrichedSkills,
    summary: {
      totalUses: enrichedSkills.reduce((sum, skill) => sum + skill.usage.total, 0),
      last30: enrichedSkills.reduce((sum, skill) => sum + skill.usage.last30, 0),
      usedSkills: usedSkills.length,
      unusedSkills: enrichedSkills.length - usedSkills.length,
      topSkill: topSkills[0] || null
    },
    daily: [...daily.values()],
    topSkills
  };
}

async function scanCodexUsage(skills, options = {}) {
  const roots = options.sessionRoots || getCodexSessionRoots(options.homeDirectory);
  const files = await listSessionFiles(roots);
  const previousCache = await readCache(options.cachePath);
  const nextCache = { version: CACHE_VERSION, files: {} };
  const errors = [];
  let refreshedFiles = 0;

  for (const file of files) {
    const cacheKey = normalizeFilePath(file);
    try {
      const stat = await fs.stat(file);
      const cached = previousCache.files[cacheKey];
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        nextCache.files[cacheKey] = cached;
        continue;
      }
      const content = await fs.readFile(file, 'utf8');
      nextCache.files[cacheKey] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        events: parseSessionContent(content, path.basename(file, path.extname(file)))
      };
      refreshedFiles += 1;
    } catch (error) {
      errors.push({ path: file, message: error.message });
    }
  }

  try {
    await writeCache(options.cachePath, nextCache);
  } catch (error) {
    errors.push({ path: options.cachePath, message: error.message });
  }

  const events = Object.values(nextCache.files).flatMap((item) => item.events || []);
  const aggregated = aggregateUsage(skills, events, { now: options.now });
  return {
    ...aggregated,
    meta: {
      source: 'Codex 本地会话日志',
      // referenced 是 invoked 的弱代理；没有可靠 invoked 来源时不得声称已测得调用
      event: 'referenced',
      eventReliability: 'proxy',
      note: '读取该 Skill 的 SKILL.md 被工具调用引用的次数；Codex 不记录技能实际调用，勿当作使用频率',
      sessionFiles: files.length,
      refreshedFiles,
      cachedFiles: files.length - refreshedFiles,
      scannedAt: new Date().toISOString(),
      errors
    }
  };
}

module.exports = {
  aggregateUsage,
  extractSkillPaths,
  getCodexSessionRoots,
  normalizeFilePath,
  parseSessionContent,
  scanCodexUsage
};
