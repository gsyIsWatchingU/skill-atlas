'use strict';

/**
 * 使用统计的**口径契约测试**。
 *
 * 这组测试存在的唯一目的：防止有人把 referenced 悄悄改回 invoked。
 *
 * 背景（2026-09-18 实测）：对全部 475 个真实 Codex 会话日志抽样后确认，
 * Codex **不把"技能被调用"记成工具调用**。日志里引用 SKILL.md 的调用几乎全是
 * agent 在读/写 SKILL.md 文件本身。所以这个数据源只能给出 referenced（弱代理），
 * 不能给出 invoked。docs/solution.md §4 明确要求三类事件不得混用。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const usage = require('../src/usage-scanner');

const SKILL_PATH = 'C:\\Users\\probe\\.codex\\skills\\demo\\SKILL.md';

function skillFixture() {
  return [{
    name: 'demo',
    directoryPath: 'C:\\Users\\probe\\.codex\\skills\\demo',
    platform: 'codex',
    scope: 'user'
  }];
}

test('usage 事件类型是 referenced，不是 invoked（§4 三类事件不得混用）', () => {
  const events = [{
    skillPath: SKILL_PATH,
    timestamp: new Date().toISOString(),
    sessionId: 'session-1'
  }];
  const result = usage.aggregateUsage(skillFixture(), events);

  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].usage.event, 'referenced');
  assert.notEqual(result.skills[0].usage.event, 'invoked');
  assert.equal(result.skills[0].usage.total, 1);
});

test('scanCodexUsage 的 meta 标明这是代理指标', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-usage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sessionRoot = path.join(home, 'sessions');
  await fs.mkdir(sessionRoot, { recursive: true });

  // 一条"读了 SKILL.md"的调用 —— 这正是真实日志里的形态
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell_command',
      input: JSON.stringify({ command: `Get-Content ${SKILL_PATH}` })
    }
  });
  await fs.writeFile(path.join(sessionRoot, 'rollout-1.jsonl'), `${line}\n`, 'utf8');

  const result = await usage.scanCodexUsage(skillFixture(), {
    sessionRoots: [sessionRoot],
    cachePath: path.join(home, 'cache.json')
  });

  assert.equal(result.meta.event, 'referenced');
  assert.equal(result.meta.eventReliability, 'proxy');
  assert.match(result.meta.note, /不等于|勿当作|不记录/);
  assert.equal(result.meta.sessionFiles, 1);
  assert.equal(result.skills[0].usage.total, 1);
});

test('不相关的工具调用不会被算成引用', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-usage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sessionRoot = path.join(home, 'sessions');
  await fs.mkdir(sessionRoot, { recursive: true });

  const lines = [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', input: JSON.stringify({ command: 'ls -la' }) }
    }),
    // 系统提示里提到 SKILL.md 属于 message，不是工具调用，不能计入
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'skills use SKILL.md' }] }
    })
  ];
  await fs.writeFile(path.join(sessionRoot, 'rollout-2.jsonl'), `${lines.join('\n')}\n`, 'utf8');

  const result = await usage.scanCodexUsage(skillFixture(), {
    sessionRoots: [sessionRoot],
    cachePath: path.join(home, 'cache.json')
  });

  assert.equal(result.skills[0].usage.total, 0);
  assert.equal(result.summary.usedSkills, 0);
  assert.equal(result.summary.unusedSkills, 1);
});
