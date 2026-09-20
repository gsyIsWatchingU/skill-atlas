'use strict';

/**
 * AI 整理的入口聚合。
 *
 * 四个模块职责分开，方便单独测：
 *   candidates.js  本地粗筛（确定性，不出网）
 *   payload.js     载荷构造与脱敏（决定「发什么」）
 *   advice.js      提示词与输出核对（决定「信什么」）
 *   llm-client.js  唯一的出网点
 *
 * 另外这里提供 `resolveAdvice`：把模型用编号表达的建议映射回本机 Skill 对象。
 * 它是纯函数，所以这段「编号 → 真实文件」的对应关系能被测试覆盖 ——
 * 一旦映射错了，界面上被标记「可去掉」的可能根本不是模型说的那个 Skill。
 */

const candidates = require('./candidates');
const payload = require('./payload');
const advice = require('./advice');
const llm = require('./llm-client');

/**
 * 交给渲染层的 Skill 字段。注意这里**可以**带路径（不出网，本机界面要用），
 * 而交给模型的那份在 payload.js 里另行脱敏，两者不是同一份数据。
 */
function publicSkillFields(skill) {
  return {
    id: skill.id,
    name: skill.name || skill.folderName,
    description: skill.displayDescription || skill.description || '',
    platform: skill.platform || 'shared',
    scope: skill.scope || 'user',
    source: skill.source || '',
    versionHash: String(skill.versionHash || '').slice(0, 12),
    fileCount: skill.fileCount || 0,
    sizeBytes: skill.sizeBytes || 0,
    modifiedAt: skill.modifiedAt || null,
    directoryPath: skill.directoryPath || '',
    referenced: (skill.usage && Number(skill.usage.total)) || 0
  };
}

/**
 * 把解析后的建议映射回真实 Skill。
 *
 * @param {object} parsed parseAdvice 的结果
 * @param {object} context
 * @param {Array} context.skills buildPayload 返回的 skills（含内部 _skill 引用）
 * @param {Array} context.groups findDuplicateCandidates 返回的原始候选组
 */
function resolveAdvice(parsed, context = {}) {
  const skills = Array.isArray(context.skills) ? context.skills : [];
  const groups = Array.isArray(context.groups) ? context.groups : [];
  const referenceToSkill = new Map(skills.map((entry) => [entry.ref, entry._skill]));
  const groupById = new Map(groups.map((group) => [group.id, group]));

  const items = (parsed.groups || []).map((item) => ({
    ...item,
    keep: referenceToSkill.has(item.keep) ? publicSkillFields(referenceToSkill.get(item.keep)) : null,
    drop: item.drop
      .map((ref) => (referenceToSkill.has(ref) ? publicSkillFields(referenceToSkill.get(ref)) : null))
      .filter(Boolean),
    members: ((groupById.get(item.groupId) || {}).members || []).map(publicSkillFields)
  }));

  return { ...parsed, groups: items };
}

module.exports = { advice, candidates, llm, payload, publicSkillFields, resolveAdvice };
