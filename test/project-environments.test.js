'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const environments = require('../src/project-environments');

async function makeDir(root, name) {
  const target = path.join(root, name);
  await fs.mkdir(target, { recursive: true });
  return target;
}

function fixture(entryPath, componentPath) {
  const workflow = {
    id: 'wf-demo',
    name: '演示业务流',
    entrySkillName: 'workflow-demo'
  };
  const resolvedSteps = [{
    skillName: 'component-a',
    folderName: 'component-a',
    versionHash: 'a'.repeat(64),
    current: {
      id: componentPath,
      name: 'component-a',
      folderName: 'component-a',
      versionHash: 'a'.repeat(64),
      directoryPath: componentPath
    }
  }];
  return { workflow, resolvedSteps, entryPath };
}

test('Codex 与 Cursor 共用 .agents/skills，计划会去重', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = await makeDir(root, 'project');
  const entryPath = await makeDir(root, 'workflow-demo');
  const componentPath = await makeDir(root, 'component-a');

  const plan = await environments.buildProjectPlan({
    ...fixture(entryPath, componentPath),
    projectRoot,
    tools: ['codex', 'cursor']
  });
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(plan.actions[0].tools, ['codex', 'cursor']);
  assert.equal(plan.summary.create, 2);
});

test('预览后应用并回滚，只删除本次创建的 Junction', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = await makeDir(root, 'project');
  const entryPath = await makeDir(root, 'workflow-demo');
  const componentPath = await makeDir(root, 'component-a');
  await fs.writeFile(path.join(componentPath, 'keep.txt'), '保留', 'utf8');

  const plan = await environments.buildProjectPlan({
    ...fixture(entryPath, componentPath),
    projectRoot,
    tools: ['codex', 'claude']
  });
  const applied = await environments.applyProjectPlan(plan);
  assert.equal(applied.manifest.status, 'completed');
  assert.equal(applied.manifest.createdJunctions.length, 4);
  for (const action of applied.manifest.createdJunctions) {
    assert.equal((await fs.lstat(action.targetPath)).isSymbolicLink(), true);
  }

  const rolledBack = await environments.rollbackProjectApply(applied.manifestPath);
  assert.equal(rolledBack.status, 'rolled-back');
  for (const action of applied.manifest.createdJunctions) {
    await assert.rejects(fs.access(action.targetPath));
  }
  assert.equal(await fs.readFile(path.join(componentPath, 'keep.txt'), 'utf8'), '保留');
});

test('项目内同名普通目录默认阻断，不覆盖用户内容', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = await makeDir(root, 'project');
  const entryPath = await makeDir(root, 'workflow-demo');
  const componentPath = await makeDir(root, 'component-a');
  const occupied = path.join(projectRoot, '.agents', 'skills', 'component-a');
  await fs.mkdir(occupied, { recursive: true });
  await fs.writeFile(path.join(occupied, 'user.txt'), '用户内容', 'utf8');

  const plan = await environments.buildProjectPlan({
    ...fixture(entryPath, componentPath),
    projectRoot,
    tools: ['codex']
  });
  assert.equal(plan.summary.conflicts, 1);
  await assert.rejects(environments.applyProjectPlan(plan), /同名冲突/);
  assert.equal(await fs.readFile(path.join(occupied, 'user.txt'), 'utf8'), '用户内容');
});

test('预览后目标发生变化会拒绝执行', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = await makeDir(root, 'project');
  const entryPath = await makeDir(root, 'workflow-demo');
  const componentPath = await makeDir(root, 'component-a');
  const plan = await environments.buildProjectPlan({
    ...fixture(entryPath, componentPath),
    projectRoot,
    tools: ['codex']
  });
  await fs.mkdir(plan.actions[0].targetPath, { recursive: true });
  await assert.rejects(environments.applyProjectPlan(plan), /预览后发生变化/);
});
