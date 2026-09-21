'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CENTRAL_ROOT_ID, DEFAULT_ROOTS, IDE_ADAPTERS } = require('../src/ide-adapters');

test('IDE adapter 的根 id 唯一，且只有一个中央正本目录', () => {
  const ids = DEFAULT_ROOTS.map((root) => root.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(DEFAULT_ROOTS.filter((root) => root.unifyRole === 'central').length, 1);
  assert.equal(CENTRAL_ROOT_ID, 'shared-agents');
});

test('系统目录永远不是统一写入目标', () => {
  for (const root of DEFAULT_ROOTS.filter((item) => item.system)) {
    assert.notEqual(root.unifyTarget, true, root.id);
  }
});

test('已声明 Codex、Claude、Cursor、WorkBuddy、豆包与 Trae', () => {
  const ids = new Set(IDE_ADAPTERS.map((adapter) => adapter.id));
  for (const id of ['codex', 'claude', 'cursor', 'workbuddy', 'doubao', 'trae']) {
    assert.equal(ids.has(id), true, id);
  }
});

test('不存在“整段 skills 目录链接”，目标全部是逐 Skill 根', () => {
  const targets = DEFAULT_ROOTS.filter((root) => root.unifyTarget);
  assert.ok(targets.length >= 4);
  for (const root of targets) {
    assert.ok(Array.isArray(root.segments));
    assert.equal(root.scope, 'user');
  }
});

test('未验证链接兼容性的 Trae 只扫描，不自动迁移', () => {
  const traeRoots = DEFAULT_ROOTS.filter((root) => root.adapterId === 'trae');
  assert.ok(traeRoots.length > 0);
  assert.ok(traeRoots.every((root) => root.unifyEligible === false));
});
