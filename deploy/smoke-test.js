const assert = require('node:assert/strict');
const { Pool } = require('pg');

async function main() {
  const baseUrl = process.env.SKILL_ATLAS_BASE_URL || 'http://127.0.0.1:8787';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL');

  const healthResponse = await fetch(baseUrl + '/api/health');
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.auth, 'sso');
  assert.equal(health.ssoConfigured, true);

  const communityResponse = await fetch(baseUrl + '/api/skills?scope=community');
  assert.equal(communityResponse.status, 200);
  assert.ok(Array.isArray((await communityResponse.json()).skills));

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const schema = await pool.query([
      'SELECT',
      "  to_regclass('public.skill_users') IS NOT NULL AS has_users,",
      "  to_regclass('public.skill_sessions') IS NOT NULL AS has_sessions,",
      "  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'skills' AND column_name = 'owner_id') AS has_owner,",
      "  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'skills' AND column_name = 'visibility') AS has_visibility"
    ].join('\n'));
    assert.deepEqual(schema.rows[0], {
      has_users: true,
      has_sessions: true,
      has_owner: true,
      has_visibility: true
    });
  } finally {
    await pool.end();
  }

  console.log(JSON.stringify({ ok: true, auth: 'sso', accountIsolation: true }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
