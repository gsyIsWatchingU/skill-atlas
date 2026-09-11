const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createHash,
  randomBytes,
  timingSafeEqual
} = require('node:crypto');
const { Pool } = require('pg');

const MAX_REQUEST_BYTES = 28 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_FILES = 1000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_COOKIE = 'skill_atlas_session';
const SSO_STATE_COOKIE = 'skill_atlas_sso_state';
const WEB_ROOT = path.join(__dirname, 'web');
const ASSET_ROOT = path.join(__dirname, '..', 'assets');
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizePackagePath(value) {
  if (typeof value !== 'string') throw new Error('文件路径无效');
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (
    !normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`不安全的文件路径：${value}`);
  }
  return normalized;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('文件内容不是有效的 Base64');
  }
  const buffer = Buffer.from(value, 'base64');
  const normalizedInput = value.replace(/=+$/, '');
  if (buffer.toString('base64').replace(/=+$/, '') !== normalizedInput) {
    throw new Error('文件内容不是有效的 Base64');
  }
  return buffer;
}

function computeVersionHash(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(decodeBase64(file.contentBase64));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'skill';
}

function validatePackage(input) {
  if (!input || typeof input !== 'object') throw new Error('Skill 包无效');
  const name = String(input.skill?.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Skill 缺少名称');
  if (!Array.isArray(input.files) || !input.files.length) throw new Error('Skill 包没有文件');
  if (input.files.length > MAX_PACKAGE_FILES) throw new Error(`Skill 文件数不能超过 ${MAX_PACKAGE_FILES}`);

  let sizeBytes = 0;
  const seen = new Set();
  const files = input.files.map((item) => {
    const filePath = normalizePackagePath(item.path);
    const normalizedPath = filePath.toLocaleLowerCase('en-US');
    if (seen.has(normalizedPath)) throw new Error(`Skill 包存在重复文件：${filePath}`);
    seen.add(normalizedPath);
    const buffer = decodeBase64(item.contentBase64);
    sizeBytes += buffer.length;
    return { path: filePath, contentBase64: buffer.toString('base64') };
  });

  if (!seen.has('skill.md')) throw new Error('Skill 包根目录缺少 SKILL.md');
  if (sizeBytes > MAX_PACKAGE_BYTES) throw new Error('Skill 包不能超过 20 MB');

  const normalizedName = name.normalize('NFKC').toLocaleLowerCase('en-US');
  const idSuffix = createHash('sha256').update(normalizedName).digest('hex').slice(0, 10);
  const id = `${slugify(name)}-${idSuffix}`;
  const versionHash = computeVersionHash(files);
  const updatedAt = new Date().toISOString();
  const skill = {
    name,
    description: String(input.skill?.description || '').trim().slice(0, 500),
    platform: String(input.skill?.platform || 'shared').trim().slice(0, 40),
    folderName: slugify(input.skill?.folderName || name),
    ownership: 'personal'
  };

  return {
    package: { schemaVersion: 1, id, versionHash, updatedAt, skill, files },
    metadata: {
      id,
      ...skill,
      versionHash,
      updatedAt,
      fileCount: files.length,
      sizeBytes
    }
  };
}

function validateVisibility(value) {
  if (value !== 'private' && value !== 'community') {
    throw httpError('可见性必须是私有或社区', 400);
  }
  return value;
}

function tokensMatch(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ''));
  const actualBuffer = Buffer.from(String(actual || ''));
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(request) {
  const cookies = {};
  for (const part of String(request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      cookies[name] = '';
    }
  }
  return cookies;
}

function appendCookie(response, cookie) {
  const existing = response.getHeader('Set-Cookie');
  if (!existing) response.setHeader('Set-Cookie', cookie);
  else response.setHeader('Set-Cookie', Array.isArray(existing) ? existing.concat(cookie) : [existing, cookie]);
}

function setHttpOnlyCookie(request, response, name, value, maxAge) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || Boolean(request.socket.encrypted);
  appendCookie(response, [
    `${name}=${value ? encodeURIComponent(value) : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Max-Age=${maxAge}`
  ].filter(Boolean).join('; '));
}

function setSessionCookie(request, response, token, maxAge = SESSION_MAX_AGE_SECONDS) {
  setHttpOnlyCookie(request, response, SESSION_COOKIE, token, maxAge);
}

function ensureSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    if (new URL(origin).host !== request.headers.host) throw new Error('origin mismatch');
  } catch {
    throw httpError('请求来源无效', 403);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw httpError('请求体不能超过 28 MB', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError('JSON 格式无效', 400);
  }
}

function createRateLimiter(limit = 20, windowMs = 15 * 60 * 1000) {
  const entries = new Map();
  return function consume(request, action) {
    const ip = String(
      request.headers['cf-connecting-ip'] ||
      request.headers['x-forwarded-for'] ||
      request.socket.remoteAddress || 'unknown'
    ).split(',')[0].trim();
    const key = `${action}:${ip}`;
    const now = Date.now();
    const current = entries.get(key);
    if (!current || current.resetAt <= now) {
      entries.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    if (entries.size > 1000) {
      for (const [entryKey, entry] of entries) {
        if (entry.resetAt <= now) entries.delete(entryKey);
      }
    }
    return current.count <= limit;
  };
}

function createPgRepository(databaseUrl) {
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const schemaSql = [
    'CREATE TABLE IF NOT EXISTS skill_users (',
    '  id TEXT PRIMARY KEY,',
    '  email TEXT NOT NULL,',
    '  display_name TEXT NOT NULL,',
    '  image_url TEXT,',
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
    '  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    ');',
    'CREATE TABLE IF NOT EXISTS skill_sessions (',
    '  token_hash CHAR(64) PRIMARY KEY,',
    '  user_id TEXT NOT NULL REFERENCES skill_users(id) ON DELETE CASCADE,',
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
    '  expires_at TIMESTAMPTZ NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS skill_sso_login_states (',
    '  state_hash CHAR(64) PRIMARY KEY,',
    '  code_verifier TEXT NOT NULL,',
    '  redirect_uri TEXT NOT NULL,',
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
    '  expires_at TIMESTAMPTZ NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS skills (',
    '  id TEXT PRIMARY KEY,',
    '  normalized_name TEXT NOT NULL,',
    '  name TEXT NOT NULL,',
    '  description TEXT NOT NULL DEFAULT \'\',',
    '  platform TEXT NOT NULL DEFAULT \'shared\',',
    '  folder_name TEXT NOT NULL,',
    '  ownership TEXT NOT NULL DEFAULT \'personal\',',
    '  owner_id TEXT REFERENCES skill_users(id) ON DELETE CASCADE,',
    '  visibility TEXT NOT NULL DEFAULT \'private\',',
    '  latest_version_hash CHAR(64) NOT NULL,',
    '  updated_at TIMESTAMPTZ NOT NULL',
    ');',
    'ALTER TABLE skills ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES skill_users(id) ON DELETE CASCADE;',
    'ALTER TABLE skills ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT \'private\';',
    'ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_normalized_name_key;',
    'CREATE TABLE IF NOT EXISTS skill_versions (',
    '  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,',
    '  version_hash CHAR(64) NOT NULL,',
    '  created_at TIMESTAMPTZ NOT NULL,',
    '  file_count INTEGER NOT NULL,',
    '  size_bytes INTEGER NOT NULL,',
    '  PRIMARY KEY (skill_id, version_hash)',
    ');',
    'CREATE TABLE IF NOT EXISTS skill_files (',
    '  skill_id TEXT NOT NULL,',
    '  version_hash CHAR(64) NOT NULL,',
    '  path TEXT NOT NULL,',
    '  content BYTEA NOT NULL,',
    '  PRIMARY KEY (skill_id, version_hash, path),',
    '  FOREIGN KEY (skill_id, version_hash)',
    '    REFERENCES skill_versions(skill_id, version_hash) ON DELETE CASCADE',
    ');',
    'CREATE UNIQUE INDEX IF NOT EXISTS skills_owner_name_idx',
    '  ON skills(owner_id, normalized_name) WHERE owner_id IS NOT NULL;',
    'CREATE INDEX IF NOT EXISTS skills_community_idx',
    '  ON skills(updated_at DESC) WHERE visibility = \'community\';',
    'CREATE INDEX IF NOT EXISTS skill_sessions_expires_at_idx ON skill_sessions(expires_at);',
    'CREATE INDEX IF NOT EXISTS skill_sso_login_states_expires_at_idx ON skill_sso_login_states(expires_at);',
    'CREATE INDEX IF NOT EXISTS skill_versions_created_at_idx',
    '  ON skill_versions(created_at DESC);'
  ].join('\n');
  const initialized = pool.query(schemaSql);

  function userFromRow(row) {
    return row ? {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      image: row.image_url || null
    } : null;
  }

  function mapMetadata(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      platform: row.platform,
      folderName: row.folder_name,
      ownership: row.ownership,
      visibility: row.visibility,
      authorName: row.author_name,
      isOwner: Boolean(row.is_owner),
      versionHash: row.latest_version_hash.trim(),
      updatedAt: new Date(row.updated_at).toISOString(),
      fileCount: Number(row.file_count),
      sizeBytes: Number(row.size_bytes),
      versionCount: Number(row.version_count)
    };
  }

  const metadataSelect = [
    'SELECT s.*, u.display_name AS author_name, v.file_count, v.size_bytes,',
    '  (SELECT COUNT(*) FROM skill_versions all_versions',
    '   WHERE all_versions.skill_id = s.id)::INTEGER AS version_count'
  ].join('\n');
  const metadataJoin = [
    'FROM skills s',
    'JOIN skill_users u ON u.id = s.owner_id',
    'JOIN skill_versions v ON v.skill_id = s.id',
    '  AND v.version_hash = s.latest_version_hash'
  ].join('\n');

  async function health() {
    await initialized;
    await pool.query('SELECT 1');
    return true;
  }

  async function upsertSsoUser(user) {
    await initialized;
    const result = await pool.query([
      'INSERT INTO skill_users (id, email, display_name, image_url)',
      'VALUES ($1, $2, $3, $4)',
      'ON CONFLICT (id) DO UPDATE SET',
      '  email = EXCLUDED.email,',
      '  display_name = EXCLUDED.display_name,',
      '  image_url = EXCLUDED.image_url,',
      '  updated_at = NOW()',
      'RETURNING id, email, display_name, image_url'
    ].join('\n'), [user.id, user.email, user.displayName, user.image || null]);
    return userFromRow(result.rows[0]);
  }

  async function createSsoLoginState(stateHash, codeVerifier, redirectUri, expiresAt) {
    await initialized;
    await pool.query('DELETE FROM skill_sso_login_states WHERE expires_at <= NOW()');
    await pool.query([
      'INSERT INTO skill_sso_login_states (state_hash, code_verifier, redirect_uri, expires_at)',
      'VALUES ($1, $2, $3, $4)'
    ].join('\n'), [stateHash, codeVerifier, redirectUri, expiresAt]);
  }

  async function consumeSsoLoginState(stateHash) {
    await initialized;
    const result = await pool.query([
      'DELETE FROM skill_sso_login_states',
      'WHERE state_hash = $1 AND expires_at > NOW()',
      'RETURNING code_verifier, redirect_uri'
    ].join('\n'), [stateHash]);
    if (!result.rows[0]) return null;
    return {
      codeVerifier: result.rows[0].code_verifier,
      redirectUri: result.rows[0].redirect_uri
    };
  }

  async function createSession(userId, sessionToken, expiresAt) {
    await initialized;
    await pool.query('DELETE FROM skill_sessions WHERE expires_at <= NOW()');
    await pool.query(
      'INSERT INTO skill_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [tokenHash(sessionToken), userId, expiresAt]
    );
  }

  async function findSession(sessionTokenHash) {
    await initialized;
    const result = await pool.query([
      'SELECT u.id, u.email, u.display_name, u.image_url',
      'FROM skill_sessions s JOIN skill_users u ON u.id = s.user_id',
      'WHERE s.token_hash = $1 AND s.expires_at > NOW()'
    ].join('\n'), [sessionTokenHash]);
    return userFromRow(result.rows[0]);
  }

  async function deleteSession(sessionTokenHash) {
    await initialized;
    await pool.query('DELETE FROM skill_sessions WHERE token_hash = $1', [sessionTokenHash]);
  }

  async function claimLegacy(userId) {
    await initialized;
    const result = await pool.query([
      'UPDATE skills orphan SET owner_id = $1, visibility = \'private\'',
      'WHERE orphan.owner_id IS NULL',
      '  AND NOT EXISTS (',
      '    SELECT 1 FROM skills owned',
      '    WHERE owned.owner_id = $1 AND owned.normalized_name = orphan.normalized_name',
      '  )'
    ].join('\n'), [userId]);
    return result.rowCount;
  }

  async function listMine(userId) {
    await initialized;
    const result = await pool.query([
      `${metadataSelect}, TRUE AS is_owner`,
      metadataJoin,
      'WHERE s.owner_id = $1',
      'ORDER BY s.updated_at DESC, s.name'
    ].join('\n'), [userId]);
    return result.rows.map(mapMetadata);
  }

  async function listCommunity(userId) {
    await initialized;
    const result = await pool.query([
      `${metadataSelect}, s.owner_id = $1 AS is_owner`,
      metadataJoin,
      'WHERE s.visibility = \'community\'',
      'ORDER BY s.updated_at DESC, s.name'
    ].join('\n'), [userId || null]);
    return result.rows.map(mapMetadata);
  }

  async function save(user, validated, visibility) {
    await initialized;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const metadata = validated.metadata;
      const normalizedName = metadata.name.normalize('NFKC').toLocaleLowerCase('en-US');
      const existing = await client.query(
        'SELECT id FROM skills WHERE owner_id = $1 AND normalized_name = $2 FOR UPDATE',
        [user.id, normalizedName]
      );
      const generatedId = `${slugify(metadata.name)}-${createHash('sha256')
        .update(`${user.id}\0${normalizedName}`)
        .digest('hex').slice(0, 12)}`;
      const id = existing.rows[0]?.id || generatedId;
      await client.query([
        'INSERT INTO skills (',
        '  id, normalized_name, name, description, platform, folder_name, ownership,',
        '  owner_id, visibility, latest_version_hash, updated_at',
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        'ON CONFLICT (id) DO UPDATE SET',
        '  name = EXCLUDED.name,',
        '  description = EXCLUDED.description,',
        '  platform = EXCLUDED.platform,',
        '  folder_name = EXCLUDED.folder_name,',
        '  ownership = EXCLUDED.ownership,',
        '  visibility = EXCLUDED.visibility,',
        '  latest_version_hash = EXCLUDED.latest_version_hash,',
        '  updated_at = EXCLUDED.updated_at'
      ].join('\n'), [
        id,
        normalizedName,
        metadata.name,
        metadata.description,
        metadata.platform,
        metadata.folderName,
        metadata.ownership,
        user.id,
        visibility,
        metadata.versionHash,
        metadata.updatedAt
      ]);
      await client.query([
        'INSERT INTO skill_versions',
        '  (skill_id, version_hash, created_at, file_count, size_bytes)',
        'VALUES ($1, $2, $3, $4, $5)',
        'ON CONFLICT (skill_id, version_hash) DO NOTHING'
      ].join('\n'), [
        id,
        metadata.versionHash,
        metadata.updatedAt,
        metadata.fileCount,
        metadata.sizeBytes
      ]);
      for (const file of validated.package.files) {
        await client.query([
          'INSERT INTO skill_files (skill_id, version_hash, path, content)',
          'VALUES ($1, $2, $3, $4)',
          'ON CONFLICT (skill_id, version_hash, path) DO NOTHING'
        ].join('\n'), [id, metadata.versionHash, file.path, decodeBase64(file.contentBase64)]);
      }
      const countResult = await client.query(
        'SELECT COUNT(*)::INTEGER AS count FROM skill_versions WHERE skill_id = $1',
        [id]
      );
      await client.query('COMMIT');
      return {
        ...metadata,
        id,
        visibility,
        authorName: user.displayName,
        isOwner: true,
        versionCount: Number(countResult.rows[0].count)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function get(id, userId) {
    await initialized;
    const metadataResult = await pool.query([
      `${metadataSelect}, s.owner_id = $2 AS is_owner`,
      metadataJoin,
      'WHERE s.id = $1 AND (s.visibility = \'community\' OR s.owner_id = $2)'
    ].join('\n'), [id, userId || null]);
    if (!metadataResult.rows[0]) return null;
    const metadata = mapMetadata(metadataResult.rows[0]);
    const filesResult = await pool.query([
      'SELECT path, content FROM skill_files',
      'WHERE skill_id = $1 AND version_hash = $2',
      'ORDER BY path'
    ].join('\n'), [metadata.id, metadata.versionHash]);
    return {
      schemaVersion: 1,
      id: metadata.id,
      versionHash: metadata.versionHash,
      updatedAt: metadata.updatedAt,
      visibility: metadata.visibility,
      skill: {
        name: metadata.name,
        description: metadata.description,
        platform: metadata.platform,
        folderName: metadata.folderName,
        ownership: metadata.ownership,
        authorName: metadata.authorName
      },
      files: filesResult.rows.map((file) => ({
        path: file.path,
        contentBase64: file.content.toString('base64')
      }))
    };
  }

  async function updateVisibility(id, userId, visibility) {
    await initialized;
    const result = await pool.query(
      'UPDATE skills SET visibility = $3, updated_at = NOW() WHERE id = $1 AND owner_id = $2',
      [id, userId, visibility]
    );
    if (!result.rowCount) return null;
    const mine = await listMine(userId);
    return mine.find((skill) => skill.id === id) || null;
  }

  async function remove(id, userId) {
    await initialized;
    const result = await pool.query('DELETE FROM skills WHERE id = $1 AND owner_id = $2', [id, userId]);
    return result.rowCount > 0;
  }

  async function close() {
    await pool.end();
  }

  return {
    claimLegacy,
    close,
    createSession,
    createSsoLoginState,
    consumeSsoLoginState,
    deleteSession,
    findSession,
    get,
    health,
    listCommunity,
    listMine,
    remove,
    save,
    updateVisibility,
    upsertSsoUser
  };
}

async function serveStatic(response, pathname) {
  const isBrandIcon = pathname === '/icon.svg';
  const root = isBrandIcon ? ASSET_ROOT : WEB_ROOT;
  const relative = pathname === '/' ? 'index.html' : isBrandIcon ? 'icon.svg' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    json(response, 404, { error: '页面不存在' });
    return;
  }
  try {
    const content = await fs.readFile(resolved);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': path.extname(resolved) === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      json(response, 404, { error: '页面不存在' });
      return;
    }
    throw error;
  }
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

function normalizeSsoUser(payload) {
  const source = payload?.user;
  const id = String(source?.id || '').trim().slice(0, 200);
  const email = String(source?.email || '').trim().toLocaleLowerCase('en-US').slice(0, 254);
  const displayName = String(source?.name || email.split('@')[0] || 'Skill 用户')
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 40);
  if (!id || !email || !displayName) throw httpError('统一账号返回的数据无效', 502);
  let image = null;
  if (source.image) {
    try {
      const imageUrl = new URL(String(source.image));
      if (imageUrl.protocol === 'https:' || imageUrl.protocol === 'http:') image = imageUrl.toString().slice(0, 1000);
    } catch {
      image = null;
    }
  }
  return { id, email, displayName, image };
}

async function requestSsoUser(ssoBaseUrl, payload) {
  const endpoint = new URL('/api/sso/token', ssoBaseUrl).toString();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(result.error || '统一账号登录失败', 502);
  return normalizeSsoUser(result);
}

function createSkillAtlasServer(options = {}) {
  const migrationToken = options.migrationToken ?? process.env.SKILL_ATLAS_TOKEN ?? '';
  const ssoAuthBaseUrl = options.ssoAuthBaseUrl ?? process.env.SSO_AUTH_BASE_URL ?? '';
  const publicUrl = options.publicUrl ?? process.env.PUBLIC_URL ?? '';
  const exchangeSsoCode = options.exchangeSsoCode || requestSsoUser;
  const ssoClientId = 'skill-dock';
  const repository = options.repository || createPgRepository(options.databaseUrl ?? process.env.DATABASE_URL);
  const consumeAuthAttempt = createRateLimiter();

  function ssoSettings() {
    if (!ssoAuthBaseUrl || !publicUrl) throw httpError('统一账号登录尚未配置', 503);
    let base;
    let callback;
    try {
      base = new URL(ssoAuthBaseUrl);
      callback = new URL('/auth/sso/callback', publicUrl);
    } catch {
      throw httpError('统一账号地址配置无效', 500);
    }
    return { base, redirectUri: callback.toString() };
  }

  async function getRequestUser(request) {
    if (Object.hasOwn(request, 'skillAtlasUser')) return request.skillAtlasUser;
    const sessionToken = parseCookies(request)[SESSION_COOKIE];
    request.skillAtlasSessionToken = sessionToken || '';
    request.skillAtlasUser = sessionToken ? await repository.findSession(tokenHash(sessionToken)) : null;
    return request.skillAtlasUser;
  }

  async function requireUser(request) {
    const user = await getRequestUser(request);
    if (!user) throw httpError('请先登录', 401);
    return user;
  }

  async function issueSession(request, response, user) {
    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
    await repository.createSession(user.id, sessionToken, expiresAt);
    setSessionCookie(request, response, sessionToken);
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        await repository.health();
        json(response, 200, {
          ok: true,
          database: true,
          auth: 'sso',
          ssoConfigured: Boolean(ssoAuthBaseUrl && publicUrl)
        });
        return;
      }

      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        json(response, 200, { user: await getRequestUser(request) });
        return;
      }

      if (url.pathname === '/api/auth/login' && request.method === 'GET') {
        if (!consumeAuthAttempt(request, 'sso-login')) throw httpError('登录过于频繁，请稍后再试', 429);
        const settings = ssoSettings();
        const state = randomBytes(32).toString('base64url');
        const codeVerifier = randomBytes(32).toString('base64url');
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
        await repository.createSsoLoginState(
          tokenHash(state),
          codeVerifier,
          settings.redirectUri,
          new Date(Date.now() + 10 * 60 * 1000)
        );
        setHttpOnlyCookie(request, response, SSO_STATE_COOKIE, state, 10 * 60);
        const authorizeUrl = new URL('/api/sso/authorize', settings.base);
        authorizeUrl.searchParams.set('client_id', ssoClientId);
        authorizeUrl.searchParams.set('redirect_uri', settings.redirectUri);
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('code_challenge', codeChallenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        redirect(response, authorizeUrl.toString());
        return;
      }

      if (url.pathname === '/auth/sso/callback' && request.method === 'GET') {
        const settings = ssoSettings();
        if (url.searchParams.get('error')) {
          redirect(response, new URL('/?auth_error=cancelled', publicUrl).toString());
          return;
        }
        const code = String(url.searchParams.get('code') || '');
        const state = String(url.searchParams.get('state') || '');
        if (!code || !state) throw httpError('统一账号回调参数缺失', 400);
        const browserState = parseCookies(request)[SSO_STATE_COOKIE];
        if (!browserState || !tokensMatch(browserState, state)) {
          throw httpError('登录请求与当前浏览器不匹配', 400);
        }
        const loginState = await repository.consumeSsoLoginState(tokenHash(state));
        if (!loginState || loginState.redirectUri !== settings.redirectUri) {
          throw httpError('登录状态已过期，请重新登录', 400);
        }
        const ssoUser = await exchangeSsoCode(settings.base.toString(), {
          code,
          clientId: ssoClientId,
          redirectUri: settings.redirectUri,
          codeVerifier: loginState.codeVerifier
        });
        const user = await repository.upsertSsoUser(ssoUser);
        await issueSession(request, response, user);
        setHttpOnlyCookie(request, response, SSO_STATE_COOKIE, '', 0);
        redirect(response, new URL('/', publicUrl).toString());
        return;
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        ensureSameOrigin(request);
        const sessionToken = parseCookies(request)[SESSION_COOKIE];
        if (sessionToken) await repository.deleteSession(tokenHash(sessionToken));
        setSessionCookie(request, response, '', 0);
        json(response, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/auth/claim-legacy' && request.method === 'POST') {
        ensureSameOrigin(request);
        const user = await requireUser(request);
        const input = await readJsonBody(request);
        if (!migrationToken || !tokensMatch(migrationToken, input.legacyToken)) {
          throw httpError('旧访问令牌无效', 403);
        }
        json(response, 200, { claimedLegacyCount: await repository.claimLegacy(user.id) });
        return;
      }

      if (url.pathname === '/api/skills' && request.method === 'GET') {
        const scope = url.searchParams.get('scope') || 'community';
        const user = await getRequestUser(request);
        if (scope === 'community') {
          json(response, 200, { skills: await repository.listCommunity(user?.id) });
          return;
        }
        if (scope === 'mine') {
          if (!user) throw httpError('请先登录', 401);
          json(response, 200, { skills: await repository.listMine(user.id) });
          return;
        }
        throw httpError('Skill 范围无效', 400);
      }

      if (url.pathname === '/api/skills' && request.method === 'POST') {
        ensureSameOrigin(request);
        const user = await requireUser(request);
        const input = await readJsonBody(request);
        let validated;
        try {
          validated = validatePackage(input);
        } catch (error) {
          error.statusCode = error.statusCode || 400;
          throw error;
        }
        const metadata = await repository.save(user, validated, validateVisibility(input.visibility));
        json(response, 201, { skill: metadata });
        return;
      }

      const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch) {
        const skillId = decodeURIComponent(skillMatch[1]);
        if (request.method === 'GET') {
          const user = await getRequestUser(request);
          const skillPackage = await repository.get(skillId, user?.id);
          if (!skillPackage) throw httpError('Skill 不存在或无权访问', 404);
          json(response, 200, skillPackage);
          return;
        }
        if (request.method === 'PATCH') {
          ensureSameOrigin(request);
          const user = await requireUser(request);
          const input = await readJsonBody(request);
          const skill = await repository.updateVisibility(skillId, user.id, validateVisibility(input.visibility));
          if (!skill) throw httpError('Skill 不存在或无权操作', 404);
          json(response, 200, { skill });
          return;
        }
        if (request.method === 'DELETE') {
          ensureSameOrigin(request);
          const user = await requireUser(request);
          if (!await repository.remove(skillId, user.id)) throw httpError('Skill 不存在或无权操作', 404);
          json(response, 200, { ok: true });
          return;
        }
      }

      if (url.pathname.startsWith('/api/')) {
        json(response, 404, { error: '接口不存在' });
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        json(response, 405, { error: '请求方法不支持' });
        return;
      }
      await serveStatic(response, url.pathname);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(error);
      json(response, statusCode, { error: statusCode >= 500 ? '服务器错误' : error.message });
    }
  });
  server.repository = repository;
  return server;
}

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const server = createSkillAtlasServer();
  server.repository.health()
    .then(() => {
      server.listen(port, host, () => {
        console.log(`Skill Dock Web 已启动：http://${host}:${port}`);
      });
    })
    .catch((error) => {
      console.error(`数据库连接失败：${error.message}`);
      process.exitCode = 1;
    });

  const shutdown = async () => {
    server.close();
    await server.repository.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  computeVersionHash,
  createPgRepository,
  createSkillAtlasServer,
  normalizePackagePath,
  validatePackage
};
