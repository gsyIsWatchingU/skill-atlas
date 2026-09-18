'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createHmac,
  randomBytes,
  timingSafeEqual
} = require('node:crypto');

// 扫描逻辑收敛到共享内核（src/scanner），CLI 与桌面宿主共用同一份实现。
const scanner = require('../../scanner');

const HELPER_VERSION = '0.1.0';
const DEFAULT_PORT = 18787;
const DEFAULT_WEB_URL = 'https://gsy-gpu.tail660bdf.ts.net:8443/';
const DEFAULT_ROOTS = scanner.DEFAULT_ROOTS;

const parseFrontmatter = scanner.parseFrontmatter;
const shouldSkipFile = scanner.shouldSkipFile;
const computeVersionHash = scanner.computeVersionHash;
const LINK_BUCKETS = scanner.LINK_BUCKETS;
const summarizeLinks = scanner.summarizeLinks;

/** helper 独有的技能 id：用配对令牌做 HMAC，保证 id 不离开本机时也可复现 */
function helperSkillIdFor(directoryPath, token) {
  return createHmac('sha256', token)
    .update(path.resolve(directoryPath).toLocaleLowerCase('en-US'))
    .digest('hex');
}

/** 给共享内核的结果补上 helper 侧的 helperSkillId */
function decorateSkills(skills, token) {
  return skills.map((skill) => ({
    ...skill,
    helperSkillId: helperSkillIdFor(skill.directoryPath, token)
  }));
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
        const result = await scanner.scanRoots({
          homeDirectory: options.homeDirectory,
          roots: options.roots
        });
        const skills = decorateSkills(result.skills, token);
        indexedSkills = new Map(skills.map((skill) => [skill.helperSkillId, skill]));
        writeJson(response, 200, {
          roots: result.roots,
          scannerVersion: result.scannerVersion,
          skills: skills.map(({ directoryPath, files, ...skill }) => skill),
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
        const refreshed = await scanner.readSkill(
          skill.directoryPath,
          { id: skill.scanDirectoryId, label: skill.source, platform: skill.platform, scope: skill.scope },
          skill.ownership === 'system' ? ['.system'] : [],
          { includeFiles: true }
        );
        if (!refreshed || !refreshed.files) {
          writeJson(response, 404, { error: 'Skill 目录已不可读' }, origin);
          return;
        }
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
  createHelperServer,
  // 扫描相关导出转发到共享内核，保持既有调用方（含 test/helper.test.js）不变。
  computeVersionHash: scanner.computeVersionHash,
  createLinkState: scanner.createLinkState,
  parseFrontmatter: scanner.parseFrontmatter,
  resolveEntryLink: scanner.resolveEntryLink,
  scanRoots: scanner.scanRoots,
  shouldSkipFile: scanner.shouldSkipFile,
  summarizeLinks: scanner.summarizeLinks
};

