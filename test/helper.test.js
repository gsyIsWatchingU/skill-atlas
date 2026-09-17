const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createHelperServer,
  scanRoots,
  summarizeLinks
} = require('../src/web/helper/skill-dock-helper');
const { computeVersionHash } = require('../src/web-server');

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-helper-'));
  const skillRoot = path.join(root, '.codex', 'skills', 'demo-skill');
  await fs.mkdir(path.join(skillRoot, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(skillRoot, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 本地助手测试\n---\n',
    'utf8'
  );
  await fs.writeFile(path.join(skillRoot, 'scripts', 'run.js'), 'console.log("ok");\n', 'utf8');
  await fs.writeFile(path.join(skillRoot, '.env'), 'SECRET=hidden\n', 'utf8');
  return root;
}

test('本地助手只读扫描默认目录并过滤敏感文件', async (t) => {
  const homeDirectory = await createFixture();
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const result = await scanRoots({
    homeDirectory,
    token: 'fixture-token',
    roots: [{
      id: 'codex-user',
      label: 'Codex 个人 Skill',
      displayPath: '%USERPROFILE%\\.codex\\skills',
      segments: ['.codex', 'skills']
    }]
  });

  assert.equal(result.roots[0].status, 'ready');
  assert.equal(result.roots[0].skillCount, 1);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'demo-skill');
  assert.equal(result.skills[0].skippedSensitive, 1);
  assert.deepEqual(result.skills[0].files.map((file) => file.path), ['SKILL.md', 'scripts/run.js']);
  assert.equal(result.skills[0].versionHash, computeVersionHash(result.skills[0].files.map((file) => ({
    path: file.path,
    contentBase64: file.content.toString('base64')
  }))));
});

test('本地助手要求来源与配对令牌同时有效', async (t) => {
  const homeDirectory = await createFixture();
  const token = 'valid-local-pairing-token';
  const origin = 'https://skills.example.test';
  const server = createHelperServer({
    token,
    homeDirectory,
    webUrl: `${origin}/`,
    roots: [{
      id: 'codex-user',
      label: 'Codex 个人 Skill',
      displayPath: '%USERPROFILE%\\.codex\\skills',
      segments: ['.codex', 'skills']
    }]
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(homeDirectory, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${baseUrl}/v1/health`, { headers: { Origin: origin } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/v1/health`, {
    headers: { Origin: 'https://evil.example.test', Authorization: `Bearer ${token}` }
  })).status, 403);

  const health = await fetch(`${baseUrl}/v1/health`, {
    headers: { Origin: origin, Authorization: `Bearer ${token}` }
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).readOnly, true);

  const scan = await fetch(`${baseUrl}/v1/scan`, {
    headers: { Origin: origin, Authorization: `Bearer ${token}` }
  }).then((response) => response.json());
  assert.equal(scan.skills.length, 1);
  assert.equal(Object.hasOwn(scan.skills[0], 'directoryPath'), false);
  assert.equal(Object.hasOwn(scan.skills[0], 'files'), false);
  // 本机目录布局不外传，只给计数。
  assert.deepEqual(scan.links, {
    followed: 0,
    outsideRoot: 0,
    broken: 0,
    cycle: 0,
    denied: 0,
    notFollowed: 0
  });

  const skillPackage = await fetch(
    `${baseUrl}/v1/skills/${scan.skills[0].helperSkillId}/package`,
    { headers: { Origin: origin, Authorization: `Bearer ${token}` } }
  ).then((response) => response.json());
  assert.deepEqual(skillPackage.files.map((file) => file.path), ['SKILL.md', 'scripts/run.js']);
});

const AGENTS_ROOT = {
  id: 'shared-agents',
  label: '跨 Agent 共享 Skill',
  displayPath: '%USERPROFILE%\\.agents\\skills',
  segments: ['.agents', 'skills']
};

// 无权限时创建链接会失败（Windows 未开开发者模式且非管理员时的符号链接就是如此）。
// 这种情况是环境限制而非产品缺陷，跳过而不是判红。
async function linkOrSkip(t, target, linkPath, kind) {
  try {
    await fs.symlink(target, linkPath, kind);
    return true;
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOSYS') {
      t.skip(`当前环境无法创建 ${kind} 链接（${error.code}）`);
      return false;
    }
    throw error;
  }
}

async function writeSkill(directory, name, description) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
    'utf8'
  );
}

// Skill 目录本身是链接：项目/.agents/skills/<name> -> 中央仓库里的真实目录。
// 这是"项目环境隔离"落地后的形态，扫描器看不见它等于隔离完即失明。
async function createLinkedFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-links-'));
  const skillsRoot = path.join(root, '.agents', 'skills');
  const central = path.join(root, 'central', 'linked-skill');
  await fs.mkdir(skillsRoot, { recursive: true });
  await writeSkill(central, 'linked-skill', '通过链接挂进来');
  // junction 在 Windows 上不需要开发者模式，是产品无特权时的降级方案。
  const created = await linkOrSkip(t, central, path.join(skillsRoot, 'linked-skill'), 'junction');
  return { root, skillsRoot, central, created };
}

test('跟随 Skill 目录链接，并把跳出扫描根的目标记录在案', async (t) => {
  const { root, central, created } = await createLinkedFixture(t);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (!created) return;

  const result = await scanRoots({ homeDirectory: root, token: 'link-token', roots: [AGENTS_ROOT] });

  assert.equal(result.roots[0].skillCount, 1);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'linked-skill');
  assert.deepEqual(result.skills[0].files.map((file) => file.path), ['SKILL.md']);

  // 目标在扫描根之外——这是隔离的正常形态，所以跟随，但要如实记一笔。
  assert.equal(result.links.outsideRoot.length, 1);
  assert.equal(
    await fs.realpath(result.links.outsideRoot[0].target),
    await fs.realpath(central)
  );
  assert.equal(summarizeLinks(result.links).outsideRoot, 1);
});

test('关闭跟随后链接 Skill 被记为未跟随，而不是静默消失', async (t) => {
  const { root, created } = await createLinkedFixture(t);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (!created) return;

  const result = await scanRoots({
    homeDirectory: root,
    token: 'link-token',
    roots: [AGENTS_ROOT],
    followLinks: false
  });

  assert.equal(result.skills.length, 0);
  assert.equal(result.links.notFollowed.length, 1);
  assert.equal(result.followLinks, false);
});

test('Skill 目录内的链接文件按逻辑路径计入版本哈希', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-inner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, '.agents', 'skills');
  const skillRoot = path.join(skillsRoot, 'with-inner-link');
  const shared = path.join(root, 'shared');
  await fs.mkdir(shared, { recursive: true });
  await writeSkill(skillRoot, 'with-inner-link', '内部有链接文件');
  await fs.writeFile(path.join(shared, 'notes.md'), '# 共享说明\n', 'utf8');
  const created = await linkOrSkip(t, path.join(shared, 'notes.md'), path.join(skillRoot, 'notes.md'), 'file');
  if (!created) return;

  const result = await scanRoots({ homeDirectory: root, token: 'inner-token', roots: [AGENTS_ROOT] });

  assert.equal(result.skills.length, 1);
  assert.deepEqual(result.skills[0].files.map((file) => file.path), ['SKILL.md', 'notes.md']);
  // 逻辑路径而非真实路径：同一个 Skill 从不同链接位置被发现时哈希必须一致。
  assert.equal(result.skills[0].versionHash, computeVersionHash(result.skills[0].files.map((file) => ({
    path: file.path,
    contentBase64: file.content.toString('base64')
  }))));
});

test('链接成环与失效链接都不终止扫描，且各自留痕', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-cycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, '.agents', 'skills');
  await fs.mkdir(skillsRoot, { recursive: true });

  const created = await linkOrSkip(t, skillsRoot, path.join(skillsRoot, 'loop-back'), 'junction');
  if (!created) return;

  // 先建目录再删掉，得到一条必定失效的链接（比直接链到不存在的路径更可靠）。
  const doomed = path.join(root, 'doomed-target');
  await fs.mkdir(doomed, { recursive: true });
  await fs.symlink(doomed, path.join(skillsRoot, 'broken-link'), 'junction');
  await fs.rm(doomed, { recursive: true, force: true });

  const result = await scanRoots({ homeDirectory: root, token: 'cycle-token', roots: [AGENTS_ROOT] });

  assert.equal(result.roots[0].status, 'ready');
  assert.equal(result.links.cycle.length, 1);
  assert.equal(result.links.broken.length, 1);
  assert.equal(result.links.broken[0].error, 'ENOENT');
  assert.equal(result.skills.length, 0);
});

test('同一目标被两个链接发现时只计一次，避免重复计入哈希', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-dup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, '.agents', 'skills');
  const central = path.join(root, 'central', 'twice');
  await fs.mkdir(skillsRoot, { recursive: true });
  await writeSkill(central, 'twice', '被挂了两次');

  const created = await linkOrSkip(t, central, path.join(skillsRoot, 'first'), 'junction');
  if (!created) return;
  await fs.symlink(central, path.join(skillsRoot, 'second'), 'junction');

  const result = await scanRoots({ homeDirectory: root, token: 'dup-token', roots: [AGENTS_ROOT] });

  // 目录环路的第二次命中被记为成环并跳过，清单里因此只出现一次。
  assert.equal(result.skills.length, 1);
  assert.equal(result.links.cycle.length, 1);
});
