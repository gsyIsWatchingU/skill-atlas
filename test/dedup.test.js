const test = require('node:test');
const assert = require('node:assert');
const dedup = require('../src/web/dedup');

function skill(name, fileCount, sizeBytes, extra) {
  return Object.assign({ name, fileCount, sizeBytes, versionHash: name + ':' + fileCount }, extra);
}

test('同名 Skill 只保留文件最全的一个', () => {
  const a = skill('dup-skill', 1, 100);
  const b = skill('dup-skill', 3, 500);
  const c = skill('dup-skill', 2, 300);
  const unique = skill('unique-skill', 1, 50);
  const result = dedup.dedupeDuplicateSkills([a, b, c, unique]);
  assert.equal(result.removedCount, 2);
  assert.deepEqual(result.keptSkills, [b, unique]);
});

test('文件数相同时保留体积更大的版本', () => {
  const a = skill('same', 2, 200);
  const b = skill('same', 2, 400);
  const result = dedup.dedupeDuplicateSkills([a, b]);
  assert.equal(result.removedCount, 1);
  assert.deepEqual(result.keptSkills, [b]);
});

test('无重复时原样返回', () => {
  const a = skill('alpha', 1, 10);
  const b = skill('beta', 2, 20);
  const result = dedup.dedupeDuplicateSkills([a, b]);
  assert.equal(result.removedCount, 0);
  assert.equal(result.keptSkills.length, 2);
});

test('名称规范化后相同的视为重复（大小写与空白）', () => {
  const a = skill(' My-Skill ', 1, 10);
  const b = skill('my-skill', 2, 20);
  const result = dedup.dedupeDuplicateSkills([a, b]);
  assert.equal(result.removedCount, 1);
  assert.equal(result.keptSkills[0], b);
});

test('findDuplicateGroups 只返回出现多次的分组', () => {
  const a = skill('x', 1, 1);
  const b = skill('x', 2, 2);
  const c = skill('y', 1, 1);
  const groups = dedup.findDuplicateGroups([a, b, c]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'x');
  assert.equal(groups[0].skills.length, 2);
});

test('空数组与缺省输入安全', () => {
  assert.deepEqual(dedup.dedupeDuplicateSkills([]).keptSkills, []);
  assert.equal(dedup.dedupeDuplicateSkills(undefined).removedCount, 0);
  assert.deepEqual(dedup.findDuplicateGroups(undefined), []);
});
