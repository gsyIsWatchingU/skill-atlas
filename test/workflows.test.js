'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const workflows = require('../src/workflows');

function skill(name, hash = name.repeat(8).slice(0, 64)) {
  return {
    id: `C:\\skills\\${name}`,
    name,
    folderName: name,
    versionHash: hash
  };
}

function workflowInput(name, steps) {
  return {
    name,
    purpose: `${name} 的目的`,
    steps: steps.map((item, index) => ({
      skillId: item.id,
      skillName: item.name,
      folderName: item.folderName,
      versionHash: item.versionHash,
      relation: index === 2 ? 'parallel' : 'then'
    }))
  };
}

test('ABCD 与 CDEF 只引用同一份 C/D，不复制 Skill 内容', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'workflows.json');
  const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => skill(name));

  const first = await workflows.saveWorkflow(storePath, workflowInput('ABCD', [a, b, c, d]));
  const second = await workflows.saveWorkflow(storePath, workflowInput('CDEF', [c, d, e, f]));
  const store = await workflows.readWorkflowStore(storePath);

  assert.equal(store.workflows.length, 2);
  assert.equal(first.steps[2].skillId, second.steps[0].skillId);
  assert.equal(first.steps[3].skillId, second.steps[1].skillId);
  assert.equal(JSON.stringify(store).includes('SKILL.md 正文'), false);
});

test('生成单一调用入口，只写编排说明与引用清单', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'workflows.json');
  const centralRoot = path.join(root, 'central');
  const a = skill('alpha', 'a'.repeat(64));
  const b = skill('beta', 'b'.repeat(64));
  const saved = await workflows.saveWorkflow(storePath, workflowInput('发布流程', [a, b]));

  const generated = await workflows.generateWorkflowSkill({
    filePath: storePath,
    workflowId: saved.id,
    centralRootPath: centralRoot,
    skills: [a, b]
  });
  const skillMd = await fs.readFile(path.join(generated.entryPath, 'SKILL.md'), 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(generated.entryPath, 'workflow.json'), 'utf8'));

  assert.match(saved.entrySkillName, /^[a-z0-9-]+$/);
  assert.match(skillMd, /用户只需调用 `\$workflow-/);
  assert.match(skillMd, /调用 `\$alpha`/);
  assert.match(skillMd, /调用 `\$beta`/);
  assert.equal(manifest.generatedBy, workflows.GENERATED_BY);
  assert.deepEqual(manifest.steps.map((step) => step.skillName), ['alpha', 'beta']);

  await workflows.deleteWorkflow(storePath, saved.id, centralRoot);
  await assert.rejects(fs.access(generated.entryPath));
  assert.equal((await workflows.readWorkflowStore(storePath)).workflows.length, 0);
});

test('版本变化时阻止生成，重新保存后才能更新入口', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'workflows.json');
  const oldSkill = skill('alpha', 'a'.repeat(64));
  const newSkill = skill('alpha', 'b'.repeat(64));
  const saved = await workflows.saveWorkflow(storePath, workflowInput('版本锁定', [oldSkill]));

  await assert.rejects(
    workflows.generateWorkflowSkill({
      filePath: storePath,
      workflowId: saved.id,
      centralRootPath: path.join(root, 'central'),
      skills: [newSkill]
    }),
    /版本已变化/
  );
});

test('不能覆盖同名普通 Skill，删除时也只移除带标记的入口', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'workflows.json');
  const centralRoot = path.join(root, 'central');
  const a = skill('alpha', 'a'.repeat(64));
  const saved = await workflows.saveWorkflow(storePath, workflowInput('占用入口', [a]));
  const occupied = path.join(centralRoot, saved.entrySkillName);
  await fs.mkdir(occupied, { recursive: true });
  await fs.writeFile(path.join(occupied, 'SKILL.md'), '普通 Skill', 'utf8');

  await assert.rejects(
    workflows.generateWorkflowSkill({
      filePath: storePath,
      workflowId: saved.id,
      centralRootPath: centralRoot,
      skills: [a]
    }),
    /不能覆盖普通 Skill/
  );
  await workflows.deleteWorkflow(storePath, saved.id, centralRoot);
  assert.equal(await fs.readFile(path.join(occupied, 'SKILL.md'), 'utf8'), '普通 Skill');
});

test('导出包不含本机路径，导入时按名称与版本复用已安装 Skill', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceStore = path.join(root, 'source.json');
  const targetStore = path.join(root, 'target.json');
  const a = skill('alpha', 'a'.repeat(64));
  const b = skill('beta', 'b'.repeat(64));
  const saved = await workflows.saveWorkflow(sourceStore, workflowInput('可移植流程', [a, b]));
  const exported = workflows.exportWorkflowPackage(saved);

  const serialized = JSON.stringify(exported);
  assert.equal(serialized.includes('skillId'), false);
  assert.equal(serialized.includes('C:'), false);
  assert.match(workflows.workflowPackageHash(exported), /^[0-9a-f]{64}$/);
  const imported = await workflows.importWorkflowPackage(targetStore, exported, [a, b]);
  assert.deepEqual(imported.steps.map((step) => step.skillId), [a.id, b.id]);
  const pulledAgain = await workflows.importWorkflowPackage(targetStore, exported, [a, b], { replaceByName: true });
  assert.equal(pulledAgain.id, imported.id);
  assert.equal((await workflows.readWorkflowStore(targetStore)).workflows.length, 1);
});

test('导入包缺少依赖或版本不一致时明确阻断', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = skill('alpha', 'a'.repeat(64));
  const saved = await workflows.saveWorkflow(path.join(root, 'source.json'), workflowInput('依赖校验', [a]));
  const exported = workflows.exportWorkflowPackage(saved);

  await assert.rejects(
    workflows.importWorkflowPackage(path.join(root, 'missing.json'), exported, []),
    /缺少依赖 Skill/
  );
  await assert.rejects(
    workflows.importWorkflowPackage(path.join(root, 'mismatch.json'), exported, [skill('alpha', 'b'.repeat(64))]),
    /版本不匹配/
  );
  await assert.rejects(
    workflows.importWorkflowPackage(path.join(root, 'unknown-version.json'), exported, [{ ...a, versionHash: '' }]),
    /版本不匹配/
  );
  const invalid = structuredClone(exported);
  invalid.workflow.steps[0].versionHash = 'not-a-hash';
  await assert.rejects(
    workflows.importWorkflowPackage(path.join(root, 'invalid.json'), invalid, [a]),
    /有效版本/
  );
});
