const assert = require('node:assert/strict');
const { Pool } = require('pg');

async function main() {
  const baseUrl = process.env.SKILL_ATLAS_BASE_URL || 'http://127.0.0.1:8787';
  const token = process.env.SKILL_ATLAS_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;
  if (!token || !databaseUrl) throw new Error('缺少测试环境变量');

  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json'
  };
  const packagePayload = {
    skill: {
      name: 'gpu-deploy-probe',
      description: 'GPU 数据库链路验证',
      platform: 'codex',
      folderName: 'gpu-deploy-probe'
    },
    files: [
      {
        path: 'SKILL.md',
        contentBase64: Buffer.from(
          '---\nname: gpu-deploy-probe\ndescription: GPU probe\n---\n'
        ).toString('base64')
      },
      {
        path: 'scripts/probe.js',
        contentBase64: Buffer.from('console.log("gpu-probe");\n').toString('base64')
      }
    ]
  };

  const uploadResponse = await fetch(baseUrl + '/api/skills', {
    method: 'POST',
    headers,
    body: JSON.stringify(packagePayload)
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json();

  try {
    const listResponse = await fetch(baseUrl + '/api/skills', { headers });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.ok(list.skills.some((skill) => skill.id === uploaded.skill.id));

    const packageResponse = await fetch(
      baseUrl + '/api/skills/' + encodeURIComponent(uploaded.skill.id),
      { headers }
    );
    assert.equal(packageResponse.status, 200);
    const downloaded = await packageResponse.json();
    assert.equal(downloaded.files.length, 2);
    assert.equal(
      Buffer.from(downloaded.files[0].contentBase64, 'base64').length > 0,
      true
    );
    console.log(JSON.stringify({
      ok: true,
      skill: downloaded.skill.name,
      databaseFiles: downloaded.files.length
    }));
  } finally {
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query('DELETE FROM skills WHERE id = $1', [uploaded.skill.id]);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
