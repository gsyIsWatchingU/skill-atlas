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
  assert.equal(authorizeUrl.searchParams.get('client_id'), 'skill-packer');
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

  const onDisk = await fs.readFile(path.join(__dirname, '..', 'bin', 'skill-packer.js'));

  const info = await fetch(baseUrl + '/api/cli/info').then((response) => response.json());
  assert.equal(info.cli.available, true);
  assert.equal(info.cli.sizeBytes, onDisk.length);
  assert.equal(info.cli.sha256, sha256(onDisk));
  assert.match(info.cli.version, /^\d+\.\d+\.\d+$/);

  const script = await fetch(baseUrl + '/cli/skill-packer.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/plain/);
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(sha256(Buffer.from(await script.arrayBuffer())), info.cli.sha256);

  const rejected = await fetch(baseUrl + '/cli/skill-packer.js', { method: 'POST' });
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
  assert.match(homeHtml, /icon\.svg\?v=2\.4\.0/);

  // 首页主引导必须是桌面版下载，而不是"复制一条命令去跑脚本"
  // 地址必须和服务端实际路由（/download/desktop）一致 —— 写成 /download 会 404
  assert.match(homeHtml, /id="download-desktop"[^>]*href="\/download\/desktop"/);
  assert.match(homeHtml, /id="desktop-status" class="desktop-connection-status disconnected"[^>]*role="status"/);
  assert.doesNotMatch(homeHtml, /id="helper-command-text"/, '复制命令跑脚本的引导必须已移除');
  assert.doesNotMatch(homeHtml, /id="copy-helper-command"/, '复制命令按钮必须已移除');

  // 链接指向的路由必须真的存在。
  // 注意：不要真的去 fetch /download/desktop —— 未产出安装包时它是 404，
  // 一旦产出就是 90 MB 的流，body 不消费会把测试进程挂住。
  // 这里只校验首页链接与服务端路由常量指向同一个地址。
  const serverSource = await fs.readFile(path.join(__dirname, '..', 'src', 'web-server.js'), 'utf8');
  assert.match(
    serverSource,
    /url\.pathname === '\/download\/desktop'/,
    '服务端必须提供 /download/desktop 路由'
  );
  assert.match(
    serverSource,
    /downloadPath: '\/download\/desktop'/,
    '桌面版下载地址必须与首页链接一致'
  );

  // 命令行脚本仍可下载（自动化/CI 入口）
  assert.equal((await fetch(baseUrl + '/helper/skill-packer-helper.js')).status, 200);

  const icon = await fetch(baseUrl + '/icon.svg');
  assert.equal(icon.status, 200);
  const iconSvg = await icon.text();
  assert.match(iconSvg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(iconSvg, /data:image\/png;base64,[A-Za-z0-9+/=]+/);

  // og:image / apple-touch-icon 引用的 PNG 也必须真的能取到，否则分享卡片是空图
  const iconPng = await fetch(baseUrl + '/icon.png');
  assert.equal(iconPng.status, 200);
  assert.match(iconPng.headers.get('content-type'), /image\/png/);
});

test('三个前端入口共用同一套像素绿令牌（主题不得各自漂移）', async () => {
  // 规范来源：skills/minimal-pixel-green-ui
  const entries = [
    path.join(__dirname, '..', 'src', 'web', 'styles.css'),
    path.join(__dirname, '..', 'src', 'web', 'scan', 'scan.css'),
    path.join(__dirname, '..', 'src', 'renderer', 'styles.css')
  ];
  for (const entry of entries) {
    const css = await fs.readFile(entry, 'utf8');
    const label = path.relative(path.join(__dirname, '..'), entry);
    for (const [token, value] of [
      ['--pixel-green', '#97b39b'],
      ['--pixel-green-hover', '#e2ebe0'],
      ['--pixel-green-strong', '#6f8f75'],
      ['--pixel-page', '#f4f5ef'],
      ['--pixel-surface', '#fffffc'],
      ['--pixel-ink', '#171c18'],
      ['--pixel-ink-secondary', '#5b665e']
    ]) {
      assert.match(
        css,
        new RegExp(`${token}:\\s*${value}`),
        `${label} 缺少或改动了令牌 ${token}`
      );
    }
    assert.match(css, /--pixel-radius:\s*0/, `${label} 圆角必须为 0`);
    assert.match(css, /--pixel-shadow:\s*none/, `${label} 不应有阴影`);
    assert.match(css, /Cascadia Mono/, `${label} 应使用等宽字体`);
    assert.match(css, /prefers-reduced-motion/, `${label} 需要支持减少动效`);
  }
});

test('图标资产齐备且被打包配置引用', async () => {
  const root = path.join(__dirname, '..');
  const png = await fs.readFile(path.join(root, 'assets', 'icon.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'assets/icon.png 必须是 PNG');

  const svg = await fs.readFile(path.join(root, 'assets', 'icon.svg'), 'utf8');
  assert.match(svg, /viewBox="0 0 256 256"/);

  const ico = await fs.readFile(path.join(root, 'assets', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved 必须为 0');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type 必须为 1');
  assert.ok(ico.readUInt16LE(4) >= 4, 'ICO 至少要有 4 个尺寸');

  // 渲染层用相对路径引用 icon.png，必须真的存在
  const rendererIcon = await fs.readFile(path.join(root, 'src', 'renderer', 'icon.png'));
  assert.equal(rendererIcon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  // 打包配置指向 build/icon.png
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.build.win.icon, 'build/icon.png');
  const buildIcon = await fs.readFile(path.join(root, 'build', 'icon.png'));
  assert.equal(buildIcon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('桌面安装包接口可用，未产出时优雅降级', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-desktop-dl-'));
  const outputDir = path.join(home, 'outputs');
  await fs.mkdir(outputDir, { recursive: true });
  // 用一个小文件冒充安装包，避免测试真的去读 90 MB
  await fs.writeFile(path.join(outputDir, 'Skill-Packer-Setup-2.2.0.exe'), 'fake installer\n', 'utf8');
  // 非 Setup 的 portable 单文件不应被选中
  await fs.writeFile(path.join(outputDir, 'Skill Packer 2.2.0.exe'), 'portable\n', 'utf8');

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
  assert.equal(payload.desktop.fileName, 'Skill-Packer-Setup-2.2.0.exe');
  assert.match(payload.desktop.sha256, /^[0-9a-f]{64}$/);

  const download = await fetch(baseUrl + '/download/desktop');
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'fake installer\n');
  assert.match(download.headers.get('content-disposition') || '', /attachment/);
});

test('桌面安装包未产出时返回 404 与 available:false', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-desktop-none-'));
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
  assert.equal(calls[1].payload.clientId, 'skill-packer');
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
      assert.equal(payload.clientId, 'skill-packer');
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
