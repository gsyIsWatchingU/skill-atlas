const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachCustomDescriptions,
  normalizeSettings,
  updateCustomDescription
} = require('../src/settings');

test('规范化设置并忽略无效简介', () => {
  const settings = normalizeSettings({
    customRoots: [{ id: 'root' }],
    customDescriptions: { first: '  中文简介  ', second: 42, empty: '   ' }
  });

  assert.deepEqual(settings.customRoots, [{ id: 'root' }]);
  assert.deepEqual(settings.customDescriptions, { first: '中文简介' });
});

test('保存、展示和清除自定义中文简介', () => {
  const saved = updateCustomDescription({}, 'skill-id', '  自定义中文简介  ');
  assert.equal(saved.description, '自定义中文简介');

  const result = attachCustomDescriptions(
    { skills: [{ id: 'skill-id', description: 'English description' }] },
    saved.settings.customDescriptions
  );
  assert.equal(result.skills[0].customDescription, '自定义中文简介');

  const cleared = updateCustomDescription(saved.settings, 'skill-id', '');
  assert.equal(cleared.description, '');
  assert.deepEqual(cleared.settings.customDescriptions, {});
});
