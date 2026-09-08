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
