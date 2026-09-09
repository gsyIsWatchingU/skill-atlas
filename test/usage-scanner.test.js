const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  extractSkillPaths,
  parseSessionContent,
  scanCodexUsage
} = require('../src/usage-scanner');

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

test('只从工具调用中提取实际读取的 SKILL.md 路径', () => {
  const content = [
    line('2026-09-08T08:00:00.000Z', 'session_meta', { id: 'session-1' }),
    line('2026-09-08T08:01:00.000Z', 'response_item', {
      type: 'message',
      content: '请读取 C:\\skills\\ignored\\SKILL.md'
    }),
    line('2026-09-08T08:02:00.000Z', 'response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      input: JSON.stringify({ cmd: "Get-Content 'C:\\\\skills\\\\review-agent\\\\SKILL.md'" })
    })
  ].join('\n');

  const events = parseSessionContent(content, 'fallback');
  assert.deepEqual(events, [{
    skillPath: 'c:/skills/review-agent/skill.md',
    timestamp: '2026-09-08T08:02:00.000Z',
    sessionId: 'fallback'
  }]);
  assert.deepEqual(extractSkillPaths("'C:/skills/one/SKILL.md' 'C:/skills/one/SKILL.md'"), [
    'c:/skills/one/skill.md'
  ]);
});

test('汇总使用次数、时间范围并复用日志缓存', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-atlas-usage-'));
  const sessionRoot = path.join(temp, 'sessions');
  const cachePath = path.join(temp, 'cache', 'usage-index.json');
  await fs.mkdir(sessionRoot, { recursive: true });
  const skillPath = path.join(temp, 'skills', 'review-agent', 'SKILL.md');
  const sessionPath = path.join(sessionRoot, 'rollout.jsonl');
  const skill = { id: 'review', name: 'review-agent', platform: 'codex', filePath: skillPath };
  const firstEvent = line('2026-09-08T08:00:00.000Z', 'response_item', {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd: `Get-Content -Raw '${skillPath}'` })
  });
  await fs.writeFile(sessionPath, [
    line('2026-09-08T07:59:00.000Z', 'session_meta', { id: 'session-1' }),
    firstEvent
  ].join('\n'));

  const first = await scanCodexUsage([skill], {
    sessionRoots: [sessionRoot],
    cachePath,
    now: '2026-09-08T12:00:00.000Z'
  });
  assert.equal(first.skills[0].usage.total, 1);
  assert.equal(first.skills[0].usage.sessions, 1);
  assert.equal(first.summary.last30, 1);
  assert.equal(first.meta.refreshedFiles, 1);

  const cached = await scanCodexUsage([skill], {
    sessionRoots: [sessionRoot],
    cachePath,
    now: '2026-09-08T12:00:00.000Z'
  });
  assert.equal(cached.meta.cachedFiles, 1);
  assert.equal(cached.meta.refreshedFiles, 0);

  const secondEvent = line('2026-09-08T09:00:00.000Z', 'response_item', {
    type: 'custom_tool_call',
    name: 'exec',
    input: JSON.stringify({ cmd: `Get-Content -Raw '${skillPath}'` })
  });
  await fs.appendFile(sessionPath, `\n${secondEvent}`);
  const refreshed = await scanCodexUsage([skill], {
    sessionRoots: [sessionRoot],
    cachePath,
    now: '2026-09-08T12:00:00.000Z'
  });
  assert.equal(refreshed.skills[0].usage.total, 2);
  assert.equal(refreshed.summary.usedSkills, 1);
  assert.equal(refreshed.daily.at(-1).count, 2);
  assert.equal(refreshed.meta.refreshedFiles, 1);
});
