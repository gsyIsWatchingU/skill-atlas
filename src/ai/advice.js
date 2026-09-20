'use strict';

/**
 * 提示词构造与模型输出解析。
 *
 * 解析层的立场：**模型会编造**。它可能返回不存在的 Skill 编号、把 A 组的 Skill
 * 说成 B 组的、或者干脆返回一段解释文字。所以这里不信任任何一条未经核对的建议：
 *   - 编号必须在本次载荷里存在；
 *   - 保留/忽略的编号必须同属一个候选组（跨组引用 = 幻觉）；
 *   - 无法核对的建议整条丢弃，并如实计数 —— 界面上要显示"忽略了 N 条无法核对的建议"，
 *     而不是假装模型没说过。
 */

const VERDICTS = ['duplicate', 'overlap', 'conflict', 'distinct'];
/** 这两种结论的落点是「两个都留」，所以不要求模型给出要去掉的编号 */
const KEEP_ALL_VERDICTS = new Set(['distinct', 'conflict']);
const VERDICT_LABELS = {
  duplicate: '实质重复',
  overlap: '语义重叠',
  conflict: '同名不同用途',
  distinct: '不算重复'
};
const VERDICT_ADVICE = {
  duplicate: '建议只保留一份',
  overlap: '建议收窄描述而不是删除',
  conflict: '建议用作用域区分，两个都留',
  distinct: '无需处理'
};

const SYSTEM_PROMPT = [
  '你是一个 Skill 库整理助手。用户在本机多个 Agent 工具（Codex、WorkBuddy、豆包、共享目录）',
  '里装了不少 Skill，有些是同一份被拷到了多处，有些名字不同但干的是同一件事。',
  '你要做的是判断哪些该合并、保留哪一份。',
  '',
  '严格约束：',
  '1. 只能用我给你的编号（s1、s2…）来指代 Skill，禁止编造编号，禁止猜测路径或文件名。',
  '2. 只能对同一个候选组（groups 里的 refs）内部的 Skill 下判断，禁止把不同组的 Skill 放在一起比较。',
  '3. 同名的 Skill 不代表一定是重复：不同平台/作用域下同名可能是两个不同的东西，',
  '   这种情况下 verdict 用 conflict，不要建议删除。',
  '4. 内容哈希（contentHash）相同 = 内容完全一致，这种是确定的重复。',
  '5. 描述相近但用途不同的，用 overlap 并建议收窄描述，不要直接建议删除。',
  '6. 没有把握就给 distinct 并说明缺什么信息，不要硬判。',
  '',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要额外解释。格式：',
  '{"summary":"一句话总览","findings":[{"refs":["s1","s2"],"verdict":"duplicate|overlap|conflict|distinct","keep":"s1","drop":["s2"],"reason":"依据，必须引用具体字段","confidence":0.8}]}',
  '',
  'refs 直接从我给你的候选组里抄编号（顺序无所谓），不要自己造组、不要写 groupId ——',
  '编号抄错或抄漏会被整条丢弃。findings 要覆盖每一个候选组。',
  'reason 要写清依据（哪两个字段相同/不同），空泛的"看起来相似"不接受。'
].join('\n');

function buildPrompt(payload) {
  const body = JSON.stringify(payload, null, 0);
  const userPrompt = [
    '以下是本机 Skill 库里疑似重复的候选组。每个 Skill 我只给元数据，不给路径和文件内容。',
    'referenced 是 Codex 会话日志里 SKILL.md 被引用的次数，是弱代理指标，不等于真实调用次数。',
    '',
    body
  ].join('\n');
  return { system: SYSTEM_PROMPT, user: userPrompt };
}

/**
 * 从模型输出里抠出第一个完整的 JSON 对象。
 * 模型常常套 ```json 代码块，也常常在 JSON 前后加客套话。
 */
function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, index + 1);
    }
  }
  return null;
}

function toRefList(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  return [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))];
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(1, Math.max(0, numeric));
}

/**
 * 解析并核对模型输出。
 *
 * @param {string} text 模型原文
 * @param {object} context
 * @param {Set<string>}    context.validRefs 本次载荷里出现过的全部编号
 * @param {Map<string, string[]>} context.groupRefs 候选组 id -> 该组编号
 * @returns {{ok: boolean, summary: string, groups: Array, rejected: Array, error?: string}}
 */
function parseAdvice(text, context = {}) {
  const validRefs = context.validRefs instanceof Set ? context.validRefs : new Set();
  const groupRefs = context.groupRefs instanceof Map ? context.groupRefs : new Map();

  const jsonText = extractJson(text);
  if (!jsonText) {
    return {
      ok: false,
      summary: '',
      groups: [],
      rejected: [],
      error: '模型没有返回可解析的 JSON，本次建议已作废。'
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return {
      ok: false,
      summary: '',
      groups: [],
      rejected: [],
      error: `模型返回的 JSON 无法解析：${error.message}`
    };
  }

  const raw = String((parsed && parsed.summary) || '').trim().slice(0, 500);
  // 模型既可以给 refs（抄编号），也可以给 groupId（抄组名）—— 两条路都接受，
  // 但对不上任何候选组的一律丢弃。要求它记住组 id 只是多一个出错机会。
  const incoming = Array.isArray(parsed && parsed.findings)
    ? parsed.findings
    : (Array.isArray(parsed && parsed.groups) ? parsed.groups : []);
  const groups = [];
  const rejected = [];

  const canonical = (refs) => [...refs].sort().join(',');
  const groupIdByRefs = new Map();
  for (const [id, refs] of groupRefs.entries()) groupIdByRefs.set(canonical(refs), id);

  for (const item of incoming) {
    if (!item || typeof item !== 'object') {
      rejected.push({ reason: '条目不是对象' });
      continue;
    }

    let groupId = null;
    const refs = Array.isArray(item.refs) ? item.refs.map((ref) => String(ref || '').trim()) : null;
    if (refs && refs.length >= 2) {
      const unknown = refs.filter((ref) => !validRefs.has(ref));
      if (unknown.length) {
        rejected.push({ reason: `引用了不存在的编号：${unknown.join(', ')}` });
        continue;
      }
      groupId = groupIdByRefs.get(canonical(refs)) || null;
      if (!groupId) {
        rejected.push({ reason: `这几个编号不构成一个候选组：${refs.join(', ')}` });
        continue;
      }
    } else if (item.groupId) {
      const id = String(item.groupId).trim();
      if (!groupRefs.has(id)) {
        rejected.push({ reason: `候选组 ${id} 不在本次载荷里`, groupId: id });
        continue;
      }
      groupId = id;
    } else {
      rejected.push({ reason: '既没有 refs 也没有 groupId，无法核对它说的是哪一组' });
      continue;
    }

    const members = groupRefs.get(groupId);
    const verdict = String(item.verdict || '').trim();
    if (!VERDICTS.includes(verdict)) {
      rejected.push({ reason: `verdict 非法：${verdict || '(空)'}`, groupId });
      continue;
    }

    const keep = toRefList(item.keep);
    const drop = toRefList(item.drop);

    if (keep.length !== 1) {
      rejected.push({ reason: `keep 必须且只能有一个编号，收到 ${keep.length} 个`, groupId });
      continue;
    }
    const unknown = [...keep, ...drop].filter((ref) => !validRefs.has(ref));
    if (unknown.length) {
      rejected.push({ reason: `引用了不存在的编号：${unknown.join(', ')}`, groupId });
      continue;
    }
    const outside = [...keep, ...drop].filter((ref) => !members.includes(ref));
    if (outside.length) {
      rejected.push({ reason: `编号不属于该候选组：${outside.join(', ')}`, groupId });
      continue;
    }
    if (drop.includes(keep[0])) {
      rejected.push({ reason: 'keep 与 drop 自相矛盾', groupId });
      continue;
    }
    // distinct（不算重复）与 conflict（同名不同用途）都是「两个都留」，不该要求 drop
    if (!KEEP_ALL_VERDICTS.has(verdict) && !drop.length) {
      rejected.push({ reason: '除 distinct / conflict 外必须给出要去掉的编号', groupId });
      continue;
    }

    const reason = String(item.reason || '').trim().slice(0, 600);
    if (!reason) {
      rejected.push({ reason: '没有给出依据（reason 为空）', groupId });
      continue;
    }

    groups.push({
      groupId,
      verdict,
      verdictLabel: VERDICT_LABELS[verdict],
      advice: VERDICT_ADVICE[verdict],
      keep: keep[0],
      drop,
      reason,
      confidence: clampConfidence(item.confidence)
    });
  }

  const covered = new Set(groups.map((group) => group.groupId));
  const missing = [...groupRefs.keys()].filter((id) => !covered.has(id));

  return {
    ok: groups.length > 0,
    summary: raw,
    groups,
    rejected,
    missingGroups: missing
  };
}

module.exports = {
  KEEP_ALL_VERDICTS,
  SYSTEM_PROMPT,
  VERDICT_ADVICE,
  VERDICT_LABELS,
  VERDICTS,
  buildPrompt,
  extractJson,
  parseAdvice
};
