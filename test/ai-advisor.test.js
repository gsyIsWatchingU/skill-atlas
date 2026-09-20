'use strict';

/**
 * AI 整理的三条契约：
 *   1. 本地粗筛只做确定性判断，同名不同平台不合并（docs/solution.md §6）
 *   2. 载荷里不能出现任何路径、脚本内容
 *   3. 模型输出必须逐条核对，编造的编号整条丢弃
 *
 * 第 3 条是本文件最不能妥协的部分：只要有人把 ref 校验去掉，
 * 界面上就会出现指向不存在 Skill 的"建议删除"，那等于把幻觉当事实。
 */

const test = require('node:test');
const assert = require('node:assert');

const { findDuplicateCandidates, normalizeName, tokenize, jaccard } = require('../src/ai/candidates');
const { buildPayload, describePayload, redactPaths, truncate } = require('../src/ai/payload');
const { buildPrompt, extractJson, parseAdvice, VERDICTS } = require('../src/ai/advice');
const { chatComplete, resolveEndpoint } = require('../src/ai/llm-client');
const { publicSkillFields, resolveAdvice } = require('../src/ai');

function makeSkill(overrides = {}) {
  return {
    id: `C:\\skills\\${overrides.name || 'x'}`,
    name: 'x',
    folderName: 'x',
    description: '暂无描述',
    platform: 'codex',
    scope: 'user',
    source: 'Codex 个人 Skill',
    ownership: 'personal',
    versionHash: 'a'.repeat(64),
    fileCount: 2,
    sizeBytes: 2048,
    modifiedAt: '2026-09-01T10:00:00.000Z',
    directoryPath: 'C:\\skills\\x',
    usage: { total: 0, last30: 0, lastUsedAt: null },
    ...overrides
  };
}

/* ---------------- 本地粗筛 ---------------- */

test('同名跨平台的 Skill 会作为候选列出，但不合并', () => {
  const result = findDuplicateCandidates([
    makeSkill({ name: 'pdf', platform: 'codex', versionHash: 'a'.repeat(64) }),
    makeSkill({ name: 'pdf', platform: 'workbuddy', versionHash: 'b'.repeat(64) })
  ]);
  assert.strictEqual(result.groups.length, 1);
  const group = result.groups[0];
  assert.strictEqual(group.reason, 'same-name');
  // 列出两个成员，但作用域信息要保留，交给模型去判 —— 不是替用户删一个
  assert.strictEqual(group.members.length, 2);
});

test('内容哈希相同但名字不同，判为同一份的副本', () => {
  const hash = 'c'.repeat(64);
  const result = findDuplicateCandidates([
    makeSkill({ name: 'write-here', versionHash: hash }),
    makeSkill({ name: 'writeHere', versionHash: hash, platform: 'shared' })
  ]);
  const group = result.groups.find((item) => item.reason === 'same-content');
  assert.ok(group, '应该识别出内容相同的副本');
  assert.strictEqual(group.members.length, 2);
});

test('描述高度重合但名字不同，判为语义重叠候选', () => {
  const result = findDuplicateCandidates([
    makeSkill({ name: 'excel-report', description: '把实验结果汇总成 Excel 报表并生成图表' }),
    makeSkill({ name: 'xlsx-summary', description: '把实验结果汇总成 Excel 报表并绘制图表', versionHash: 'd'.repeat(64) })
  ]);
  const group = result.groups.find((item) => item.reason === 'similar');
  assert.ok(group, '应该识别出语义重叠');
  assert.ok(group.score >= 0.6);
});

test('完全不相干的 Skill 不进候选', () => {
  const result = findDuplicateCandidates([
    makeSkill({ name: 'excel-report', description: '生成 Excel 报表', versionHash: 'e'.repeat(64) }),
    makeSkill({ name: 'horror-audio', description: '用 WebAudio 合成恐怖环境音', versionHash: 'f'.repeat(64) })
  ]);
  assert.strictEqual(result.groups.length, 0);
});

test('系统内置 Skill 默认不参与整理', () => {
  const result = findDuplicateCandidates([
    makeSkill({ name: 'pdf', ownership: 'system' }),
    makeSkill({ name: 'pdf', ownership: 'system' })
  ]);
  assert.strictEqual(result.groups.length, 0);
  const including = findDuplicateCandidates(
    [
      makeSkill({ name: 'pdf', ownership: 'system' }),
      makeSkill({ name: 'pdf', ownership: 'system' })
    ],
    { includeSystem: true }
  );
  assert.strictEqual(including.groups.length, 1);
});

test('名称归一与分词的行为符合预期', () => {
  assert.strictEqual(normalizeName('My_Skill.v2'), 'my-skill-v2');
  assert.ok(tokenize('代码审查助手').has('代码'));
  assert.ok(tokenize('代码审查助手').has('审查'));
  assert.strictEqual(jaccard(new Set(['a']), new Set()), 0);
});

/* ---------------- 载荷与脱敏 ---------------- */

test('载荷里不含任何路径字段', () => {
  const { groups } = findDuplicateCandidates([
    makeSkill({ name: 'pdf' }),
    makeSkill({ name: 'pdf', platform: 'workbuddy' })
  ]);
  const { payload } = buildPayload(groups, { homeDirectory: 'C:\\Users\\xiaoguo' });
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('C:\\\\skills'), '不能出现目录路径');
  assert.ok(!serialized.includes('xiaoguo'), '不能出现用户名');
  for (const skill of payload.skills) {
    assert.ok(!('directoryPath' in skill));
    assert.ok(!('realDirectoryPath' in skill));
    assert.ok(!('id' in skill));
    assert.ok(!('_skill' in skill));
  }
});

test('描述里的绝对路径会被脱敏', () => {
  const home = 'C:\\Users\\xiaoguo';
  assert.strictEqual(redactPaths(`放在 ${home}\\skills\\pdf 下`, home), '放在 ~\\skills\\pdf 下');
  const other = redactPaths('参考 D:\\work\\prj\\secret\\config.md', home);
  assert.ok(!other.includes('secret'), '非主目录的绝对路径也要削掉中间段');
  assert.ok(other.includes('config.md'), '保留末段便于人读');
});

test('描述超长时截断，且不会截断到半个字符', () => {
  assert.strictEqual(truncate('abcdef', 3), 'abc…');
  assert.strictEqual(truncate('abc', 10), 'abc');
});

test('默认不发正文；勾选后才发，且只发 SKILL.md 的内容', () => {
  const { groups } = findDuplicateCandidates([
    makeSkill({ name: 'pdf' }),
    makeSkill({ name: 'pdf', platform: 'workbuddy' })
  ]);
  const withoutBody = buildPayload(groups, { bodyProvider: () => '正文' });
  assert.ok(withoutBody.payload.skills.every((skill) => !('bodyExcerpt' in skill)));

  const withBody = buildPayload(groups, {
    includeBody: true,
    maxBodyChars: 20,
    bodyProvider: (skill) => (skill.platform === 'codex' ? 'x'.repeat(100) : '短正文')
  });
  const first = withBody.payload.skills[0];
  assert.ok(first.bodyExcerpt.startsWith('xxx'));
  assert.strictEqual(first.bodyExcerpt.length, 21); // 20 字符 + 省略号
});

test('预览如实报告体积与是否含正文', () => {
  const { groups } = findDuplicateCandidates([
    makeSkill({ name: 'pdf' }),
    makeSkill({ name: 'pdf', platform: 'workbuddy' })
  ]);
  const { payload } = buildPayload(groups, {
    includeBody: true,
    bodyProvider: () => 'y'.repeat(500)
  });
  const preview = describePayload(payload, { baseUrl: 'https://api.example.com/v1', model: 'qwen' });
  assert.strictEqual(preview.skillCount, 2);
  assert.strictEqual(preview.includesBody, true);
  assert.ok(preview.estimatedChars > 500);
  assert.ok(preview.fields.includes('bodyExcerpt'));
  assert.strictEqual(preview.model, 'qwen');
});

/* ---------------- 提示词与输出核对 ---------------- */

test('提示词把载荷与输出格式一起交给模型', () => {
  const { groups } = findDuplicateCandidates([makeSkill({ name: 'pdf' }), makeSkill({ name: 'pdf' })]);
  const { payload } = buildPayload(groups);
  const prompt = buildPrompt(payload);
  assert.ok(prompt.system.includes('禁止编造编号'));
  assert.ok(prompt.user.includes('"task":"duplicate-review"'));
  assert.ok(prompt.user.includes('duplicate'));
  // 让模型抄编号而不是记组 id：组 id 记错一次整条建议就废了
  assert.ok(prompt.system.includes('refs'));
  assert.ok(prompt.system.includes('不要自己造组'));
});

test('能从代码块与前后废话里抠出 JSON', () => {
  assert.deepStrictEqual(JSON.parse(extractJson('```json\n{"a":1}\n```')), { a: 1 });
  assert.deepStrictEqual(JSON.parse(extractJson('好的：{"a":{"b":2}} 以上')), { a: { b: 2 } });
  assert.strictEqual(extractJson('完全没有 JSON'), null);
});

test('模型抄对编号就能对上候选组，不必记住组 id', () => {
  const context = { validRefs: new Set(['s1', 's2']), groupRefs: new Map([['name:pdf', ['s1', 's2']]]) };
  const parsed = parseAdvice(
    '{"summary":"一致","findings":[{"refs":["s2","s1"],"verdict":"duplicate","keep":"s2","drop":["s1"],"reason":"contentHash 相同","confidence":0.9}]}',
    context
  );
  assert.strictEqual(parsed.groups.length, 1);
  assert.strictEqual(parsed.groups[0].groupId, 'name:pdf');
  assert.strictEqual(parsed.groups[0].keep, 's2');
});

test('模型拼出的组合不是任何一个候选组，整条丢弃', () => {
  const parsed = parseAdvice(
    '{"summary":"","findings":[{"refs":["s1","s3"],"verdict":"duplicate","keep":"s1","drop":["s3"],"reason":"很像","confidence":0.6}]}',
    {
      validRefs: new Set(['s1', 's2', 's3']),
      groupRefs: new Map([['name:pdf', ['s1', 's2']], ['name:xlsx', ['s3']]])
    }
  );
  assert.strictEqual(parsed.groups.length, 0);
  assert.ok(parsed.rejected[0].reason.includes('不构成一个候选组'));
});

test('既没给编号也没给组 id，无法核对，丢弃', () => {
  const parsed = parseAdvice('{"findings":[{"verdict":"duplicate","keep":"s1","drop":["s2"],"reason":"x"}]}', {
    validRefs: new Set(['s1', 's2']),
    groupRefs: new Map([['name:pdf', ['s1', 's2']]])
  });
  assert.strictEqual(parsed.groups.length, 0);
  assert.ok(parsed.rejected[0].reason.includes('无法核对'));
});

test('模型引用了不存在的编号，整条丢弃', () => {
  const parsed = parseAdvice(
    '{"summary":"s","findings":[{"groupId":"name:pdf","verdict":"duplicate","keep":"s9","drop":["s2"],"reason":"内容一致","confidence":0.9}]}',
    { validRefs: new Set(['s1', 's2']), groupRefs: new Map([['name:pdf', ['s1', 's2']]]) }
  );
  assert.strictEqual(parsed.groups.length, 0);
  assert.strictEqual(parsed.rejected.length, 1);
  assert.ok(parsed.rejected[0].reason.includes('不存在'));
});

test('模型把不同候选组的编号混在一起，整条丢弃', () => {
  const parsed = parseAdvice(
    '{"summary":"s","findings":[{"groupId":"name:pdf","verdict":"duplicate","keep":"s1","drop":["s3"],"reason":"内容一致","confidence":0.9}]}',
    {
      validRefs: new Set(['s1', 's2', 's3']),
      groupRefs: new Map([['name:pdf', ['s1', 's2']], ['name:xlsx', ['s3']]])
    }
  );
  assert.strictEqual(parsed.groups.length, 0);
  assert.ok(parsed.rejected[0].reason.includes('不属于该候选组'));
});

test('缺少依据、verdict 非法、自相矛盾的建议一律不采纳', () => {
  const context = { validRefs: new Set(['s1', 's2']), groupRefs: new Map([['name:pdf', ['s1', 's2']]]) };
  const noReason = parseAdvice('{"findings":[{"refs":["s1","s2"],"verdict":"duplicate","keep":"s1","drop":["s2"],"reason":""}]}', context);
  assert.ok(noReason.rejected.some((item) => item.reason.includes('依据')));

  const badVerdict = parseAdvice('{"findings":[{"refs":["s1","s2"],"verdict":"merge","keep":"s1","drop":["s2"],"reason":"x"}]}', context);
  assert.ok(badVerdict.rejected.some((item) => item.reason.includes('verdict')));

  const conflict = parseAdvice('{"findings":[{"refs":["s1","s2"],"verdict":"duplicate","keep":"s1","drop":["s1","s2"],"reason":"x"}]}', context);
  assert.ok(conflict.rejected.some((item) => item.reason.includes('自相矛盾')));
});

test('distinct 与 conflict 允许不给要去掉的编号，其余 verdict 不允许', () => {
  const context = { validRefs: new Set(['s1', 's2']), groupRefs: new Map([['name:pdf', ['s1', 's2']]]) };
  const distinct = parseAdvice('{"findings":[{"refs":["s1","s2"],"verdict":"distinct","keep":"s1","drop":[],"reason":"用途不同","confidence":0.4}]}', context);
  assert.strictEqual(distinct.groups.length, 1);

  // conflict 的语义就是「同名不同用途，两个都留」，不该被要求删一个
  const conflict = parseAdvice('{"findings":[{"refs":["s1","s2"],"verdict":"conflict","keep":"s1","drop":[],"reason":"一个抽取文本，一个转 Markdown","confidence":0.7}]}', context);
  assert.strictEqual(conflict.groups.length, 1);

  const duplicate = parseAdvice('{"findings":[{"refs":["s1","s2"],"verdict":"duplicate","keep":"s1","drop":[],"reason":"内容一致"}]}', context);
  assert.strictEqual(duplicate.groups.length, 0);
});

test('合法建议被采纳并带上置信度与依据', () => {
  const parsed = parseAdvice(
    '{"summary":"两份 pdf 内容一致","findings":[{"refs":["s1","s2"],"verdict":"duplicate","keep":"s2","drop":["s1"],"reason":"contentHash 相同且文件数一致","confidence":1.4}]}',
    { validRefs: new Set(['s1', 's2']), groupRefs: new Map([['name:pdf', ['s1', 's2']]]) }
  );
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.groups.length, 1);
  assert.strictEqual(parsed.groups[0].keep, 's2');
  assert.strictEqual(parsed.groups[0].confidence, 1); // 超出范围要夹回去
  assert.ok(VERDICTS.includes(parsed.groups[0].verdict));
});

test('模型没返回 JSON 时如实报错，不假装成功', () => {
  const parsed = parseAdvice('我觉得这两个 Skill 可能有点像，但我不确定。');
  assert.strictEqual(parsed.ok, false);
  assert.ok(parsed.error.includes('JSON'));
  assert.strictEqual(parsed.groups.length, 0);
});

/* ---------------- 建议映射回本机 Skill ---------------- */

test('建议映射回的是模型真正指的那个 Skill', () => {
  const first = makeSkill({ name: 'pdf', platform: 'codex', versionHash: 'a'.repeat(64) });
  const second = makeSkill({ name: 'pdf', platform: 'workbuddy', versionHash: 'b'.repeat(64) });
  const { groups } = findDuplicateCandidates([first, second]);
  const { payload, skills } = buildPayload(groups);

  // s1 = first（codex），s2 = second（workbuddy）；模型说保留 s2、去掉 s1
  const parsed = parseAdvice(
    '{"summary":"内容一致","findings":[{"refs":["s1","s2"],"verdict":"duplicate","keep":"s2","drop":["s1"],"reason":"两份内容一致，保留 workbuddy 那份","confidence":0.9}]}',
    {
      validRefs: new Set(payload.skills.map((entry) => entry.ref)),
      groupRefs: new Map(payload.groups.map((group) => [group.id, group.refs]))
    }
  );
  const resolved = resolveAdvice(parsed, { skills, groups });

  assert.strictEqual(resolved.groups[0].keep.platform, 'workbuddy', '保留的必须是 s2 对应的那份');
  assert.strictEqual(resolved.groups[0].keep.directoryPath, second.directoryPath);
  assert.strictEqual(resolved.groups[0].drop.length, 1);
  assert.strictEqual(resolved.groups[0].drop[0].platform, 'codex');
  assert.strictEqual(resolved.groups[0].members.length, 2);
  // 映射后仍可点回详情：id 必须是扫描结果的稳定标识
  const scannedIds = new Set([first.id, second.id]);
  assert.ok(scannedIds.has(resolved.groups[0].keep.id));
});

test('给渲染层的字段可以带路径，但绝不会混进来历不明的键', () => {
  const skill = makeSkill({ name: 'pdf', directoryPath: 'C:\\skills\\pdf' });
  const fields = publicSkillFields(skill);
  assert.strictEqual(fields.directoryPath, 'C:\\skills\\pdf');
  assert.strictEqual(fields.referenced, 0);
  assert.deepStrictEqual(Object.keys(fields).sort(), [
    'description', 'directoryPath', 'fileCount', 'id', 'modifiedAt',
    'name', 'platform', 'referenced', 'scope', 'sizeBytes', 'source', 'versionHash'
  ]);
});

/* ---------------- 出网客户端 ---------------- */

test('端点兼容 base / v1 / 完整路径三种写法', () => {
  assert.strictEqual(resolveEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(resolveEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(resolveEndpoint('http://localhost:11434/v1/chat/completions'), 'http://localhost:11434/v1/chat/completions');
  assert.strictEqual(resolveEndpoint('https://x.dev/v1/'), 'https://x.dev/v1/chat/completions');
});

test('非 http 协议的地址直接拒绝', () => {
  assert.throws(() => resolveEndpoint('file:///etc/passwd'), /http/);
  assert.throws(() => resolveEndpoint(''), /接口地址/);
});

test('缺少模型名不发请求', async () => {
  await assert.rejects(
    () => chatComplete({ baseUrl: 'https://x.dev/v1', model: '', messages: [{ role: 'user', content: 'hi' }] }),
    /模型名/
  );
});

test('401 归因为 Key 无效，空内容归因为模型没说话', async () => {
  const stub = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) });
  await assert.rejects(
    () => chatComplete({ baseUrl: 'https://x.dev/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: stub }),
    /API Key 无效/
  );

  const empty = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '  ' } }] }) });
  await assert.rejects(
    () => chatComplete({ baseUrl: 'https://x.dev/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: empty }),
    /空内容/
  );
});

test('超时会被翻译成人话', async () => {
  // 桩必须响应 signal，否则测的是「实现没崩」而不是「超时被翻译成人话」
  const never = (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  await assert.rejects(
    () => chatComplete(
      { baseUrl: 'https://x.dev/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 30 },
      { fetchImpl: never }
    ),
    /超时/
  );
});

test('正常返回时带出模型名与用量', async () => {
  const ok = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: 'qwen2.5-32b',
      choices: [{ message: { content: '{"summary":"ok"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 }
    })
  });
  const result = await chatComplete(
    { baseUrl: 'https://x.dev/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: ok }
  );
  assert.strictEqual(result.text, '{"summary":"ok"}');
  assert.strictEqual(result.model, 'qwen2.5-32b');
  assert.strictEqual(result.usage.prompt_tokens, 100);
  assert.strictEqual(result.endpoint, 'https://x.dev/v1/chat/completions');
});
