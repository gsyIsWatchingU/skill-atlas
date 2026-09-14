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

async function collectDirectoryFiles(directoryPath, prefix, depth, result) {
  if (depth > MAX_SCAN_DEPTH) return;
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((a, b) => comparePath(a.name, b.name));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))) {
        await collectDirectoryFiles(absolutePath, `${prefix}${entry.name}/`, depth + 1, result);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (shouldSkipFile(entry.name)) {
      result.skippedSensitive += 1;
      continue;
    }
    const content = await fs.readFile(absolutePath);
    result.sizeBytes += content.length;
    if (result.sizeBytes > MAX_SKILL_BYTES) throw new Error('单个 Skill 不能超过 20 MB');
    result.files.push({ path: `${prefix}${entry.name}`, content });
    if (result.files.length > MAX_SKILL_FILES) throw new Error('单个 Skill 文件数不能超过 1000');
  }
}

async function createLocalSkill(directoryPath, root, relativeSegments, token) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const skillEntry = entries.find((entry) => (
    entry.isFile() && entry.name.toLocaleLowerCase('en-US') === 'skill.md'
  ));
  if (!skillEntry) return null;

  const skillFile = await fs.readFile(path.join(directoryPath, skillEntry.name), 'utf8');
  const metadata = parseFrontmatter(skillFile, path.basename(directoryPath));
  const collected = { files: [], sizeBytes: 0, skippedSensitive: 0 };
  await collectDirectoryFiles(directoryPath, '', 0, collected);
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

async function walkForSkills(directoryPath, root, relativeSegments, depth, token, output) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') return;
    throw error;
  }

  if (entries.some((entry) => entry.isFile() && entry.name.toLocaleLowerCase('en-US') === 'skill.md')) {
    const skill = await createLocalSkill(directoryPath, root, relativeSegments, token);
    if (skill) output.push(skill);
  }

  entries.sort((a, b) => comparePath(a.name, b.name));
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      !SKIP_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))
    ) {
      await walkForSkills(
        path.join(directoryPath, entry.name),
        root,
        relativeSegments.concat(entry.name),
        depth + 1,
        token,
        output
      );
    }
  }
}

function resolveRoots(homeDirectory, roots = DEFAULT_ROOTS) {
  return roots.map((root) => ({
    ...root,
    absolutePath: root.absolutePath || path.join(homeDirectory, ...(root.segments || []))
  }));
}

async function scanRoots(options = {}) {
  const token = options.token || 'test-token';
  const roots = resolveRoots(options.homeDirectory || os.homedir(), options.roots);
  const skills = [];
  const rootResults = [];

  for (const root of roots) {
    try {
      const stat = await fs.stat(root.absolutePath);
      if (!stat.isDirectory()) throw Object.assign(new Error('不是目录'), { code: 'ENOTDIR' });
      const rootSkills = [];
      await walkForSkills(root.absolutePath, root, [], 0, token, rootSkills);
      skills.push(...rootSkills);
      rootResults.push({
        id: root.id,
        label: root.label,
        path: root.displayPath,
        status: 'ready',
        skillCount: rootSkills.length
      });
    } catch (error) {
      const missing = error.code === 'ENOENT';
      rootResults.push({
        id: root.id,
        label: root.label,
        path: root.displayPath,
        status: missing ? 'missing' : 'error',
        skillCount: 0,
        error: missing ? '目录不存在' : '目录无法读取'
      });
    }
  }

  return { roots: rootResults, skills };
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
          skills: result.skills.map(({ directoryPath, files, ...skill }) => skill)
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
  parseFrontmatter,
  scanRoots,
  shouldSkipFile
};
