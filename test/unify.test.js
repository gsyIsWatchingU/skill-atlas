'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const {
  applyUnify,
  buildUnifyPlan,
  computeContentFingerprint,
  normalizeFrontmatterName,
  skillCandidateId,
  validateUnifyManifest,
  rollbackUnify
} = require('../src/unify');

const HOME = 'C:\\home';
const ROOTS = [
  { id: 'shared-agents', platform: 'shared', path: path.join(HOME, '.agents', 'skills') },
  { id: 'codex-user', platform: 'codex', path: path.join(HOME, '.codex', 'skills') },
  { id: 'workbuddy-user', platform: 'workbuddy', path: path.join(HOME, '.workbuddy', 'skills') },
  { id: 'doubao-user', platform: 'doubao', path: path.join(HOME, 'doubao', 'user_skills') }
];

function skill(name, rootId, platform, hash, modifiedAt, extra = {}) {
  const root = ROOTS.find((r) => r.id === rootId);
  return {
    name,
    versionHash: hash,
    modifiedAt,
    rootId,
    platform,
    ownership: 'personal',
    directoryPath: path.join(root.path, name),
    realDirectoryPath: path.join(root.path, name),
    ...extra
  };
}

function makeResult(skills) {
  return { roots: ROOTS, skills };
}

test('真重复（同名同 hash）只留一份，其余标 superseded', () => {
  const skills = [
    skill('dup', 'codex-user', 'codex', 'h1', '2026-09-01'),
    skill('dup', 'workbuddy-user', 'workbuddy', 'h1', '2026-09-02')
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  assert.equal(plan.items.length, 1);
  const item = plan.items[0];
  assert.equal(item.conflict, false);
  assert.equal(item.superseded.length, 1);
  // 更新时间更新的当正本
  assert.equal(item.canonical.platform, 'workbuddy');
});

test('同名不同内容默认阻断，不自动选择最新版', () => {
  const skills = [
    skill('ask', 'shared-agents', 'shared', 'old', '2026-09-17'),
    skill('ask', 'workbuddy-user', 'workbuddy', 'new', '2026-09-18')
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  const item = plan.items[0];
  assert.equal(item.conflict, true);
  assert.equal(item.blocked, true);
  assert.equal(item.conflictResolved, false);
  assert.equal(item.centralAction, 'blocked-conflict');
  assert.equal(item.links.length, 0);
  assert.equal(item.candidates.length, 2);
  assert.equal(plan.summary.unresolvedConflicts, 1);
});

test('正本已在中央 → keep，其余 IDE 建 junction', () => {
  const skills = [skill('central', 'shared-agents', 'shared', 'h', '2026-09-01')];
  const plan = buildUnifyPlan(makeResult(skills));
  const item = plan.items[0];
  assert.equal(item.centralAction, 'keep');
  const actions = Object.fromEntries(item.links.map((l) => [l.platform, l.action]));
  assert.equal(actions.codex, 'create-junction');
  assert.equal(actions.workbuddy, 'create-junction');
  assert.equal(actions.doubao, 'create-junction');
});

test('正本只在某 IDE → move-to-central，原位替换为 junction，其余建链接', () => {
  const skills = [skill('wb', 'workbuddy-user', 'workbuddy', 'h', '2026-09-01')];
  const plan = buildUnifyPlan(makeResult(skills));
  const item = plan.items[0];
  assert.equal(item.centralAction, 'move-to-central');
  const actions = Object.fromEntries(item.links.map((l) => [l.platform, l.action]));
  assert.equal(actions.workbuddy, 'replace-with-junction');
  assert.equal(actions.codex, 'create-junction');
  assert.equal(actions.doubao, 'create-junction');
});

test('用户明确选择冲突版本后，旧版备份并替换为 junction', () => {
  const skills = [
    skill('x', 'shared-agents', 'shared', 'new', '2026-09-18'),
    skill('x', 'codex-user', 'codex', 'old', '2026-09-01')
  ];
  const preview = buildUnifyPlan(makeResult(skills));
  const selected = skillCandidateId(skills[0]);
  const plan = buildUnifyPlan(makeResult(skills), {
    conflictChoices: { [preview.items[0].groupId]: selected }
  });
  const item = plan.items[0];
  assert.equal(item.blocked, false);
  assert.equal(item.conflictResolved, true);
  assert.equal(item.canonical.platform, 'shared');
  const codex = item.links.find((l) => l.platform === 'codex');
  assert.equal(codex.action, 'replace-conflict');
  assert.equal(plan.summary.replaceConflicts, 1);
});

test('中央已有相同内容副本时不搬，其它 IDE 的重复副本换成 junction', () => {
  const skills = [
    skill('a', 'shared-agents', 'shared', 'same', '2026-09-01'),
    skill('a', 'codex-user', 'codex', 'same', '2026-09-02')
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  const item = plan.items[0];
  assert.equal(item.centralAction, 'keep'); // 选中央那份，不白搬
  assert.equal(item.canonical.platform, 'shared');
  const actions = Object.fromEntries(item.links.map((l) => [l.platform, l.action]));
  assert.equal(actions.codex, 'replace-duplicate'); // codex 那份相同副本换成链接
  assert.equal(actions.workbuddy, 'create-junction');
});

test('系统技能不进统一计划', () => {
  const skills = [
    skill('mine', 'shared-agents', 'shared', 'h', '2026-09-01'),
    { ...skill('bundled', 'shared-agents', 'doubao', 'h', '2026-09-01'), ownership: 'system' }
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].name, 'mine');
});

test('链接兼容性未验证的个人根不进统一计划', () => {
  const skills = [
    skill('mine', 'shared-agents', 'shared', 'h', '2026-09-01'),
    { ...skill('trae-only', 'workbuddy-user', 'trae', 'h2', '2026-09-02'), unifyEligible: false }
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  assert.deepEqual(plan.items.map((item) => item.name), ['mine']);
});

test('回滚 manifest 的每个路径都必须留在中央根、备份根或 IDE 根内', () => {
  const centralDir = path.join(HOME, '.agents', 'skills');
  const backupRoot = path.join(centralDir, '.unify-backup', '2026-09-21');
  const manifestPath = path.join(backupRoot, 'manifest.json');
  const manifest = {
    centralDir,
    backupRoot,
    junctioned: [{
      linkPath: path.join(HOME, '.codex', 'skills', 'x'),
      target: path.join(centralDir, 'x')
    }],
    moved: [], backedUp: [], removedDuplicates: []
  };
  const options = {
    centralDir,
    manifestPath,
    targetRoots: [path.join(HOME, '.codex', 'skills')]
  };
  assert.equal(validateUnifyManifest(manifest, options), true);
  assert.throws(
    () => validateUnifyManifest({ ...manifest, junctioned: [{ linkPath: 'C:\\Windows\\x', target: path.join(centralDir, 'x') }] }, options),
    /越出 IDE Skill 根/
  );
  assert.throws(
    () => validateUnifyManifest({ ...manifest, backupRoot: 'C:\\temp\\fake' }, options),
    /备份目录越界/
  );
});

/* ---------------- 改名副本（同内容不同名） ---------------- */

test('内容指纹：改名副本（仅 frontmatter name 不同）指纹相同，正文不同则不同', () => {
  const a = [
    { path: 'SKILL.md', content: Buffer.from('---\nname: user-x\ndescription: X\n---\nbody') },
    { path: 'scripts/run.py', content: Buffer.from('print(1)') }
  ];
  const b = [
    { path: 'SKILL.md', content: Buffer.from('---\nname: x\ndescription: X\n---\nbody') },
    { path: 'scripts/run.py', content: Buffer.from('print(1)') }
  ];
  const c = [
    { path: 'SKILL.md', content: Buffer.from('---\nname: x\ndescription: X\n---\nbody DIFF') },
    { path: 'scripts/run.py', content: Buffer.from('print(1)') }
  ];
  assert.equal(computeContentFingerprint(a), computeContentFingerprint(b));
  assert.notEqual(computeContentFingerprint(a), computeContentFingerprint(c));
});

test('normalizeFrontmatterName 只归一化 frontmatter 的 name 行，不动正文', () => {
  const text = '---\nname: foo\ndescription: bar\n---\n正文里有 name: baz\n';
  const out = normalizeFrontmatterName(text);
  assert.ok(out.includes('name: __skill_name__'));
  assert.ok(out.includes('正文里有 name: baz'));
  assert.equal(normalizeFrontmatterName('no frontmatter'), 'no frontmatter');
});

test('改名副本（同内容不同名）并入同一组，正本名取被更多根使用的名字', () => {
  const skills = [
    skill('x', 'workbuddy-user', 'workbuddy', 'h1', '2026-09-01', { contentFingerprint: 'fp1' }),
    skill('x', 'doubao-user', 'doubao', 'h1', '2026-09-02', { contentFingerprint: 'fp1' }),
    skill('user-x', 'doubao-user', 'doubao', 'h2', '2026-09-03', { contentFingerprint: 'fp1' })
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  assert.equal(plan.items.length, 1);
  const item = plan.items[0];
  assert.equal(item.name, 'x'); // x 用了 2 个根，user-x 只用 1 个
  assert.equal(item.conflict, false);
  const actions = Object.fromEntries(item.links.map((l) => [l.platform + ':' + path.basename(l.linkPath), l.action]));
  assert.equal(actions['workbuddy:x'], 'replace-duplicate');
  assert.equal(actions['doubao:x'], 'replace-with-junction');
  assert.equal(actions['doubao:user-x'], 'replace-renamed');
  assert.equal(plan.summary.replaceRenamed, 1);
  assert.equal(plan.summary.replaceDuplicates, 1);
  // superseded 标注改名副本
  assert.ok(item.superseded.some((s) => s.name === 'user-x' && s.reason.includes('改名副本')));
});

test('改名副本正本名平局时取修改时间最新', () => {
  const skills = [
    skill('a', 'workbuddy-user', 'workbuddy', 'h1', '2026-09-01', { contentFingerprint: 'fp1' }),
    skill('b', 'doubao-user', 'doubao', 'h2', '2026-09-05', { contentFingerprint: 'fp1' })
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].name, 'b');
  assert.equal(plan.items[0].canonical.platform, 'doubao');
});

test('异名但内容分叉 → 不合并成一组', () => {
  const skills = [
    skill('x', 'workbuddy-user', 'workbuddy', 'h1', '2026-09-01', { contentFingerprint: 'fp1' }),
    skill('y', 'doubao-user', 'doubao', 'h2', '2026-09-02', { contentFingerprint: 'fp2' })
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  assert.equal(plan.items.length, 2);
});

test('不带内容指纹时退化为只按同名分组（向后兼容）', () => {
  const skills = [
    skill('x', 'workbuddy-user', 'workbuddy', 'h1', '2026-09-01'),
    skill('user-x', 'doubao-user', 'doubao', 'h2', '2026-09-02')
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  assert.equal(plan.items.length, 2);
});

/* ---------------- apply / rollback 集成（真实文件系统） ---------------- */

test('applyUnify + rollbackUnify：同名与改名副本统一后可完整回滚', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'unify-it-'));
  try {
    const roots = [
      { id: 'shared-agents', platform: 'shared', path: path.join(tmp, '.agents', 'skills') },
      { id: 'codex-user', platform: 'codex', path: path.join(tmp, '.codex', 'skills') },
      { id: 'workbuddy-user', platform: 'workbuddy', path: path.join(tmp, '.workbuddy', 'skills') },
      { id: 'doubao-user', platform: 'doubao', path: path.join(tmp, 'doubao', 'user_skills') }
    ];
    const mkdirs = async (p) => fs.mkdir(p, { recursive: true });

    const SKILL_X = '---\nname: x\ndescription: X skill\n---\nbody';
    const SKILL_USER_X = '---\nname: user-x\ndescription: X skill\n---\nbody';
    const dirX = path.join(tmp, '.workbuddy', 'skills', 'x');
    const dirX2 = path.join(tmp, 'doubao', 'user_skills', 'x');
    const dirUserX = path.join(tmp, 'doubao', 'user_skills', 'user-x');
    await mkdirs(dirX);
    await mkdirs(dirX2);
    await mkdirs(dirUserX);
    await fs.writeFile(path.join(dirX, 'SKILL.md'), SKILL_X);
    await fs.writeFile(path.join(dirX2, 'SKILL.md'), SKILL_X);
    await fs.writeFile(path.join(dirUserX, 'SKILL.md'), SKILL_USER_X);

    const skills = [
      { name: 'x', versionHash: 'h1', modifiedAt: '2026-09-01', rootId: 'workbuddy-user', platform: 'workbuddy', ownership: 'personal', directoryPath: dirX, realDirectoryPath: dirX, contentFingerprint: 'fp1' },
      { name: 'x', versionHash: 'h1', modifiedAt: '2026-09-02', rootId: 'doubao-user', platform: 'doubao', ownership: 'personal', directoryPath: dirX2, realDirectoryPath: dirX2, contentFingerprint: 'fp1' },
      { name: 'user-x', versionHash: 'h2', modifiedAt: '2026-09-03', rootId: 'doubao-user', platform: 'doubao', ownership: 'personal', directoryPath: dirUserX, realDirectoryPath: dirUserX, contentFingerprint: 'fp1' }
    ];

    const plan = buildUnifyPlan({ roots, skills });
    assert.equal(plan.items.length, 1);
    const item = plan.items[0];
    const actions = Object.fromEntries(item.links.map((l) => [l.platform + ':' + path.basename(l.linkPath), l.action]));
    assert.equal(actions['workbuddy:x'], 'replace-duplicate');
    assert.equal(actions['doubao:x'], 'replace-with-junction');
    assert.equal(actions['doubao:user-x'], 'replace-renamed');

    const { manifest } = await applyUnify(plan);
    assert.equal(manifest.status, 'completed');

    // 正本在中央，三个根入口都是 junction
    const centralSkill = await fs.readFile(path.join(tmp, '.agents', 'skills', 'x', 'SKILL.md'), 'utf8');
    assert.equal(centralSkill, SKILL_X);
    for (const p of [path.join(tmp, '.workbuddy', 'skills', 'x'), dirX2, dirUserX]) {
      const st = await fs.lstat(p);
      assert.equal(st.isSymbolicLink(), true, `${p} 应为 junction`);
    }
    assert.equal(manifest.moved.length, 1);
    assert.equal(manifest.removedDuplicates.length, 2);
    assert.equal(manifest.removedDuplicates.filter((e) => e.reason === 'renamed').length, 1);

    // 回滚：junction 删除、目录还原、备份清理
    await rollbackUnify(manifest);
    for (const p of [dirX, dirX2, dirUserX]) {
      const st = await fs.lstat(p);
      assert.equal(st.isSymbolicLink(), false, `${p} 回滚后不应是链接`);
      assert.equal(st.isDirectory(), true);
    }
    assert.equal(await fs.readFile(path.join(dirX, 'SKILL.md'), 'utf8'), SKILL_X);
    assert.equal(await fs.readFile(path.join(dirUserX, 'SKILL.md'), 'utf8'), SKILL_USER_X);
    await assert.rejects(
      fs.access(path.join(tmp, '.agents', 'skills', '.unify-backup')),
      (err) => err.code === 'ENOENT'
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
