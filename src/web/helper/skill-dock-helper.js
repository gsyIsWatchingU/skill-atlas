'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} = require('node:crypto');

const HELPER_VERSION = '0.1.0';
const DEFAULT_PORT = 18787;
const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 1000;
const MAX_SCAN_DEPTH = 12;
const SKIP_DIRECTORIES = new Set(['.git', '.svn', 'node_modules', '__pycache__', 'dist', 'build', 'coverage']);
const DEFAULT_WEB_URL = 'https://gsy-gpu.tail660bdf.ts.net:8443/';
const DEFAULT_ROOTS = [
  {
    id: 'codex-user',
    label: 'Codex 个人 Skill',
    displayPath: '%USERPROFILE%\\.codex\\skills',
    segments: ['.codex', 'skills']
  },
  {
    id: 'shared-agents',
    label: '跨 Agent 共享 Skill',
    displayPath: '%USERPROFILE%\\.agents\\skills',
    segments: ['.agents', 'skills']
  },
  {
    id: 'codex-plugins',
    label: 'Codex 插件 Skill',
    displayPath: '%USERPROFILE%\\.codex\\plugins\\cache',
    segments: ['.codex', 'plugins', 'cache']
  }
];

function parseFrontmatter(content, fallbackName) {
  const result = { name: fallbackName, description: '' };
  const normalized = String(content || '').replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return result;
  const lines = match[1].split(/\r?\n/);
  let currentKey = '';
  let block = [];

  function commitBlock() {
    if (currentKey && block.length) result[currentKey] = block.join(' ').trim();
    block = [];
  }

  for (const line of lines) {
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (pair) {
      commitBlock();
      currentKey = pair[1];
      const value = pair[2].replace(/^['"]|['"]$/g, '').trim();
      if (value && value !== '|' && value !== '>') result[currentKey] = value;
    } else if (currentKey && /^\s+/.test(line)) {
      block.push(line.trim());
    }
  }
  commitBlock();
  result.name = String(result.name || fallbackName).trim();
  result.description = String(result.description || '').trim();
  return result;
}

function shouldSkipFile(name) {
  const lower = name.toLocaleLowerCase('en-US');
  return lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower === 'credentials.json';
}

function isSystemPath(pathSegments) {
  return pathSegments.some((segment) => {
    const lower = segment.toLocaleLowerCase('en-US');
    return lower === '.system' || lower === 'openai-bundled' || lower === 'openai-primary-runtime';
  });
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function computeVersionHash(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => comparePath(a.path, b.path))) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

// 产品把 Skill 以符号链接 / junction 落进项目目录来实现隔离（见 docs/solution.md §5），
// 所以扫描器必须跟随链接，否则隔离做完当天就什么都扫不到。
// 跟随的前提是"跟随了什么、跳到哪去"完全可见，因此每类结果都要留记录，不能静默跳过。
const LINK_BUCKETS = ['followed', 'outsideRoot', 'broken', 'cycle', 'denied', 'notFollowed'];

function createLinkState(allowedRealRoots, followLinks) {
  const links = {};
  for (const bucket of LINK_BUCKETS) links[bucket] = [];
  return {
    followLinks: followLinks !== false,
    allowedRealRoots,
    visitedRealDirs: new Set(),
    // 入口遍历会先解析一次链接，文件收集随后还会碰到同一链接；同一个链接只应有一份结果。
    recordedLinks: new Set(),
    realpathCache: new Map(),
    links
  };
}

function recordLink(state, bucket, linkPath, target, error) {
  if (state.recordedLinks.has(linkPath)) return;
  state.recordedLinks.add(linkPath);
  state.links[bucket].push({ linkPath, target: target || '', error: error || '' });
}

// realpath 有成本，所以只在链接项上调用，并对同一路径缓存结果。
async function canonicalPath(filePath, state) {
  if (state.realpathCache.has(filePath)) return state.realpathCache.get(filePath);
  let resolved;
  try {
    resolved = await fs.realpath(filePath);
  } catch (error) {
    resolved = { error: error.code || 'EIO' };
  }
  state.realpathCache.set(filePath, resolved);
  return resolved;
}

// 判断目标是否落在任一扫描根内。不能用 startsWith——/project 会误判成 /project-secret。
function findContainingRoot(state, targetReal) {
  return state.allowedRealRoots.find((rootReal) => {
    const relative = path.relative(rootReal, targetReal);
    if (relative === '') return true;
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }) || null;
}

async function markDirectoryVisited(directoryPath, state) {
  const resolved = await canonicalPath(directoryPath, state);
  if (typeof resolved === 'string') state.visitedRealDirs.add(resolved);
}

// 返回 'directory' | 'file'；无法安全处理时返回 null，原因已记入 state.links。
async function resolveEntryLink(absolutePath, state) {
  if (!state.followLinks) {
    recordLink(state, 'notFollowed', absolutePath);
    return null;
  }

  const resolved = await canonicalPath(absolutePath, state);
  if (typeof resolved !== 'string') {
    recordLink(state, 'broken', absolutePath, '', resolved.error);
    return null;
  }

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    recordLink(state, 'denied', absolutePath, resolved, error.code || 'EACCES');
    return null;
  }

  if (!stat.isDirectory() && !stat.isFile()) return null;

  // 成环要先于记账：目标已经在遍历里出现过的话，这次不会真的进去，
  // 若先记成 followed，报告里的"跟随数"就会包含一个并没有跟随的链接。
  if (stat.isDirectory() && state.visitedRealDirs.has(resolved)) {
    recordLink(state, 'cycle', absolutePath, resolved);
    return null;
  }

  if (findContainingRoot(state, resolved)) {
    recordLink(state, 'followed', absolutePath, resolved);
  } else {
    // 隔离场景天然跳出扫描根（项目 -> 中央 Skill 仓库），所以这里是"记下来"而不是"拒绝"。
    recordLink(state, 'outsideRoot', absolutePath, resolved);
  }

  return stat.isDirectory() ? 'directory' : 'file';
}

async function collectDirectoryFiles(directoryPath, prefix, depth, result, state) {
  if (depth > MAX_SCAN_DEPTH) return;
  const linkState = state || createLinkState([], true);
  await markDirectoryVisited(directoryPath, linkState);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((a, b) => comparePath(a.name, b.name));

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    const lowerName = entry.name.toLocaleLowerCase('en-US');
    let kind;

    if (entry.isSymbolicLink()) {
      // 目录链接包含 Windows junction：两者在 readdir 里都报 isSymbolicLink。
      kind = await resolveEntryLink(absolutePath, linkState);
      if (!kind) continue;
    } else if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(lowerName)) continue;
      kind = 'directory';
    } else if (entry.isFile()) {
      kind = 'file';
    } else {
      continue;
    }

    if (kind === 'directory') {
      await collectDirectoryFiles(absolutePath, `${prefix}${entry.name}/`, depth + 1, result, linkState);
      continue;
    }

    if (shouldSkipFile(entry.name)) {
      result.skippedSensitive += 1;
      continue;
    }
    // 哈希与上传都用逻辑路径：同一个 Skill 通过不同链接路径被发现时结果必须一致。
    let content;
    try {
      content = await fs.readFile(absolutePath);
    } catch (error) {
      recordLink(linkState, 'denied', absolutePath, '', error.code || 'EACCES');
      continue;
    }
    result.sizeBytes += content.length;
    if (result.sizeBytes > MAX_SKILL_BYTES) throw new Error('单个 Skill 不能超过 20 MB');
    result.files.push({ path: `${prefix}${entry.name}`, content });
    if (result.files.length > MAX_SKILL_FILES) throw new Error('单个 Skill 文件数不能超过 1000');
  }
}

async function createLocalSkill(directoryPath, root, relativeSegments, token, state) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const skillEntry = entries.find((entry) => (
    entry.isFile() && entry.name.toLocaleLowerCase('en-US') === 'skill.md'
  ));
  if (!skillEntry) return null;

  const skillFile = await fs.readFile(path.join(directoryPath, skillEntry.name), 'utf8');
  const metadata = parseFrontmatter(skillFile, path.basename(directoryPath));
  const collected = { files: [], sizeBytes: 0, skippedSensitive: 0 };
  await collectDirectoryFiles(directoryPath, '', 0, collected, state);
  const helperSkillId = createHmac('sha256', token)
    .update(path.resolve(directoryPath).toLocaleLowerCase('en-US'))
    .digest('hex');
  return {
    helperSkillId,
    name: metadata.name,
    description: metadata.description || '暂无描述',
    folderName: path.basename(directoryPath),
    platform: 'shared',
    source: root.label,
    scanDirectoryId: root.id,
    ownership: root.id === 'codex-plugins' || isSystemPath(relativeSegments) ? 'system' : 'personal',
    versionHash: computeVersionHash(collected.files),
    fileCount: collected.files.length,
    sizeBytes: collected.sizeBytes,
    skippedSensitive: collected.skippedSensitive,
    directoryPath,
    files: collected.files
  };
}

async function walkForSkills(directoryPath, root, relativeSegments, depth, token, output, state) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') return;
    throw error;
  }
  await markDirectoryVisited(directoryPath, state);

  if (entries.some((entry) => entry.isFile() && entry.name.toLocaleLowerCase('en-US') === 'skill.md')) {
    const skill = await createLocalSkill(directoryPath, root, relativeSegments, token, state);
    if (skill) output.push(skill);
  }

  entries.sort((a, b) => comparePath(a.name, b.name));
  for (const entry of entries) {
    const lowerName = entry.name.toLocaleLowerCase('en-US');
    if (SKIP_DIRECTORIES.has(lowerName)) continue;
    if (entry.isSymbolicLink()) {
      // 隔离场景正是"整个 Skill 目录都是链接"，这里必须跟进去。
      if (await resolveEntryLink(path.join(directoryPath, entry.name), state) !== 'directory') continue;
    } else if (!entry.isDirectory()) {
      continue;
    }
    await walkForSkills(
      path.join(directoryPath, entry.name),
      root,
      relativeSegments.concat(entry.name),
      depth + 1,
      token,
      output,
      state
    );
  }
}

function resolveRoots(homeDirectory, roots = DEFAULT_ROOTS) {
  return roots.map((root) => ({
    ...root,
    absolutePath: root.absolutePath || path.join(homeDirectory, ...(root.segments || []))
  }));
}

function emptyLinkBuckets() {
  const links = {};
  for (const bucket of LINK_BUCKETS) links[bucket] = [];
  return links;
}

function summarizeLinks(links) {
  const summary = {};
  for (const bucket of LINK_BUCKETS) summary[bucket] = (links[bucket] || []).length;
  return summary;
}

async function scanRoots(options = {}) {
  const token = options.token || 'test-token';
  const followLinks = options.followLinks !== false;
  const roots = resolveRoots(options.homeDirectory || os.homedir(), options.roots);
  const skills = [];
  const rootResults = [];
  const links = emptyLinkBuckets();

  // 允许跨越扫描根之间互相引用：一个根里的链接指向另一个扫描根属于正常用法。
  const allowedRealRoots = [];
  for (const root of roots) {
    const resolved = await fs.realpath(root.absolutePath).catch(() => null);
    if (resolved) allowedRealRoots.push(resolved);
  }

  for (const root of roots) {
    // 每个根各自一套 visited：两个不同的根链到同一目标时，算两个 Skill 实例（作用域不同）。
    const state = createLinkState(allowedRealRoots, followLinks);
    try {
      const stat = await fs.stat(root.absolutePath);
      if (!stat.isDirectory()) throw Object.assign(new Error('不是目录'), { code: 'ENOTDIR' });
      const rootSkills = [];
      await walkForSkills(root.absolutePath, root, [], 0, token, rootSkills, state);
      skills.push(...rootSkills);
      rootResults.push({
        id: root.id,
        label: root.label,
        path: root.displayPath,
        status: 'ready',
        skillCount: rootSkills.length,
        followedLinks: state.links.followed.length
      });
    } catch (error) {
      const missing = error.code === 'ENOENT';
      rootResults.push({
        id: root.id,
        label: root.label,
        path: root.displayPath,
        status: missing ? 'missing' : 'error',
        skillCount: 0,
        followedLinks: 0,
        error: missing ? '目录不存在' : '目录无法读取'
      });
    }
    for (const bucket of LINK_BUCKETS) links[bucket].push(...state.links[bucket]);
  }

  return { roots: rootResults, skills, links, followLinks };
}

function safeEqual(expected, actual) {
  const left = Buffer.from(String(expected || ''), 'utf8');
  const right = Buffer.from(String(actual || ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function writeJson(response, statusCode, payload, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(payload));
}

function createHelperServer(options = {}) {
  const token = options.token || randomBytes(32).toString('base64url');
  const webUrl = new URL(options.webUrl || DEFAULT_WEB_URL);
  const allowedOrigins = new Set(options.allowedOrigins || [
    webUrl.origin,
    'http://127.0.0.1:8787',
    'http://localhost:8787'
  ]);
  let indexedSkills = new Map();

  return http.createServer(async (request, response) => {
    const origin = String(request.headers.origin || '');
    if (origin && !allowedOrigins.has(origin)) {
      writeJson(response, 403, { error: '网页来源未授权' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600'
      });
      response.end();
      return;
    }

    if (!safeEqual(token, bearerToken(request))) {
      writeJson(response, 401, { error: '本地助手配对令牌无效' }, origin);
      return;
    }

    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        writeJson(response, 200, {
          ok: true,
          name: 'Skill Dock Helper',
          version: HELPER_VERSION,
          readOnly: true
        }, origin);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/scan') {
        const result = await scanRoots({
          token,
          homeDirectory: options.homeDirectory,
          roots: options.roots
        });
        indexedSkills = new Map(result.skills.map((skill) => [skill.helperSkillId, skill]));
        writeJson(response, 200, {
          roots: result.roots,
          skills: result.skills.map(({ directoryPath, files, ...skill }) => skill),
          // 只给计数，不给路径：本机目录布局没有必要离开这台机器。详细清单只有本地 CLI 才输出。
          links: summarizeLinks(result.links)
        }, origin);
        return;
      }

      const packageMatch = url.pathname.match(/^\/v1\/skills\/([a-f0-9]{64})\/package$/);
      if (request.method === 'GET' && packageMatch) {
        const skill = indexedSkills.get(packageMatch[1]);
        if (!skill) {
          writeJson(response, 404, { error: '请先重新扫描本机 Skill' }, origin);
          return;
        }
        const refreshed = await createLocalSkill(
          skill.directoryPath,
          { id: skill.scanDirectoryId, label: skill.source },
          skill.ownership === 'system' ? ['.system'] : [],
          token
        );
        writeJson(response, 200, {
          schemaVersion: 1,
          skill: {
            name: refreshed.name,
            description: refreshed.description,
            platform: refreshed.platform,
            folderName: refreshed.folderName
          },
          files: refreshed.files.map((file) => ({
            path: file.path,
            contentBase64: file.content.toString('base64')
          }))
        }, origin);
        return;
      }

      writeJson(response, 404, { error: '接口不存在' }, origin);
    } catch (error) {
      writeJson(response, 500, { error: error.message || '本地助手执行失败' }, origin);
    }
  });
}

async function loadOrCreateToken() {
  const stateRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'SkillDockHelper')
    : path.join(os.homedir(), '.skill-dock-helper');
  const tokenPath = path.join(stateRoot, 'pairing-token');
  await fs.mkdir(stateRoot, { recursive: true });
  try {
    const saved = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(saved)) return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = randomBytes(32).toString('base64url');
  await fs.writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

function openPairedPage(webUrl, token) {
  const target = new URL(webUrl);
  target.hash = new URLSearchParams({ helper: token }).toString();
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target.toString()], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

async function start() {
  if (process.platform !== 'win32') {
    throw new Error('当前试用版仅支持 Windows');
  }
  const port = Number(process.env.SKILL_DOCK_HELPER_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地助手端口无效');
  const webUrl = process.env.SKILL_DOCK_URL || DEFAULT_WEB_URL;
  const token = await loadOrCreateToken();
  const server = createHelperServer({ token, webUrl });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用；如果助手已运行，请回到浏览器刷新。`);
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Skill Dock 助手已启动：只读扫描，监听 127.0.0.1:${port}`);
    console.log('保持此窗口开启；关闭窗口即可停止助手。');
    openPairedPage(webUrl, token);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ROOTS,
  HELPER_VERSION,
  computeVersionHash,
  createHelperServer,
  createLinkState,
  parseFrontmatter,
  resolveEntryLink,
  scanRoots,
  shouldSkipFile,
  summarizeLinks
};
