'use strict';

/**
 * 交给模型的载荷构造 —— 纯函数，不出网。
 *
 * 数据最小化是这里的唯一目标（docs/solution.md §7）：
 *
 *   发什么：名称、描述、平台、作用域、内容哈希、文件数/体积、修改日期、被引用次数。
 *   不发：目录路径（会带用户名与磁盘布局）、文件清单、脚本内容、任何凭据类文件。
 *   额外勾选才发：SKILL.md 正文摘要（默认不发），且只发 SKILL.md 本身。
 *
 * 模型只能看到 `s1` / `s2` 这样的编号，看不到本机路径。
 * 好处是双向的：模型没机会编造路径，我们也可以校验它引用的编号是否真的存在
 * （见 advice.js 的 parseAdvice —— 它把编造的建议整条丢掉）。
 */

const DEFAULT_MAX_DESCRIPTION_CHARS = 200;
const DEFAULT_MAX_BODY_CHARS = 800;

/**
 * 路径脱敏：用户主目录换成 `~`，其余绝对路径只留最后两段。
 * 描述和正文里都可能不小心写进绝对路径，这一步是兜底，不是可选项。
 */
function redactPaths(text, homeDirectory) {
  let output = String(text || '');
  const home = String(homeDirectory || '').trim();
  if (home) {
    const pattern = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(pattern, 'gi'), '~');
  }
  output = output.replace(/[a-zA-Z]:[\\/](?:[^\\/\r\n\s]+[\\/])+[^\\/\r\n\s]*/g, (match) => {
    const segments = match.split(/[\\/]/).filter(Boolean);
    if (segments.length < 2) return match;
    // 只留末段：父目录名常带着项目名/目录性质，也是信息，一律不送
    return `…/${segments[segments.length - 1]}`;
  });
  return output;
}

function truncate(value, limit) {
  const text = String(value || '').trim();
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function dayOf(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function sizeKb(bytes) {
  const value = Number(bytes) || 0;
  return Math.round(value / 1024);
}

/**
 * 由本地粗筛出的候选组构造载荷。
 *
 * @param {Array} groups findDuplicateCandidates 产出的组
 * @param {object} [options]
 * @param {boolean} [options.includeBody=false] 是否附带 SKILL.md 正文摘要
 * @param {number}  [options.maxBodyChars=800]
 * @param {number}  [options.maxDescriptionChars=200]
 * @param {string}  [options.homeDirectory] 用于路径脱敏
 * @param {Array}   [options.bodyProvider] 取正文的回调（skill => string），不发时不需要
 * @returns {{payload: object, refs: Map<string, object>}}
 */
function buildPayload(groups, options = {}) {
  const homeDirectory = options.homeDirectory || '';
  const includeBody = options.includeBody === true;
  const maxBodyChars = Number(options.maxBodyChars) > 0
    ? Number(options.maxBodyChars)
    : DEFAULT_MAX_BODY_CHARS;
  const maxDescriptionChars = Number(options.maxDescriptionChars) > 0
    ? Number(options.maxDescriptionChars)
    : DEFAULT_MAX_DESCRIPTION_CHARS;

  const refs = new Map();
  const skills = [];
  const payloadGroups = [];
  let sequence = 0;

  for (const group of groups || []) {
    const members = Array.isArray(group.members) ? group.members : [];
    const groupRefs = [];
    for (const skill of members) {
      if (refs.has(skill)) {
        groupRefs.push(refs.get(skill));
        continue;
      }
      sequence += 1;
      const reference = `s${sequence}`;
      const entry = {
        ref: reference,
        name: truncate(skill.name || skill.folderName, 120),
        description: redactPaths(
          truncate(skill.displayDescription || skill.description, maxDescriptionChars),
          homeDirectory
        ),
        platform: skill.platform || 'shared',
        scope: skill.scope || 'user',
        source: skill.source || '',
        contentHash: String(skill.versionHash || '').slice(0, 12),
        files: Number(skill.fileCount) || 0,
        sizeKb: sizeKb(skill.sizeBytes),
        updated: dayOf(skill.modifiedAt),
        referenced: (skill.usage && Number(skill.usage.total)) || 0
      };
      if (includeBody && typeof options.bodyProvider === 'function') {
        const body = options.bodyProvider(skill);
        if (body) entry.bodyExcerpt = redactPaths(truncate(body, maxBodyChars), homeDirectory);
      }
      refs.set(skill, reference);
      groupRefs.push(reference);
      skills.push(entry);
      // 载荷里保留一份 ref -> skill 的反向索引，方便主进程把建议映射回本机 Skill
      entry._skill = skill;
    }
    if (groupRefs.length >= 2) {
      payloadGroups.push({
        id: group.id,
        reason: group.reason,
        score: group.score,
        refs: groupRefs
      });
    }
  }

  // 内部字段不下发给模型：序列化前剥掉
  const outboundSkills = skills.map((entry) => {
    const copy = { ...entry };
    delete copy._skill;
    return copy;
  });

  const payload = {
    schemaVersion: 1,
    task: 'duplicate-review',
    skills: outboundSkills,
    groups: payloadGroups
  };

  return { payload, refs, skills };
}

/** 发送前的可见化：用户有权知道要发出去多少东西、发到哪 */
function describePayload(payload, config = {}) {
  const skills = (payload && payload.skills) || [];
  const groups = (payload && payload.groups) || [];
  const includesBody = skills.some((skill) => typeof skill.bodyExcerpt === 'string');
  const fields = [...new Set(skills.flatMap((skill) => Object.keys(skill)))];
  return {
    skillCount: skills.length,
    groupCount: groups.length,
    includesBody,
    estimatedChars: JSON.stringify(payload).length,
    fields: fields.sort(),
    endpoint: String(config.baseUrl || ''),
    model: String(config.model || '')
  };
}

module.exports = {
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_MAX_DESCRIPTION_CHARS,
  buildPayload,
  describePayload,
  redactPaths,
  truncate
};
