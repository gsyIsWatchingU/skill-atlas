'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildUnifyPlan } = require('../src/unify');

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

test('同名不同内容 = 冲突，按修改时间最新的为准', () => {
  const skills = [
    skill('ask', 'shared-agents', 'shared', 'old', '2026-09-17'),
    skill('ask', 'workbuddy-user', 'workbuddy', 'new', '2026-09-18')
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  const item = plan.items[0];
  assert.equal(item.conflict, true);
  assert.equal(item.canonical.platform, 'workbuddy');
  assert.equal(item.superseded[0].platform, 'shared');
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

test('某 IDE 已有同名旧版 → skip-local，不覆盖', () => {
  const skills = [
    skill('x', 'shared-agents', 'shared', 'new', '2026-09-18'),
    skill('x', 'codex-user', 'codex', 'old', '2026-09-01')
  ];
  const plan = buildUnifyPlan(makeResult(skills));
  const item = plan.items[0];
  const codex = item.links.find((l) => l.platform === 'codex');
  assert.equal(codex.action, 'skip-local');
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
