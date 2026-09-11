const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { Pool } = require('pg');

const MAX_REQUEST_BYTES = 28 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_PACKAGE_FILES = 1000;
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
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
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
    if (seen.has(filePath.toLocaleLowerCase('en-US'))) throw new Error(`Skill 包存在重复文件：${filePath}`);
    seen.add(filePath.toLocaleLowerCase('en-US'));
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

function tokensMatch(expected, actual) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function isAuthorized(request, accessToken) {
  if (!accessToken) return true;
  const header = request.headers.authorization || '';
  return header.startsWith('Bearer ') && tokensMatch(accessToken, header.slice(7));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('请求体不能超过 28 MB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 格式无效'), { statusCode: 400 });
  }
}


function createPgRepository(databaseUrl) {
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const schemaSql = [
    'CREATE TABLE IF NOT EXISTS skills (',
    '  id TEXT PRIMARY KEY,',
    '  normalized_name TEXT UNIQUE NOT NULL,',
    '  name TEXT NOT NULL,',
    '  description TEXT NOT NULL DEFAULT \'\',',
    '  platform TEXT NOT NULL DEFAULT \'shared\',',
    '  folder_name TEXT NOT NULL,',
    '  ownership TEXT NOT NULL DEFAULT \'personal\',',
    '  latest_version_hash CHAR(64) NOT NULL,',
    '  updated_at TIMESTAMPTZ NOT NULL',
    ');',
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
    'CREATE INDEX IF NOT EXISTS skill_versions_created_at_idx',
    '  ON skill_versions(created_at DESC);'
  ].join('\n');
  const initialized = pool.query(schemaSql);

  function mapMetadata(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      platform: row.platform,
      folderName: row.folder_name,
      ownership: row.ownership,
      versionHash: row.latest_version_hash.trim(),
      updatedAt: new Date(row.updated_at).toISOString(),
      fileCount: Number(row.file_count),
      sizeBytes: Number(row.size_bytes),
      versionCount: Number(row.version_count)
    };
  }

  async function health() {
    await initialized;
    await pool.query('SELECT 1');
    return true;
  }

  async function list() {
    await initialized;
    const result = await pool.query([
      'SELECT s.*, v.file_count, v.size_bytes,',
      '  (SELECT COUNT(*) FROM skill_versions all_versions',
      '   WHERE all_versions.skill_id = s.id)::INTEGER AS version_count',
      'FROM skills s',
      'JOIN skill_versions v ON v.skill_id = s.id',
      '  AND v.version_hash = s.latest_version_hash',
      'ORDER BY s.name'
    ].join('\n'));
    return result.rows.map(mapMetadata);
  }

  async function save(validated) {
    await initialized;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const metadata = validated.metadata;
      const normalizedName = metadata.name.normalize('NFKC').toLocaleLowerCase('en-US');
      await client.query([
        'INSERT INTO skills (',
        '  id, normalized_name, name, description, platform, folder_name,',
        '  ownership, latest_version_hash, updated_at',
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        'ON CONFLICT (id) DO UPDATE SET',
        '  normalized_name = EXCLUDED.normalized_name,',
        '  name = EXCLUDED.name,',
        '  description = EXCLUDED.description,',
        '  platform = EXCLUDED.platform,',
        '  folder_name = EXCLUDED.folder_name,',
        '  ownership = EXCLUDED.ownership,',
        '  latest_version_hash = EXCLUDED.latest_version_hash,',
        '  updated_at = EXCLUDED.updated_at'
      ].join('\n'), [
        metadata.id,
        normalizedName,
        metadata.name,
        metadata.description,
        metadata.platform,
        metadata.folderName,
        metadata.ownership,
        metadata.versionHash,
        metadata.updatedAt
      ]);
      await client.query([
        'INSERT INTO skill_versions',
        '  (skill_id, version_hash, created_at, file_count, size_bytes)',
        'VALUES ($1, $2, $3, $4, $5)',
        'ON CONFLICT (skill_id, version_hash) DO NOTHING'
      ].join('\n'), [
        metadata.id,
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
        ].join('\n'), [
          metadata.id,
          metadata.versionHash,
          file.path,
          decodeBase64(file.contentBase64)
        ]);
      }
      const countResult = await client.query(
        'SELECT COUNT(*)::INTEGER AS count FROM skill_versions WHERE skill_id = $1',
        [metadata.id]
      );
      await client.query('COMMIT');
      return { ...metadata, versionCount: Number(countResult.rows[0].count) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function get(id) {
    await initialized;
    const metadataResult = await pool.query([
      'SELECT s.*, v.file_count, v.size_bytes,',
      '  (SELECT COUNT(*) FROM skill_versions all_versions',
      '   WHERE all_versions.skill_id = s.id)::INTEGER AS version_count',
      'FROM skills s',
      'JOIN skill_versions v ON v.skill_id = s.id',
      '  AND v.version_hash = s.latest_version_hash',
      'WHERE s.id = $1'
    ].join('\n'), [id]);
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
      skill: {
        name: metadata.name,
        description: metadata.description,
        platform: metadata.platform,
        folderName: metadata.folderName,
        ownership: metadata.ownership
      },
      files: filesResult.rows.map((file) => ({
        path: file.path,
        contentBase64: file.content.toString('base64')
      }))
    };
  }

  async function close() {
    await pool.end();
  }

  return { close, health, list, save, get };
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
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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

function createSkillAtlasServer(options = {}) {
  const accessToken = options.accessToken ?? process.env.SKILL_ATLAS_TOKEN ?? '';
  if (process.env.NODE_ENV === 'production' && !accessToken) {
    throw new Error('生产环境必须设置 SKILL_ATLAS_TOKEN');
  }
  const repository = options.repository || createPgRepository(options.databaseUrl ?? process.env.DATABASE_URL);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        await repository.health();
        json(response, 200, { ok: true, database: true, protected: Boolean(accessToken) });
        return;
      }

      if (url.pathname.startsWith('/api/skills')) {
        if (!isAuthorized(request, accessToken)) {
          json(response, 401, { error: '访问令牌无效' });
          return;
        }
        if (url.pathname === '/api/skills' && request.method === 'GET') {
          json(response, 200, { skills: await repository.list() });
          return;
        }
        if (url.pathname === '/api/skills' && request.method === 'POST') {
          let validated;
          try {
            validated = validatePackage(await readJsonBody(request));
          } catch (error) {
            error.statusCode = error.statusCode || 400;
            throw error;
          }
          const metadata = await repository.save(validated);
          json(response, 201, { skill: metadata });
          return;
        }
        const match = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
        if (match && request.method === 'GET') {
          const skillPackage = await repository.get(decodeURIComponent(match[1]));
          if (!skillPackage) {
            json(response, 404, { error: 'Skill 不存在' });
            return;
          }
          json(response, 200, skillPackage);
          return;
        }
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
      json(response, statusCode, {
        error: statusCode >= 500 ? '服务器错误' : error.message
      });
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
        if (!process.env.SKILL_ATLAS_TOKEN) console.warn('警告：未设置 SKILL_ATLAS_TOKEN，当前仓库未受保护。');
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
