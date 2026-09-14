const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createHelperServer,
  scanRoots
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

  const skillPackage = await fetch(
    `${baseUrl}/v1/skills/${scan.skills[0].helperSkillId}/package`,
    { headers: { Origin: origin, Authorization: `Bearer ${token}` } }
  ).then((response) => response.json());
  assert.deepEqual(skillPackage.files.map((file) => file.path), ['SKILL.md', 'scripts/run.js']);
});
