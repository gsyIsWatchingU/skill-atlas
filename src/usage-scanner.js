const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const CACHE_VERSION = 1;
const SESSION_FILE_PATTERN = /\.jsonl$/i;
const WINDOWS_SKILL_PATH = /[A-Za-z]:(?:\\+|\/)[^'"`\r\n]*?SKILL\.md/gi;
const POSIX_SKILL_PATH = /\/(?:[^'"`\r\n]+\/)*SKILL\.md/gi;

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
  return values.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');
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

function parseSessionContent(content, fallbackSessionId = '') {
  const events = [];
  const sessionId = fallbackSessionId;
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
      events.push({ skillPath, timestamp: timestamp.toISOString(), sessionId });
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

function aggregateUsage(skills, events, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const today = startOfDay(now);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 6);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 29);
  const statsByPath = new Map(skills.map((skill) => [normalizeFilePath(skill.filePath), {
    total: 0,
    last7: 0,
    last30: 0,
    lastUsedAt: null,
    sessionIds: new Set()
  }]));
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
    const stats = statsByPath.get(normalizeFilePath(skill.filePath));
    return {
      ...skill,
      usage: {
        total: stats.total,
        last7: stats.last7,
        last30: stats.last30,
        lastUsedAt: stats.lastUsedAt,
        sessions: stats.sessionIds.size
      }
    };
  });
  const usedSkills = enrichedSkills.filter((skill) => skill.usage.total > 0);
  const topSkills = [...usedSkills]
    .sort((a, b) => b.usage.total - a.usage.total || a.name.localeCompare(b.name, 'zh-CN'))
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
