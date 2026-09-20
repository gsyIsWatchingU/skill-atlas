'use strict';

/**
 * 云同步客户端：桌面端直连 GPU 上的 Skill Packer Web API。
 *
 * 后端协议（与 src/web-server.js 保持一致）：
 *  - POST /api/auth/login {email, password} -> Set-Cookie: skill_atlas_session=<token>
 *  - POST /api/auth/logout（带会话）
 *  - GET  /api/skills?scope=mine|community
 *  - POST /api/skills  {skill:{name,description,platform}, visibility, files:[{path,contentBase64}]}
 *  - GET  /api/skills/:id  -> {skill, files:[{path,contentBase64}]}
 *  - PATCH /api/skills/:id {visibility}
 *
 * 桌面端不维护 cookie jar：手动从 Set-Cookie 取出 token 存到 userData/cloud-auth.json，
 * 之后每个请求带上 `Cookie: skill_atlas_session=<token>`。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const scanner = require('./scanner');

const DEFAULT_API_BASE = 'https://gsy-gpu.tail660bdf.ts.net:8443';
const SESSION_COOKIE = 'skill_atlas_session';

function authFilePath() {
  return path.join(app.getPath('userData'), 'cloud-auth.json');
}

async function readAuth() {
  try {
    const raw = JSON.parse(await fs.readFile(authFilePath(), 'utf8'));
    if (raw && typeof raw.token === 'string' && raw.token) return raw;
  } catch {
    /* 未登录或文件损坏 */
  }
  return null;
}

async function writeAuth(auth) {
  await fs.writeFile(authFilePath(), JSON.stringify(auth, null, 2), 'utf8');
}

async function clearAuth() {
  await fs.rm(authFilePath(), { force: true }).catch(() => {});
}

async function callApi(pathname, { method = 'GET', body, auth } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && auth.token) {
    headers.Cookie = `${SESSION_COOKIE}=${encodeURIComponent(auth.token)}`;
  }
  const response = await fetch(`${DEFAULT_API_BASE}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error((data && data.error) || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function tokenFromSetCookie(setCookie) {
  if (!setCookie) return null;
  const combined = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
  const match = combined.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function login({ email, password }) {
  const response = await fetch(`${DEFAULT_API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `登录失败 (${response.status})`);
  const token = tokenFromSetCookie(response.headers.get('set-cookie'));
  if (!token) throw new Error('登录响应未返回会话，请检查服务端');
  const auth = { token, user: data.user || null, savedAt: new Date().toISOString() };
  await writeAuth(auth);
  return auth;
}

async function logout() {
  const auth = await readAuth();
  if (auth && auth.token) {
    try {
      await callApi('/api/auth/logout', { method: 'POST', auth });
    } catch {
      /* 网络失败也清本地 */
    }
  }
  await clearAuth();
}

/** 返回当前登录用户；401 视为已登出并清理本地会话。 */
async function currentUser() {
  const auth = await readAuth();
  if (!auth || !auth.token) return null;
  try {
    await callApi('/api/skills?scope=mine', { auth });
  } catch (error) {
    if (error.status === 401) {
      await clearAuth();
      return null;
    }
    // 网络不可达：仍保留本地会话，让 UI 可展示已登录身份。
  }
  return auth.user || null;
}

async function listCloud(scope) {
  const auth = await readAuth();
  if (!auth || !auth.token) throw new Error('未登录');
  const data = await callApi(`/api/skills?scope=${encodeURIComponent(scope)}`, { auth });
  return data.skills || [];
}

async function uploadLocalSkill({ skill, directoryPath, visibility }) {
  const auth = await readAuth();
  if (!auth || !auth.token) throw new Error('未登录');
  const result = { files: [], sizeBytes: 0, skippedSensitive: 0 };
  await scanner.collectDirectoryFiles(
    directoryPath, '', 0, result, scanner.createLinkState([], true)
  );
  if (!result.files.length) throw new Error('该 Skill 没有可上传的文件');
  const name = (skill && skill.name) || path.basename(directoryPath);
  const files = result.files.map((file) => ({
    path: file.path,
    contentBase64: file.content.toString('base64')
  }));
  const data = await callApi('/api/skills', {
    method: 'POST',
    auth,
    body: {
      skill: {
        name,
        description: (skill && skill.description) || '',
        platform: (skill && skill.platform) || 'shared'
      },
      visibility: visibility === 'community' ? 'community' : 'private',
      files
    }
  });
  return data.skill;
}

async function downloadCloudSkill({ id, targetDir }) {
  const auth = await readAuth();
  if (!auth || !auth.token) throw new Error('未登录');
  const data = await callApi(`/api/skills/${encodeURIComponent(id)}`, { auth });
  const folderName = (data.skill && data.skill.folderName) || data.id;
  const destination = path.join(targetDir, folderName);
  await fs.mkdir(destination, { recursive: true });
  for (const file of data.files || []) {
    const full = path.join(destination, file.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(file.contentBase64, 'base64'));
  }
  return destination;
}

async function setVisibility({ id, visibility }) {
  const auth = await readAuth();
  if (!auth || !auth.token) throw new Error('未登录');
  const data = await callApi(`/api/skills/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    auth,
    body: { visibility: visibility === 'community' ? 'community' : 'private' }
  });
  return data.skill;
}

module.exports = {
  DEFAULT_API_BASE,
  login,
  logout,
  currentUser,
  listCloud,
  uploadLocalSkill,
  downloadCloudSkill,
  setVisibility
};
