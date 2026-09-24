'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const scanner = require('../src/scanner');
const workflows = require('../src/workflows');
const pluginExport = require('../src/plugin-export');

async function makeSkill(root, name) {
  const directoryPath = path.join(root, name);
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(path.join(directoryPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`, 'utf8');
  await fs.writeFile(path.join(directoryPath, '.env'), 'TOKEN=secret\n', 'utf8');
  const snapshot = await pluginExport.collectSkillSnapshot(directoryPath, '');
  return { id: directoryPath, name, folderName: name, directoryPath, versionHash: snapshot.versionHash };
}

test('导出为可独立安装的 Codex Plugin，并固定依赖版本', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-plugin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'source');
  const output = path.join(root, 'output');
  await fs.mkdir(output);
  const alpha = await makeSkill(skillsRoot, 'alpha');
  const beta = await makeSkill(skillsRoot, 'beta');
  const workflow = await workflows.saveWorkflow(path.join(root, 'workflows.json'), {
    name: '中文发布流',
    purpose: '完成内容发布',
    steps: [alpha, beta].map((skill) => ({
      skillId: skill.id,
      skillName: skill.name,
      folderName: skill.folderName,
      versionHash: skill.versionHash,
      relation: 'then'
    }))
  });

  const result = await pluginExport.exportWorkflowPlugin({ workflow, skills: [alpha, beta], targetParent: output });
  const manifest = JSON.parse(await fs.readFile(path.join(result.destination, '.codex-plugin', 'plugin.json'), 'utf8'));
  const provenance = JSON.parse(await fs.readFile(path.join(result.destination, 'workflow-package.json'), 'utf8'));
  assert.equal(manifest.name, workflow.entrySkillName);
  assert.equal(manifest.skills, './skills/');
  assert.match(manifest.name, /^[a-z0-9-]+$/);
  assert.equal(provenance.skills.length, 2);
  assert.equal(await fs.readFile(path.join(result.destination, 'skills', 'alpha', 'SKILL.md'), 'utf8').then(Boolean), true);
  await assert.rejects(fs.access(path.join(result.destination, 'skills', 'alpha', '.env')));
});

test('依赖版本在导出前变化时阻断，不留下半成品', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-plugin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  await fs.mkdir(output);
  const alpha = await makeSkill(root, 'alpha');
  const workflow = await workflows.saveWorkflow(path.join(root, 'workflows.json'), {
    name: '版本保护',
    steps: [{
      skillId: alpha.id,
      skillName: alpha.name,
      folderName: alpha.folderName,
      versionHash: alpha.versionHash,
      relation: 'then'
    }]
  });
  await fs.appendFile(path.join(alpha.directoryPath, 'SKILL.md'), '\nchanged\n');
  const changed = { ...alpha, versionHash: scanner.computeVersionHash([{
    path: 'SKILL.md',
    content: await fs.readFile(path.join(alpha.directoryPath, 'SKILL.md'))
  }]) };

  await assert.rejects(
    pluginExport.exportWorkflowPlugin({ workflow, skills: [changed], targetParent: output }),
    /版本已变化/
  );
  assert.deepEqual(await fs.readdir(output), []);
});
