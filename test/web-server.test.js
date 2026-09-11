const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeVersionHash,
  createSkillAtlasServer,
  validatePackage
} = require('../src/web-server');

function createPackage(name = 'demo-skill') {
  return {
    schemaVersion: 1,
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

function createMemoryRepository() {
  const skills = new Map();
  const packages = new Map();
  return {
    async health() {
      return true;
    },
    async list() {
      return [...skills.values()];
    },
    async save(validated) {
      const previous = skills.get(validated.metadata.id);
      const versionCount = previous?.versionHash === validated.metadata.versionHash
        ? previous.versionCount
        : (previous?.versionCount || 0) + 1;
      const metadata = { ...validated.metadata, versionCount };
      skills.set(metadata.id, metadata);
      packages.set(metadata.id, validated.package);
      return metadata;
    },
    async get(id) {
      return packages.get(id) || null;
    },
    async close() {}
  };
}

test('Skill 包生成跨设备稳定 ID 和内容版本', () => {
  const first = validatePackage(createPackage());
  const second = validatePackage(createPackage());

  assert.equal(first.metadata.id, second.metadata.id);
  assert.equal(first.metadata.versionHash, second.metadata.versionHash);
  assert.equal(first.metadata.fileCount, 2);
  assert.equal(computeVersionHash(first.package.files), first.metadata.versionHash);
});

test('拒绝包含目录穿越的 Skill 包', () => {
  const payload = createPackage();
  payload.files.push({
    path: '../token.txt',
    contentBase64: Buffer.from('secret').toString('base64')
  });

  assert.throws(() => validatePackage(payload), /不安全的文件路径/);
});

test('Web API 支持鉴权、上传、清单和下载', async (context) => {
  const server = createSkillAtlasServer({
    repository: createMemoryRepository(),
    accessToken: 'test-token'
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = 'http://127.0.0.1:' + address.port;

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await server.repository.close();
  });

  const health = await fetch(baseUrl + '/api/health').then((response) => response.json());
  assert.deepEqual(health, { ok: true, database: true, protected: true });

  const home = await fetch(baseUrl + '/').then((response) => response.text());
  assert.match(home, /Skill Dock/);

  const iconResponse = await fetch(baseUrl + '/icon.svg');
  assert.match(iconResponse.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await iconResponse.text(), /<rect width="1024" height="1024" fill="#fff"\/>/);

  const rejected = await fetch(baseUrl + '/api/skills');
  assert.equal(rejected.status, 401);

  const uploadedResponse = await fetch(baseUrl + '/api/skills', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(createPackage('portable-skill'))
  });
  assert.equal(uploadedResponse.status, 201);
  const uploaded = await uploadedResponse.json();

  const list = await fetch(baseUrl + '/api/skills', {
    headers: { Authorization: 'Bearer test-token' }
  }).then((response) => response.json());
  assert.equal(list.skills.length, 1);
  assert.equal(list.skills[0].name, 'portable-skill');

  const updatedResponse = await fetch(baseUrl + '/api/skills', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(createPackage('portable-skill'))
  });
  assert.equal(updatedResponse.status, 201);

  const downloaded = await fetch(baseUrl + '/api/skills/' + uploaded.skill.id, {
    headers: { Authorization: 'Bearer test-token' }
  }).then((response) => response.json());
  assert.equal(downloaded.skill.name, 'portable-skill');
  assert.equal(downloaded.files.length, 2);
});
