const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseFrontmatter, scanSkills } = require('../src/skill-scanner');

test('解析标准 SKILL.md frontmatter', () => {
  const value = parseFrontmatter(`---\nname: code-review\ndescription: 检查代码质量\n---\n# 指令\n请审查代码。`, 'fallback');
  assert.equal(value.name, 'code-review');
  assert.equal(value.description, '检查代码质量');
  assert.match(value.body, /请审查代码/);
});

test('扫描技能并标记重名与缺失元数据', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-atlas-'));
  const first = path.join(temp, 'first');
  const second = path.join(temp, 'second');
  const third = path.join(temp, 'third');
  await Promise.all([first, second, third].map((directory) => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(first, 'SKILL.md'), '---\nname: same\ndescription: 第一个\n---\n正文');
  await fs.writeFile(path.join(second, 'SKILL.md'), '---\nname: same\ndescription: 第二个\n---\n正文');
  await fs.writeFile(path.join(third, 'SKILL.md'), '# 无 frontmatter');

  const result = await scanSkills([{
    id: 'test', platform: 'codex', scope: '测试', label: '测试目录', rootPath: temp
  }]);
  assert.equal(result.skills.length, 3);
  assert.equal(result.skills.filter((skill) => skill.duplicate).length, 2);
  assert.equal(result.skills.filter((skill) => !skill.valid).length, 1);
});

test('按 Codex 目录标记自带与个人下载技能', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-atlas-origin-'));
  const systemSkill = path.join(temp, '.system', 'skill-creator');
  const personalSkill = path.join(temp, 'my-skill');
  await Promise.all([systemSkill, personalSkill].map((directory) => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(systemSkill, 'SKILL.md'), '---\nname: system-skill\ndescription: 系统技能\n---\n正文');
  await fs.writeFile(path.join(personalSkill, 'SKILL.md'), '---\nname: personal-skill\ndescription: 个人技能\n---\n正文');

  const result = await scanSkills([{
    id: 'codex-user', platform: 'codex', scope: '全局', label: 'Codex 用户技能', rootPath: temp
  }]);
  const skills = Object.fromEntries(result.skills.map((skill) => [skill.name, skill]));

  assert.equal(skills['system-skill'].ownership, 'system');
  assert.equal(skills['system-skill'].ownershipLabel, 'Codex 自带');
  assert.equal(skills['personal-skill'].ownership, 'personal');
  assert.equal(skills['personal-skill'].ownershipLabel, '个人 / 下载');
});

test('区分 Codex 随附插件与远程下载插件', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-atlas-plugin-origin-'));
  const bundledSkill = path.join(temp, 'openai-bundled', 'demo', 'skills', 'bundled-skill');
  const remoteSkill = path.join(temp, 'openai-curated-remote', 'demo', 'skills', 'remote-skill');
  await Promise.all([bundledSkill, remoteSkill].map((directory) => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(bundledSkill, 'SKILL.md'), '---\nname: bundled-skill\ndescription: 随附技能\n---\n正文');
  await fs.writeFile(path.join(remoteSkill, 'SKILL.md'), '---\nname: remote-skill\ndescription: 下载技能\n---\n正文');

  const result = await scanSkills([{
    id: 'codex-plugins', platform: 'codex', scope: '插件', label: 'Codex 插件技能', rootPath: temp
  }]);
  const skills = Object.fromEntries(result.skills.map((skill) => [skill.name, skill]));

  assert.equal(skills['bundled-skill'].ownership, 'system');
  assert.equal(skills['remote-skill'].ownership, 'personal');
});
