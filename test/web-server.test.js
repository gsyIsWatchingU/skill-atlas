const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  computeVersionHash,
  createSkillAtlasServer,
  validatePackage
} = require('../src/web-server');

function createPackage(name = 'demo-skill', visibility = 'private') {
  return {
    schemaVersion: 1,
    visibility,
    skill: {
      name,
      description: '用于测试的 Skill',
      folderName: name,
      platform: 'codex'
    },
    files: [
      {
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: ' + name + '\ndescription: demo\n---\n').toString('base64')
      },
      {
        path: 'scripts/run.js',
        contentBase64: Buffer.from('console.log("ok");\n').toString('base64')
      }
    ]
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createMemoryRepository() {
  const users = new Map();
  const sessions = new Map();
  const loginStates = new Map();
  const skills = new Map();
  const packages = new Map();

  return {
    async health() {},
    async upsertSsoUser(user) {
      users.set(user.id, user);
      return user;
    },
    async createSsoLoginState(stateHash, codeVerifier, redirectUri) {
      loginStates.set(stateHash, { codeVerifier, redirectUri });
    },
    async consumeSsoLoginState(stateHash) {
      const value = loginStates.get(stateHash) || null;
      loginStates.delete(stateHash);
      return value;
    },
    async createSession(userId, sessionToken) {
      sessions.set(sha256(sessionToken), userId);
    },
    async findSession(sessionTokenHash) {
      return users.get(sessions.get(sessionTokenHash)) || null;
    },
    async deleteSession(sessionTokenHash) {
      sessions.delete(sessionTokenHash);
    },
    async claimLegacy() {
      return 0;
    },
    async listMine(userId) {
      return [...skills.values()].filter((skill) => skill.ownerId === userId);
    },
    async listCommunity(userId) {
      return [...skills.values()]
        .filter((skill) => skill.visibility === 'community')
        .map((skill) => ({ ...skill, isOwner: skill.ownerId === userId }));
    },
    async save(user, validated, visibility) {
      const existing = [...skills.values()].find((skill) => (
        skill.ownerId === user.id && skill.name.toLowerCase() === validated.metadata.name.toLowerCase()
      ));
      const id = existing?.id || user.id + '-' + validated.metadata.id;
      const versionCount = existing && existing.versionHash !== validated.metadata.versionHash
        ? existing.versionCount + 1
        : existing?.versionCount || 1;
      const metadata = {
        ...validated.metadata,
        id,
        ownerId: user.id,
        authorName: user.displayName,
        isOwner: true,
        visibility,
        versionCount
      };
      skills.set(id, metadata);
      packages.set(id, {
        ...validated.package,
        id,
        visibility,
        skill: {
          ...validated.package.skill,
          zhSummary: validated.metadata.zhSummary || '',
          authorName: user.displayName
        }
      });
      return metadata;
    },
    async get(id, userId) {
      const skill = skills.get(id);
      if (!skill || (skill.visibility !== 'community' && skill.ownerId !== userId)) return null;
      return packages.get(id);
    },
    async updateVisibility(id, userId, visibility) {
      const skill = skills.get(id);
      if (!skill || skill.ownerId !== userId) return null;
      skill.visibility = visibility;
      packages.get(id).visibility = visibility;
      return skill;
    },
    async remove(id, userId) {
      const skill = skills.get(id);
      if (!skill || skill.ownerId !== userId) return false;
      skills.delete(id);
      packages.delete(id);
      return true;
    },
    async close() {}
  };
}

async function login(baseUrl, user) {
  const start = await fetch(baseUrl + '/api/auth/login', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorizeUrl = new URL(start.headers.get('location'));
  assert.equal(authorizeUrl.pathname, '/api/sso/authorize');
  assert.equal(authorizeUrl.searchParams.get('client_id'), 'skill-dock');
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizeUrl.searchParams.get('code_challenge').length, 43);
  const state = authorizeUrl.searchParams.get('state');
  assert.ok(state.length >= 24 && state.length <= 200);
  const stateCookie = start.headers.get('set-cookie').split(';')[0];

  const callback = await fetch(
    baseUrl + '/auth/sso/callback?code=test-code&state=' + encodeURIComponent(state),
    { redirect: 'manual', headers: { Cookie: stateCookie } }
  );
  assert.equal(callback.status, 302);
  const sessionCookie = callback.headers.get('set-cookie').match(/skill_atlas_session=[^;,]+/);
  assert.ok(sessionCookie);
  return sessionCookie[0];
}

test('计算稳定版本并拒绝不安全路径', () => {
  const payload = createPackage();
  const first = validatePackage(payload);
  const second = validatePackage(payload);
  assert.equal(first.metadata.versionHash, second.metadata.versionHash);
  assert.equal(computeVersionHash(first.package.files), first.metadata.versionHash);

  payload.files.push({
    path: '../token.txt',
    contentBase64: Buffer.from('secret').toString('base64')
  });
  assert.throws(() => validatePackage(payload), /不安全的文件路径/);
});

test('公网页面提供可校验的命令行脚本与本地自测入口', async (t) => {
  const repository = createMemoryRepository();
  const server = createSkillAtlasServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
  });

  const onDisk = await fs.readFile(path.join(__dirname, '..', 'bin', 'skill-dock.js'));

  const info = await fetch(baseUrl + '/api/cli/info').then((response) => response.json());
  assert.equal(info.cli.available, true);
  assert.equal(info.cli.sizeBytes, onDisk.length);
  assert.equal(info.cli.sha256, sha256(onDisk));
  assert.match(info.cli.version, /^\d+\.\d+\.\d+$/);

  const script = await fetch(baseUrl + '/cli/skill-dock.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/plain/);
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(sha256(Buffer.from(await script.arrayBuffer())), info.cli.sha256);

  const rejected = await fetch(baseUrl + '/cli/skill-dock.js', { method: 'POST' });
  assert.ok([403, 405].includes(rejected.status), '命令行脚本不接受写入请求');

  const page = await fetch(baseUrl + '/scan/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /不用装任何东西/);

  const pageWithoutSlash = await fetch(baseUrl + '/scan');
  assert.equal(pageWithoutSlash.status, 200);
  assert.match(pageWithoutSlash.headers.get('content-type'), /text\/html/);

  assert.equal((await fetch(baseUrl + '/scan/scan.css')).status, 200);
  assert.equal((await fetch(baseUrl + '/scan/scan.js')).status, 200);
  assert.equal((await fetch(baseUrl + '/scan/missing.html')).status, 404);
});

test('首页引导下载桌面版，并保留本地助手作为可选入口', async (t) => {
  const repository = createMemoryRepository();
  const server = createSkillAtlasServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
  });

  const home = await fetch(baseUrl + '/');
  assert.equal(home.status, 200);
  // 本地助手（B 通道 CLI）仍可连接回环地址
  assert.match(home.headers.get('content-security-policy'), /http:\/\/127\.0\.0\.1:18787/);
  const homeHtml = await home.text();
  assert.match(homeHtml, /icon\.svg\?v=2\.3\.2/);

  // 首页主引导必须是桌面版下载，而不是"复制一条命令去跑脚本"
  assert.match(homeHtml, /id="download-desktop"[^>]*href="\/download"/);
  assert.match(homeHtml, /id="desktop-status" class="desktop-connection-status disconnected"[^>]*role="status"/);
  assert.doesNotMatch(homeHtml, /id="helper-command-text"/, '复制命令跑脚本的引导必须已移除');
  assert.doesNotMatch(homeHtml, /id="copy-helper-command"/, '复制命令按钮必须已移除');

  // 命令行脚本仍可下载（自动化/CI 入口）
  assert.equal((await fetch(baseUrl + '/helper/skill-dock-helper.js')).status, 200);

  const icon = await fetch(baseUrl + '/icon.svg');
  assert.equal(icon.status, 200);
  const iconSvg = await icon.text();
  assert.match(iconSvg, /x="78" y="78" width="868" height="868" rx="182" fill="#fff"/);
  assert.match(iconSvg, /translate\(225\.28 225\.28\) scale\(\.56\)/);
});

test('桌面安装包接口可用，未产出时优雅降级', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-desktop-dl-'));
  const outputDir = path.join(home, 'outputs');
  await fs.mkdir(outputDir, { recursive: true });
  // 用一个小文件冒充安装包，避免测试真的去读 90 MB
  await fs.writeFile(path.join(outputDir, 'Skill-Dock-Setup-2.2.0.exe'), 'fake installer\n', 'utf8');
  // 非 Setup 的 portable 单文件不应被选中
  await fs.writeFile(path.join(outputDir, 'Skill Dock 2.2.0.exe'), 'portable\n', 'utf8');

  const repository = createMemoryRepository();
  const server = createSkillAtlasServer({ repository, desktopOutputDir: outputDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const info = await fetch(baseUrl + '/api/desktop/info');
  assert.equal(info.status, 200);
  const payload = await info.json();
  assert.equal(payload.desktop.available, true);
  assert.equal(payload.desktop.fileName, 'Skill-Dock-Setup-2.2.0.exe');
  assert.match(payload.desktop.sha256, /^[0-9a-f]{64}$/);

  const download = await fetch(baseUrl + '/download/desktop');
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'fake installer\n');
  assert.match(download.headers.get('content-disposition') || '', /attachment/);
});

test('桌面安装包未产出时返回 404 与 available:false', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-desktop-none-'));
  const repository = createMemoryRepository();
  const server = createSkillAtlasServer({
    repository,
    desktopOutputDir: path.join(home, 'not-created')
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const info = await fetch(baseUrl + '/api/desktop/info');
  assert.equal(info.status, 200);
  assert.equal((await info.json()).desktop.available, false);
  assert.equal((await fetch(baseUrl + '/download/desktop')).status, 404);
});

test('站内邮箱表单调用统一账号服务并建立本站会话', async (t) => {
  const repository = createMemoryRepository();
  const calls = [];
  const server = createSkillAtlasServer({
    repository,
    ssoAuthBaseUrl: 'https://accounts.example.test',
    publicUrl: 'https://skills.example.test',
    callSsoApi: async (_baseUrl, action, payload) => {
      calls.push({ action, payload });
      if (action === 'register-code') return { message: '验证码已发送' };
      return {
        user: {
          id: 'shared-user',
          email: payload.email,
          name: payload.name || '共享用户',
          image: null
        }
      };
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const headers = { Origin: baseUrl, 'Content-Type': 'application/json' };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
  });

  const code = await fetch(baseUrl + '/api/auth/register-code', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: 'user@example.com' })
  });
  assert.equal(code.status, 200);

  const registration = await fetch(baseUrl + '/api/auth/register', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: 'user@example.com',
      password: 'password-123',
      code: '123456',
      name: ''
    })
  });
  assert.equal(registration.status, 201);
  assert.match(registration.headers.get('set-cookie'), /skill_atlas_session=/);
  assert.deepEqual(calls.map((item) => item.action), ['register-code', 'register']);
  assert.equal(calls[1].payload.clientId, 'skill-dock');
});

test('统一账号登录后按账号隔离私有 Skill，并公开社区 Skill', async (t) => {
  let pendingUser = null;
  const repository = createMemoryRepository();
  const server = createSkillAtlasServer({
    repository,
    migrationToken: 'legacy-token',
    ssoAuthBaseUrl: 'https://accounts.example.test',
    publicUrl: 'https://skills.example.test',
    exchangeSsoCode: async (_baseUrl, payload) => {
      assert.equal(payload.clientId, 'skill-dock');
      assert.equal(payload.redirectUri, 'https://skills.example.test/auth/sso/callback');
      assert.equal(payload.codeVerifier.length, 43);
      return pendingUser;
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
  });

  const health = await fetch(baseUrl + '/api/health').then((response) => response.json());
  assert.deepEqual(health, { ok: true, database: true, auth: 'sso', ssoConfigured: true });
  assert.equal((await fetch(baseUrl + '/api/skills?scope=mine')).status, 401);
  assert.deepEqual(
    await fetch(baseUrl + '/api/skills?scope=community').then((response) => response.json()),
    { skills: [] }
  );

  pendingUser = { id: 'user-a', email: 'a@example.test', displayName: '用户 A', image: null };
  const cookieA = await login(baseUrl, pendingUser);
  const ownerHeaders = { Cookie: cookieA, Origin: baseUrl, 'Content-Type': 'application/json' };
  const privateResponse = await fetch(baseUrl + '/api/skills', {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify(createPackage('private-skill', 'private'))
  });
  assert.equal(privateResponse.status, 201);
  const privateSkill = (await privateResponse.json()).skill;

  assert.equal(
    (await fetch(baseUrl + '/api/skills?scope=mine', { headers: { Cookie: cookieA } })
      .then((response) => response.json())).skills.length,
    1
  );
  assert.equal((await fetch(baseUrl + '/api/skills/' + privateSkill.id)).status, 404);
  assert.equal(
    (await fetch(baseUrl + '/api/skills?scope=community').then((response) => response.json())).skills.length,
    0
  );

  pendingUser = { id: 'user-b', email: 'b@example.test', displayName: '用户 B', image: null };
  const cookieB = await login(baseUrl, pendingUser);
  assert.equal(
    (await fetch(baseUrl + '/api/skills?scope=mine', { headers: { Cookie: cookieB } })
      .then((response) => response.json())).skills.length,
    0
  );
  assert.equal((await fetch(baseUrl + '/api/skills/' + privateSkill.id, {
    headers: { Cookie: cookieB }
  })).status, 404);

  const publish = await fetch(baseUrl + '/api/skills/' + privateSkill.id, {
    method: 'PATCH',
    headers: ownerHeaders,
    body: JSON.stringify({ visibility: 'community' })
  });
  assert.equal(publish.status, 200);
  assert.equal(
    (await fetch(baseUrl + '/api/skills?scope=community').then((response) => response.json())).skills.length,
    1
  );
  assert.equal((await fetch(baseUrl + '/api/skills/' + privateSkill.id)).status, 200);

  assert.equal((await fetch(baseUrl + '/api/skills/' + privateSkill.id, {
    method: 'DELETE',
    headers: { Cookie: cookieB, Origin: baseUrl }
  })).status, 404);
});

test('上传 Skill 时自动生成中文简介并随下载包返回', async (t) => {
  let pendingUser = null;
  const repository = createMemoryRepository();
  const server = createSkillAtlasServer({
    repository,
    ssoAuthBaseUrl: 'https://accounts.example.test',
    publicUrl: 'https://skills.example.test',
    exchangeSsoCode: async (_baseUrl, payload) => pendingUser
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
  });

  pendingUser = { id: 'user-zh', email: 'zh@example.test', displayName: '中文用户', image: null };
  const cookie = await login(baseUrl, pendingUser);
  const headers = { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' };

  // 未提供中文简介 → 服务端从英文描述自动生成
  const autoPackage = {
    schemaVersion: 1,
    visibility: 'community',
    skill: {
      name: 'create-spreadsheet-skill',
      description: 'Create a spreadsheet using a dashboard template for the user.',
      folderName: 'create-spreadsheet-skill',
      platform: 'codex'
    },
    files: [
      {
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: create-spreadsheet-skill\ndescription: Create a spreadsheet.\n---\n').toString('base64')
      }
    ]
  };
  const autoResponse = await fetch(baseUrl + '/api/skills', {
    method: 'POST',
    headers,
    body: JSON.stringify(autoPackage)
  });
  assert.equal(autoResponse.status, 201);
  const autoSkill = (await autoResponse.json()).skill;
  assert.ok(autoSkill.zhSummary, '缺少中文简介时服务端应自动生成');
  assert.match(autoSkill.zhSummary, /「create-spreadsheet-skill」技能/);
  assert.match(autoSkill.zhSummary, /创建/);
  assert.match(autoSkill.zhSummary, /表格/);

  // 已提供中文简介 → 原样保留
  const customPackage = createPackage('custom-zh-skill', 'private');
  customPackage.skill = { ...customPackage.skill, zhSummary: '自定义的中文简介内容' };
  const customResponse = await fetch(baseUrl + '/api/skills', {
    method: 'POST',
    headers,
    body: JSON.stringify(customPackage)
  });
  assert.equal(customResponse.status, 201);
  assert.equal((await customResponse.json()).skill.zhSummary, '自定义的中文简介内容');

  // 列表接口返回中文简介，且未登录也能下载社区 Skill（下载包）
  const mine = await fetch(baseUrl + '/api/skills?scope=mine', { headers: { Cookie: cookie } })
    .then((response) => response.json());
  const autoRow = mine.skills.find((skill) => skill.id === autoSkill.id);
  assert.equal(autoRow.zhSummary, autoSkill.zhSummary);
  const download = await fetch(baseUrl + '/api/skills/' + autoSkill.id);
  assert.equal(download.status, 200);
  const downloadPackage = await download.json();
  assert.equal(downloadPackage.skill.zhSummary, autoSkill.zhSummary);
  assert.ok(downloadPackage.files.length > 0, '下载包应包含 Skill 文件');
});
