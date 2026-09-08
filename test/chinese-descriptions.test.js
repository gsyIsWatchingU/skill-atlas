const test = require('node:test');
const assert = require('node:assert/strict');
const { CHINESE_DESCRIPTIONS, getChineseDescription } = require('../src/chinese-descriptions');

test('内置 63 个 Skill 中文简介', () => {
  const entries = Object.entries(CHINESE_DESCRIPTIONS);
  assert.equal(entries.length, 63);
  for (const [name, description] of entries) {
    assert.match(description, /[\u3400-\u9fff]/u, `${name} 缺少中文简介`);
    assert.ok(description.length >= 12, `${name} 的中文简介过短`);
  }
});

test('Skill 名称匹配不区分大小写', () => {
  assert.equal(getChineseDescription('Presentations'), CHINESE_DESCRIPTIONS.presentations);
  assert.equal(getChineseDescription('Spreadsheets'), CHINESE_DESCRIPTIONS.spreadsheets);
  assert.equal(getChineseDescription('not-configured'), '');
});
