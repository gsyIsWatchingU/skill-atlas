const test = require('node:test');
const assert = require('node:assert/strict');
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
        skill: { ...validated.package.skill, authorName: user.displayName }
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
