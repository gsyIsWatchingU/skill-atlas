'use strict';

/**
 * 整理候选的本地粗筛 —— 纯函数，不出网、不碰盘。
 *
 * 为什么先本地粗筛再交给模型（而不是把整个技能库丢过去）：
 *   1. 几百个 Skill 全量进 prompt 既贵又容易被截断，模型还容易漏看；
 *   2. 同名 / 同哈希这种判断是确定性的，不需要模型，交给模型只会引入幻觉；
 *   3. 真正需要模型的是「语义重叠」——名字不同但干的是同一件事，
 *      这种用规则做不出来，才值得花 token。
 *
 * 所以分工是：本地负责「哪些值得看」，模型负责「这些是不是重复、留哪个」。
 *
 * 作用域纪律（docs/solution.md §6）：同名不同平台的 Skill **不合并**，
 * 只是作为候选列出，让模型带上作用域去判断。
 */

const MAX_SKILLS_FOR_SIMILARITY = 400;
const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
const PLACEHOLDER_DESCRIPTIONS = new Set(['', '暂无描述', 'no description']);

/** 名称归一：小写、去掉分隔符与常见前后缀噪音，用于「同名」判定 */
function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[_\s.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/**
 * 分词：英文按非字母数字切，中文按字 bigram（「代码审查」→ 代码/码审/审查）。
 * 中英混排时两边各自的词都进集合。
 */
function tokenize(value) {
  const text = String(value || '').normalize('NFKC').toLocaleLowerCase('en-US');
  const tokens = new Set();
  for (const word of text.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!word) continue;
    // 纯 ASCII 段整体成词
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length >= 2) tokens.add(word);
      continue;
    }
    // 含汉字的段：拆出连续汉字串做 bigram，其余 ASCII 段单独成词
    for (const chunk of word.split(/([a-z0-9]+)/)) {
      if (!chunk) continue;
      if (/^[a-z0-9]+$/.test(chunk)) {
        if (chunk.length >= 2) tokens.add(chunk);
        continue;
      }
      const cjk = chunk.replace(/[^\u4e00-\u9fff]/g, '');
      if (cjk.length === 1) tokens.add(cjk);
      for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(cjk.slice(i, i + 2));
    }
  }
  return tokens;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function hasDescription(skill) {
  return !PLACEHOLDER_DESCRIPTIONS.has(String(skill.description || '').trim().toLocaleLowerCase('en-US'));
}

/** 并查集：把两两相似的关系并成组，避免出现「A~B、B~C」被拆成两组 */
function unionGroups(pairs, size) {
  const parent = Array.from({ length: size }, (_unused, index) => index);
  const find = (node) => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    while (parent[node] !== root) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const [a, b] of pairs) union(a, b);

  const buckets = new Map();
  for (let index = 0; index < size; index += 1) {
    const root = find(index);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(index);
  }
  return [...buckets.values()].filter((members) => members.length > 1);
}

/**
 * 粗筛整理候选。
 *
 * @param {Array} skills 扫描结果里的 Skill（含 name/description/versionHash/platform/scope）
 * @param {object} [options]
 * @param {boolean} [options.includeSystem=false] 是否把系统内置 Skill 也纳入（默认只整理个人 Skill）
 * @param {number}  [options.threshold=0.6] 语义相似阈值
 * @returns {{groups: Array, stats: object}}
 *   group = { id, reason, score, members: Skill[] }
 *   reason: 'same-name' | 'same-content' | 'similar'
 */
function findDuplicateCandidates(skills, options = {}) {
  const list = (Array.isArray(skills) ? skills : [])
    .filter((skill) => (options.includeSystem ? true : skill.ownership !== 'system'));
  const threshold = Number.isFinite(options.threshold)
    ? Math.min(0.95, Math.max(0.2, options.threshold))
    : DEFAULT_SIMILARITY_THRESHOLD;

  const groups = [];
  const claimed = new Set(); // 已进入某个组的 Skill，避免重复出现在多个组
  const byName = new Map();
  const byHash = new Map();

  for (const skill of list) {
    const nameKey = normalizeName(skill.name || skill.folderName);
    if (nameKey) {
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(skill);
    }
    if (skill.versionHash) {
      if (!byHash.has(skill.versionHash)) byHash.set(skill.versionHash, []);
      byHash.get(skill.versionHash).push(skill);
    }
  }

  // 1) 同名（跨平台的同名也列出来，但不合并——作用域由模型带进去判断）
  for (const [key, members] of byName.entries()) {
    if (members.length < 2) continue;
    groups.push({
      id: `name:${key}`,
      reason: 'same-name',
      score: 1,
      members: [...members]
    });
    for (const skill of members) claimed.add(skill);
  }

  // 2) 内容完全相同但名字不同（改名副本 / 拷到别处的同一份）
  for (const [hash, members] of byHash.entries()) {
    const fresh = members.filter((skill) => !claimed.has(skill));
    if (fresh.length < 2) continue;
    groups.push({
      id: `hash:${String(hash).slice(0, 12)}`,
      reason: 'same-content',
      score: 1,
      members: fresh
    });
    for (const skill of fresh) claimed.add(skill);
  }

  // 3) 语义重叠：名字不同、内容也不同，但描述讲的是同一件事
  let similaritySkipped = 0;
  const pool = list.filter((skill) => !claimed.has(skill));
  if (pool.length > MAX_SKILLS_FOR_SIMILARITY) {
    similaritySkipped = pool.length - MAX_SKILLS_FOR_SIMILARITY;
  }
  const comparable = pool.slice(0, MAX_SKILLS_FOR_SIMILARITY);
  const signatures = comparable.map((skill) => ({
    name: tokenize(skill.name || skill.folderName),
    description: hasDescription(skill) ? tokenize(skill.description) : new Set()
  }));

  const pairs = [];
  const pairScores = new Map();
  for (let i = 0; i < comparable.length; i += 1) {
    for (let j = i + 1; j < comparable.length; j += 1) {
      const a = signatures[i];
      const b = signatures[j];
      const nameScore = jaccard(a.name, b.name);
      const descriptionScore = a.description.size && b.description.size
        ? jaccard(a.description, b.description)
        : 0;
      const score = Math.max(nameScore, descriptionScore);
      if (score < threshold) continue;
      pairs.push([i, j]);
      pairScores.set(`${i}:${j}`, score);
    }
  }

  for (const members of unionGroups(pairs, comparable.length)) {
    const score = members.reduce((max, index, position) => {
      let local = max;
      for (let k = position + 1; k < members.length; k += 1) {
        const value = pairScores.get(`${index}:${members[k]}`) || 0;
        if (value > local) local = value;
      }
      return local;
    }, 0);
    groups.push({
      id: `similar:${members.map((index) => index).join('-')}`,
      reason: 'similar',
      score: Number(score.toFixed(3)),
      members: members.map((index) => comparable[index])
    });
    for (const index of members) claimed.add(comparable[index]);
  }

  groups.sort((a, b) => (
    (b.members.length - a.members.length) || (b.score - a.score) || String(a.id).localeCompare(String(b.id))
  ));

  return {
    groups,
    stats: {
      scanned: list.length,
      candidateSkills: claimed.size,
      groupCount: groups.length,
      sameName: groups.filter((group) => group.reason === 'same-name').length,
      sameContent: groups.filter((group) => group.reason === 'same-content').length,
      similar: groups.filter((group) => group.reason === 'similar').length,
      similaritySkipped
    }
  };
}

module.exports = {
  DEFAULT_SIMILARITY_THRESHOLD,
  MAX_SKILLS_FOR_SIMILARITY,
  findDuplicateCandidates,
  jaccard,
  normalizeName,
  tokenize
};
