'use strict';

/**
 * 桌面宿主层的契约测试：设置持久化、自定义简介、以及 skill.id 的存在性。
 *
 * skill.id 这一项曾经是真实缺陷 —— 渲染层与设置层都按 skill.id 存取，
 * 但扫描器不产出该字段，导致自定义简介永远存不上、选中态也定位不到。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const scanner = require('../src/scanner');
const settings = require('../src/settings');

const AGENTS_ROOT = {
  id: 'shared-agents',
  platform: 'shared',
  scope: 'user',
  label: '跨 Agent 共享 Skill',
  segments: ['.agents', 'skills']
};

async function writeSkill(directory, name, description) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
    'utf8'
  );
}

test('扫描结果带稳定的 id，且能作为自定义简介的键', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-desktop-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeSkill(path.join(home, '.agents', 'skills', 'alpha'), 'alpha', '原始描述');

  const result = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });
  const [skill] = result.skills;

  assert.ok(skill.id, '扫描结果必须有 id');
  assert.equal(skill.id, skill.directoryPath);

  // 用 id 做键写入自定义简介，再附回扫描结果 —— 应能命中
  const stored = settings.updateCustomDescription({}, skill.id, '我写的简介');
  const attached = settings.attachCustomDescriptions(result.skills, stored.settings);
  assert.equal(attached[0].customDescription, '我写的简介');
  assert.equal(attached[0].displayDescription, '我写的简介');
});

test('自定义简介超长被截断到 300 字', () => {
  const tooLong = 'x'.repeat(500);
  const { settings: next, description } = settings.updateCustomDescription({}, 'k', tooLong);
  assert.equal(description.length, settings.MAX_CUSTOM_DESCRIPTION_LENGTH);
  assert.equal(next.customDescriptions.k.length, settings.MAX_CUSTOM_DESCRIPTION_LENGTH);
});

test('清空简介时删除键，而不是留下空字符串', () => {
  const withOne = settings.updateCustomDescription({}, 'k', '有内容').settings;
  const cleared = settings.updateCustomDescription(withOne, 'k', '   ').settings;
  assert.equal('k' in cleared.customDescriptions, false);
});

test('设置写入是原子的且可往返读取', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-settings-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const filePath = path.join(home, 'settings.json');

  await settings.writeSettings(filePath, {
    customRoots: [{ id: 'custom-1', label: '我的目录', absolutePath: 'C:\\skills' }],
    customDescriptions: { 'C:\\skills\\a': '简介' }
  });

  const read = await settings.readSettings(filePath);
  assert.equal(read.customRoots.length, 1);
  assert.equal(read.customRoots[0].scope, 'custom');
  assert.equal(read.customDescriptions['C:\\skills\\a'], '简介');

  // 临时文件不应残留
  const entries = await fs.readdir(home);
  assert.deepEqual(entries, ['settings.json']);
});

test('设置文件损坏时备份而不是静默丢弃', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-settings-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const filePath = path.join(home, 'settings.json');
  await fs.writeFile(filePath, '{ 这不是 JSON', 'utf8');

  const read = await settings.readSettings(filePath);
  assert.deepEqual(read, { customRoots: [], customDescriptions: {} });

  const entries = await fs.readdir(home);
  assert.equal(entries.some((name) => name.includes('.broken-')), true, '损坏配置必须留备份');
});

test('缺失的设置文件返回空设置，不抛错', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-dock-settings-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const read = await settings.readSettings(path.join(home, 'nope.json'));
  assert.deepEqual(read, { customRoots: [], customDescriptions: {} });
});

test('normalizeSettings 丢弃字段不完整的自定义根', () => {
  const normalized = settings.normalizeSettings({
    customRoots: [
      { id: 'ok', absolutePath: 'C:\\a' },
      { id: 'no-path' },
      { absolutePath: 'C:\\b' },
      null
    ]
  });
  assert.equal(normalized.customRoots.length, 1);
  assert.equal(normalized.customRoots[0].id, 'ok');
});
