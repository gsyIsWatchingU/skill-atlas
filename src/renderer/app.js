'use strict';

/**
 * 渲染层逻辑。
 *
 * 与主进程的全部交互都经 `window.skillPacker`（preload 暴露的白名单方法）。
 * 这里**没有** fetch、没有 Node API —— 扫描结果由主进程算好后一次性返回。
 *
 * 一个刻意的设计：任何「写入」相关的按钮在这版都不存在。
 * 装不上 Skill 的落差用明确的只读提示补（见侧边栏 readonly-note），
 * 而不是放一个点了没反应的假按钮。
 */

const UI_STATE_KEY = 'skill-packer-ui-state';

const state = {
  view: 'catalog',
  scope: 'all',
  search: '',
  sort: 'name',
  selectedId: null,
  scan: null,
  pendingScrollY: 0,
  cloudUser: null,
  cloudTab: 'mine',
  cloudSkills: [],
  ai: { config: null, candidates: null, preview: null, advice: null }
};

const $ = (id) => document.getElementById(id);

/* ---------------- 工具 ---------------- */

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatRecent(value) {
  if (!value) return '从未';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '从未';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

const PLATFORM_NAMES = { codex: 'Codex', doubao: '豆包', workbuddy: 'WorkBuddy', shared: '共享' };
const SCOPE_NAMES = { user: '用户级', plugin: '插件', system: '内置', project: '项目级', custom: '自定义' };

let toastTimer = null;
function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

/* ---------------- UI 状态持久化 ---------------- */

function saveUiState() {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({
      view: state.view, scope: state.scope, sort: state.sort, search: state.search
    }));
  } catch { /* 隐私模式下忽略 */ }
}

function applyUiState() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
    if (saved.view) state.view = saved.view;
    if (saved.scope) state.scope = saved.scope;
    if (saved.sort) state.sort = saved.sort;
    if (typeof saved.search === 'string') state.search = saved.search;
  } catch { /* 忽略损坏的存档 */ }
  $('search').value = state.search;
  $('sort-order').value = state.sort;
}

/* ---------------- 计算视图数据 ---------------- */

function allSkills() {
  return (state.scan && state.scan.skills) || [];
}

/** 重名检测必须带作用域：Codex 同名 Skill 不合并（docs/solution.md §6） */
function duplicateNames() {
  const counts = new Map();
  for (const skill of allSkills()) {
    const key = String(skill.name || '').trim().toLocaleLowerCase('en-US');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

function getFilteredSkills() {
  const duplicates = duplicateNames();
  const needle = state.search.trim().toLocaleLowerCase('zh-CN');
  let skills = allSkills();

  switch (state.scope) {
    case 'codex': skills = skills.filter((s) => s.platform === 'codex'); break;
    case 'doubao': skills = skills.filter((s) => s.platform === 'doubao'); break;
    case 'workbuddy': skills = skills.filter((s) => s.platform === 'workbuddy'); break;
    case 'shared': skills = skills.filter((s) => s.platform === 'shared'); break;
    case 'duplicate':
      skills = skills.filter((s) => duplicates.has(String(s.name || '').trim().toLocaleLowerCase('en-US')));
      break;
    case 'unused': skills = skills.filter((s) => !(s.usage && s.usage.total > 0)); break;
    case 'usage': skills = skills.filter((s) => s.usage && s.usage.total > 0); break;
    default: break;
  }

  if (needle) {
    skills = skills.filter((skill) => (
      String(skill.name || '').toLocaleLowerCase('zh-CN').includes(needle) ||
      String(skill.displayDescription || skill.description || '').toLocaleLowerCase('zh-CN').includes(needle)
    ));
  }

  const sorted = [...skills];
  switch (state.sort) {
    case 'usage':
      sorted.sort((a, b) => (b.usage ? b.usage.total : 0) - (a.usage ? a.usage.total : 0));
      break;
    case 'modified':
      sorted.sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0));
      break;
    case 'source':
      sorted.sort((a, b) => String(a.source).localeCompare(String(b.source), 'zh-CN'));
      break;
    default:
      sorted.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  }
  return sorted;
}

function updateCounts() {
  const skills = allSkills();
  const scan = state.scan || { roots: [], links: {} };
  const rootResults = scan.roots || [];
  const links = scan.links || {};
  const followed = (links.followed || []).length;
  const outside = (links.outsideRoot || []).length;

  const counts = {
    all: skills.length,
    usage: skills.filter((s) => s.usage && s.usage.total > 0).length,
    codex: skills.filter((s) => s.platform === 'codex').length,
    doubao: skills.filter((s) => s.platform === 'doubao').length,
    workbuddy: skills.filter((s) => s.platform === 'workbuddy').length,
    shared: skills.filter((s) => s.platform === 'shared').length,
    duplicate: 0,
    unused: skills.filter((s) => !(s.usage && s.usage.total > 0)).length
  };
  const duplicates = duplicateNames();
  counts.duplicate = skills.filter((s) => duplicates.has(String(s.name || '').trim().toLocaleLowerCase('en-US'))).length;

  for (const node of document.querySelectorAll('.nav-count')) {
    const key = node.getAttribute('data-count');
    node.textContent = String(counts[key] || 0);
  }

  $('metric-skills').textContent = String(skills.length);
  const platformNames = [...new Set(skills.map((s) => PLATFORM_NAMES[s.platform] || s.platform || '共享'))];
  $('metric-skills-hint').textContent = `${platformNames.length} 个来源：${platformNames.join(' / ')}`;

  const readyRoots = rootResults.filter((root) => root.status === 'ready');
  $('metric-roots').textContent = `${readyRoots.length}/${rootResults.length}`;
  $('metric-roots-hint').textContent = readyRoots.length === rootResults.length
    ? '全部可读'
    : `${rootResults.length - readyRoots.length} 个目录不可用`;

  const usageSummary = (scan.usage && scan.usage.summary) || { usedSkills: 0, totalUses: 0 };
  $('metric-invoked').textContent = String(usageSummary.usedSkills);
  $('metric-invoked-hint').textContent = usageSummary.totalUses
    ? `累计 ${usageSummary.totalUses} 次引用（非调用）`
    : (scan.usage ? '日志里没有引用记录' : '未读取会话日志');

  $('metric-links').textContent = String(followed);
  const linkHint = [];
  if (outside) linkHint.push(`${outside} 个跳出扫描根`);
  const broken = (links.broken || []).length;
  const cycle = (links.cycle || []).length;
  const denied = (links.denied || []).length;
  if (broken) linkHint.push(`${broken} 个失效`);
  if (cycle) linkHint.push(`${cycle} 个成环`);
  if (denied) linkHint.push(`${denied} 个无权限`);
  $('metric-links-hint').textContent = linkHint.length ? linkHint.join('，') : '没有异常链接';
}

/* ---------------- 渲染 ---------------- */

function renderRoots() {
  const list = $('root-list');
  list.textContent = '';
  const roots = (state.scan && state.scan.roots) || [];

  for (const root of roots) {
    const item = document.createElement('li');
    item.className = `root-item is-${root.status}`;

    const main = document.createElement('div');
    main.className = 'root-main';
    const label = document.createElement('span');
    label.className = 'root-label';
    label.textContent = root.label;
    const meta = document.createElement('span');
    meta.className = 'root-meta';
    meta.textContent = root.status === 'ready'
      ? `${root.skillCount} 个 Skill`
      : (root.error || root.status);
    meta.title = root.displayPath || root.path || '';
    main.append(label, meta);
    item.append(main);

    // 只允许移除用户自己加的根；默认根与内置根不给移除入口
    if (root.id.startsWith('custom-')) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button';
      remove.textContent = '×';
      remove.title = '移除这个自定义目录';
      remove.addEventListener('click', async () => {
        const result = await window.skillPacker.removeRoot(root.id);
        if (result) { state.scan = result; render(); showToast('已移除自定义目录'); }
      });
      item.append(remove);
    }
    list.append(item);
  }
}

function renderScopeOptions() {
  const select = $('scope-filter');
  select.textContent = '';
  const options = [
    ['all', '全部'], ['codex', 'Codex'], ['doubao', '豆包'], ['workbuddy', 'WorkBuddy'], ['shared', '共享目录'],
    ['usage', '已调用过'], ['unused', '从未调用'], ['duplicate', '重名技能']
  ];
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = state.scope;
}

function createSkillCard(skill, index) {
  const duplicates = duplicateNames();
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'skill-card';
  card.style.animationDelay = `${Math.min(index * 12, 240)}ms`;

  const head = document.createElement('div');
  head.className = 'skill-card-head';
  const name = document.createElement('strong');
  name.className = 'skill-name';
  name.textContent = skill.name || skill.folderName;
  head.append(name);
  if (skill.usage && skill.usage.total > 0) {
    const badge = document.createElement('span');
    badge.className = 'usage-badge';
    badge.textContent = `×${skill.usage.total}`;
    badge.title = `真实调用 ${skill.usage.total} 次`;
    head.append(badge);
  }
  card.append(head);

  const description = document.createElement('p');
  description.className = 'skill-description';
  description.textContent = skill.displayDescription || skill.description || '暂无描述';
  card.append(description);

  const pills = document.createElement('div');
  pills.className = 'pill-row';
  const platform = document.createElement('span');
  platform.className = `pill pill-${skill.platform || 'shared'}`;
  platform.textContent = PLATFORM_NAMES[skill.platform] || skill.platform || '共享';
  pills.append(platform);

  const scope = document.createElement('span');
  scope.className = 'pill';
  scope.textContent = SCOPE_NAMES[skill.scope] || skill.scope || '用户级';
  pills.append(scope);

  if (skill.customDescription) {
    const custom = document.createElement('span');
    custom.className = 'pill pill-custom';
    custom.textContent = '自定义简介';
    pills.append(custom);
  }
  if (skill.descriptionZh) {
    const zh = document.createElement('span');
    zh.className = 'pill pill-zh';
    zh.textContent = '中文简介';
    pills.append(zh);
  }
  if (duplicates.has(String(skill.name || '').trim().toLocaleLowerCase('en-US'))) {
    const duplicate = document.createElement('span');
    duplicate.className = 'pill pill-warn';
    duplicate.textContent = '重名';
    pills.append(duplicate);
  }
  card.append(pills);

  const foot = document.createElement('div');
  foot.className = 'skill-card-foot';
  const source = document.createElement('span');
  source.textContent = skill.source || '';
  const modified = document.createElement('span');
  modified.textContent = formatRecent(skill.modifiedAt);
  foot.append(source, modified);
  card.append(foot);

  card.addEventListener('click', () => openDetail(skill));
  return card;
}

function renderCatalog() {
  const grid = $('skill-grid');
  grid.textContent = '';
  const skills = getFilteredSkills();
  $('catalog-empty').hidden = skills.length > 0;

  skills.forEach((skill, index) => grid.append(createSkillCard(skill, index)));

  const total = allSkills().length;
  $('catalog-hint').textContent = skills.length === total
    ? `共 ${total} 个 Skill`
    : `筛选出 ${skills.length} / ${total} 个 Skill`;
}

function renderUsageDashboard() {
  const usage = state.scan && state.scan.usage;
  const trend = $('usage-trend');
  trend.textContent = '';
  const ranking = $('usage-ranking');
  ranking.textContent = '';
  const unusedList = $('unused-list');
  unusedList.textContent = '';

  if (!usage) {
    $('usage-note').textContent = '没有读到 Codex 会话日志，无法给出引用统计。';
    return;
  }

  const meta = usage.meta || {};
  $('usage-note').textContent = `来源：${meta.source || 'Codex 本地会话日志'}｜会话文件 ${meta.sessionFiles || 0} 个｜口径：referenced（SKILL.md 被工具调用引用，非真实调用）`;

  const daily = usage.daily || [];
  const max = Math.max(1, ...daily.map((item) => item.count));
  for (const item of daily) {
    const bar = document.createElement('div');
    bar.className = 'trend-bar';
    bar.style.height = `${Math.max(2, Math.round((item.count / max) * 100))}%`;
    bar.title = `${item.date}：${item.count} 次引用`;
    trend.append(bar);
  }
  if (!daily.some((item) => item.count > 0)) {
    const empty = document.createElement('p');
    empty.className = 'panel-empty';
    empty.textContent = '近 30 天没有引用记录。';
    trend.append(empty);
  }

  const top = usage.topSkills || [];
  if (!top.length) {
    const empty = document.createElement('li');
    empty.className = 'panel-empty';
    empty.textContent = '日志里还没有任何 Skill 被引用过。';
    ranking.append(empty);
  }
  top.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = 'ranking-row';
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(index + 1);
    const name = document.createElement('span');
    name.className = 'rank-name';
    name.textContent = item.name;
    const count = document.createElement('span');
    count.className = 'rank-count';
    count.textContent = `${item.total} 次`;
    count.title = `近 30 天 ${item.last30} 次｜最近 ${formatRecent(item.lastUsedAt)}`;    row.append(rank, name, count);
    row.addEventListener('click', () => {
      const skill = allSkills().find((s) => s.id === item.id || s.name === item.name);
      if (skill) openDetail(skill);
    });
    ranking.append(row);
  });

  const unused = allSkills().filter((skill) => !(skill.usage && skill.usage.total > 0));
  if (!unused.length) {
    const empty = document.createElement('li');
    empty.className = 'panel-empty';
    empty.textContent = '所有 Skill 都至少被引用过一次。';
    unusedList.append(empty);
  }
  for (const skill of unused.slice(0, 40)) {
    const row = document.createElement('li');
    row.className = 'unused-row';
    const name = document.createElement('span');
    name.className = 'rank-name';
    name.textContent = skill.name;
    const source = document.createElement('span');
    source.className = 'unused-source';
    source.textContent = skill.source || '';
    row.append(name, source);
    row.addEventListener('click', () => openDetail(skill));
    unusedList.append(row);
  }
  if (unused.length > 40) {
    const more = document.createElement('li');
    more.className = 'panel-empty';
    more.textContent = `还有 ${unused.length - 40} 个未列出。`;
    unusedList.append(more);
  }
}

function setView(view) {
  state.view = view;
  $('view-catalog').hidden = view !== 'catalog';
  $('view-usage').hidden = view !== 'usage';
  $('view-ai').hidden = view !== 'ai';
  $('view-cloud').hidden = view !== 'cloud';
  for (const node of document.querySelectorAll('.nav-item')) {
    // 没有 data-scope 的入口（AI 整理 / 云同步）只比视图名，
    // 否则它们会永远选不中 —— 这类 bug 表现为「点了没反应」
    const scoped = node.hasAttribute('data-scope');
    const active = node.getAttribute('data-view') === view
      && (!scoped || node.getAttribute('data-scope') === state.scope);
    node.classList.toggle('is-active', active);
  }
  saveUiState();
}

/* ---------------- 云同步 ---------------- */

function renderCloudAccount() {
  const user = state.cloudUser;
  $('cloud-user-label').textContent = user ? `${user.displayName || user.email || '已登录'}（${user.email || ''}）` : '未登录';
  $('cloud-logout').hidden = !user;
  $('cloud-login-form').hidden = Boolean(user);
}

function createCloudCard(item) {
  const card = document.createElement('div');
  card.className = 'skill-card';

  const head = document.createElement('div');
  head.className = 'skill-card-head';
  const name = document.createElement('strong');
  name.className = 'skill-name';
  name.textContent = item.name;
  head.append(name);
  card.append(head);

  const desc = document.createElement('p');
  desc.className = 'skill-description';
  desc.textContent = item.zhSummary || item.description || '暂无描述';
  card.append(desc);

  const pills = document.createElement('div');
  pills.className = 'pill-row';
  const vis = document.createElement('span');
  vis.className = `pill ${item.visibility === 'community' ? 'pill-community' : 'pill-private'}`;
  vis.textContent = item.visibility === 'community' ? '社区' : '私有';
  pills.append(vis);
  if (item.authorName) {
    const author = document.createElement('span');
    author.className = 'pill';
    author.textContent = item.authorName;
    pills.append(author);
  }
  card.append(pills);

  const foot = document.createElement('div');
  foot.className = 'skill-card-foot';
  const meta = document.createElement('span');
  meta.textContent = `${item.fileCount || 0} 文件 · ${formatBytes(item.sizeBytes)}`;
  const updated = document.createElement('span');
  updated.textContent = formatRecent(item.updatedAt);
  foot.append(meta, updated);
  card.append(foot);

  const actions = document.createElement('div');
  actions.className = 'cloud-actions';
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'ghost-button';
  download.textContent = '下载到本机';
  download.addEventListener('click', async () => {
    try {
      const dest = await window.skillPacker.cloudDownload({ id: item.id });
      if (dest) showToast(`已下载到 ${dest}`);
    } catch (error) {
      showToast(`下载失败：${error.message || error}`);
    }
  });
  actions.append(download);

  if (state.cloudTab === 'mine') {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ghost-button';
    toggle.textContent = item.visibility === 'community' ? '设为私有' : '发布到社区';
    toggle.addEventListener('click', async () => {
      try {
        await window.skillPacker.cloudSetVisibility({
          id: item.id,
          visibility: item.visibility === 'community' ? 'private' : 'community'
        });
        await loadCloud();
        showToast('已更新可见性');
      } catch (error) {
        showToast(`更新失败：${error.message || error}`);
      }
    });
    actions.append(toggle);
  }
  card.append(actions);
  return card;
}

function renderCloud() {
  renderCloudAccount();
  $('cloud-tab-mine').classList.toggle('is-active', state.cloudTab === 'mine');
  $('cloud-tab-community').classList.toggle('is-active', state.cloudTab === 'community');

  const grid = $('cloud-grid');
  grid.textContent = '';
  const items = state.cloudSkills || [];
  $('cloud-empty').hidden = items.length > 0;

  if (!state.cloudUser) {
    $('cloud-hint').textContent = '用统一账号登录后，跨机查看并下载你的 Skill。';
    $('cloud-empty').hidden = true;
    return;
  }
  $('cloud-hint').textContent = state.cloudTab === 'mine'
    ? `我的 Skill · 共 ${items.length} 个`
    : `Skill 社区 · 共 ${items.length} 个`;
  items.forEach((item) => grid.append(createCloudCard(item)));
}

async function loadCloud() {
  if (!state.cloudUser) {
    state.cloudSkills = [];
    renderCloud();
    return;
  }
  $('cloud-hint').textContent = '正在加载…';
  try {
    state.cloudSkills = await window.skillPacker.cloudList(state.cloudTab);
  } catch (error) {
    state.cloudSkills = [];
    showToast(`加载云端失败：${error.message || error}`);
  }
  renderCloud();
}

/* ---------------- AI 整理 ---------------- */

const AI_REASON_LABELS = {
  'same-name': '同名',
  'same-content': '内容完全相同',
  similar: '语义接近'
};

function aiHint(text) {
  $('ai-hint').textContent = text;
}

function renderAiConfig() {
  const config = state.ai.config;
  if (!config) return;
  $('ai-enabled').checked = config.enabled === true;
  $('ai-base-url').value = config.baseUrl || '';
  $('ai-model').value = config.model || '';
  $('ai-api-key').value = '';
  $('ai-include-body').checked = config.includeBody === true;
  $('ai-api-key').placeholder = config.apiKeySet
    ? `已保存 ${config.apiKeyMask}，留空表示不改`
    : '本地模型可留空';

  const missing = [];
  if (!config.baseUrl) missing.push('接口地址');
  if (!config.model) missing.push('模型名');
  $('ai-key-note').textContent = config.enabled
    ? (missing.length
      ? `已开启，还缺：${missing.join('、')}`
      : '已开启：生成建议时会向你填的地址发一次请求')
    : '未开启：粗筛与预览本就不出网，生成建议也不会发请求';
}

/** 候选/建议里的成员条目。点击跳到详情面板看完整信息 */
function createAiMemberRow(skill, role) {
  const row = document.createElement('li');
  row.className = `ai-member${role ? ` is-${role}` : ''}`;

  const head = document.createElement('div');
  head.className = 'ai-member-head';
  const name = document.createElement('strong');
  name.textContent = skill.name || '(无名)';
  head.append(name);
  if (role === 'keep') {
    const badge = document.createElement('span');
    badge.className = 'ai-badge is-keep';
    badge.textContent = '建议保留';
    head.append(badge);
  }
  if (role === 'drop') {
    const badge = document.createElement('span');
    badge.className = 'ai-badge is-drop';
    badge.textContent = '可去掉';
    head.append(badge);
  }
  row.append(head);

  const pills = document.createElement('div');
  pills.className = 'pill-row';
  const platform = document.createElement('span');
  platform.className = `pill pill-${skill.platform || 'shared'}`;
  platform.textContent = PLATFORM_NAMES[skill.platform] || skill.platform || '共享';
  pills.append(platform);
  const scope = document.createElement('span');
  scope.className = 'pill';
  scope.textContent = SCOPE_NAMES[skill.scope] || skill.scope || '用户级';
  pills.append(scope);
  const hash = document.createElement('span');
  hash.className = 'pill pill-mono';
  hash.textContent = `hash ${skill.versionHash || '—'}`;
  pills.append(hash);
  row.append(pills);

  const meta = document.createElement('div');
  meta.className = 'ai-member-meta';
  const source = document.createElement('span');
  source.textContent = `${skill.source || '—'} · ${skill.fileCount} 文件 · ${formatBytes(skill.sizeBytes)}`;
  const modified = document.createElement('span');
  modified.textContent = formatRecent(skill.modifiedAt);
  meta.append(source, modified);
  row.append(meta);

  if (skill.description) {
    const description = document.createElement('p');
    description.className = 'ai-member-desc';
    description.textContent = skill.description;
    row.append(description);
  }

  row.addEventListener('click', () => {
    const full = allSkills().find((item) => item.id === skill.id);
    if (full) openDetail(full);
  });
  return row;
}

function createAiGroupCard(group, options = {}) {
  const card = document.createElement('div');
  card.className = 'ai-group';

  const head = document.createElement('div');
  head.className = 'ai-group-head';
  const reason = document.createElement('span');
  reason.className = `pill pill-${group.reason === 'similar' ? 'warn' : 'plain'}`;
  reason.textContent = AI_REASON_LABELS[group.reason] || group.reason;
  head.append(reason);

  if (options.verdictLabel) {
    const verdict = document.createElement('span');
    verdict.className = `ai-verdict is-${options.verdict || 'distinct'}`;
    verdict.textContent = options.verdictLabel;
    head.append(verdict);
  }
  if (typeof options.confidence === 'number') {
    const confidence = document.createElement('span');
    confidence.className = 'ai-confidence';
    confidence.textContent = `置信度 ${Math.round(options.confidence * 100)}%`;
    head.append(confidence);
  }
  if (options.advice) {
    const advice = document.createElement('span');
    advice.className = 'ai-advice-text';
    advice.textContent = options.advice;
    head.append(advice);
  }
  card.append(head);

  if (options.reason) {
    const why = document.createElement('p');
    why.className = 'ai-reason';
    why.textContent = options.reason;
    card.append(why);
  }

  const list = document.createElement('ul');
  list.className = 'ai-member-list';
  const keepId = options.keepId || null;
  const dropIds = new Set(options.dropIds || []);
  for (const member of group.members || []) {
    const role = member.id === keepId ? 'keep' : (dropIds.has(member.id) ? 'drop' : null);
    list.append(createAiMemberRow(member, role));
  }
  card.append(list);
  return card;
}

function renderAiCandidates() {
  const container = $('ai-candidates');
  container.textContent = '';
  const data = state.ai.candidates;
  if (!data) return;

  const stats = data.stats || {};
  const note = document.createElement('p');
  note.className = 'ai-section-note';
  note.textContent = `本地粗筛：看了 ${stats.scanned} 个 Skill，命中 ${stats.candidateSkills} 个，共 ${stats.groupCount} 组`
    + `（同名 ${stats.sameName}／内容相同 ${stats.sameContent}／语义接近 ${stats.similar}）`
    + (stats.similaritySkipped ? `；${stats.similaritySkipped} 个超出语义比对上限，未参与相似度计算` : '');
  container.append(note);

  if (!data.groups.length) {
    const empty = document.createElement('p');
    empty.className = 'panel-empty';
    empty.textContent = '没有发现疑似重复的 Skill，不必惊动模型。';
    container.append(empty);
    return;
  }
  for (const group of data.groups) container.append(createAiGroupCard(group));
}

function renderAiAdvice() {
  const container = $('ai-advice');
  container.textContent = '';
  const advice = state.ai.advice;
  if (!advice) return;

  if (advice.empty) {
    const empty = document.createElement('p');
    empty.className = 'panel-empty';
    empty.textContent = '没有候选，未向模型发送任何内容。';
    container.append(empty);
    return;
  }
  if (advice.error) {
    const error = document.createElement('p');
    error.className = 'ai-error';
    error.textContent = advice.error;
    container.append(error);
    return;
  }

  const meta = document.createElement('p');
  meta.className = 'ai-section-note';
  const tokens = advice.usage
    ? `｜prompt ${advice.usage.prompt_tokens || 0} / completion ${advice.usage.completion_tokens || 0} tokens`
    : '';
  meta.textContent = `模型 ${advice.model || '—'}｜${advice.endpoint || '—'}${tokens}｜原始回复 ${advice.rawLength || 0} 字`;
  container.append(meta);

  if (advice.summary) {
    const summary = document.createElement('p');
    summary.className = 'ai-summary';
    summary.textContent = advice.summary;
    container.append(summary);
  }

  for (const group of advice.groups || []) {
    container.append(createAiGroupCard(
      { reason: group.reason || 'similar', members: group.members || [] },
      {
        verdict: group.verdict,
        verdictLabel: group.verdictLabel,
        advice: group.advice,
        confidence: group.confidence,
        reason: group.reason,
        keepId: group.keep && group.keep.id,
        dropIds: (group.drop || []).map((item) => item.id)
      }
    ));
  }

  if ((advice.rejected || []).length) {
    const note = document.createElement('p');
    note.className = 'ai-reject';
    note.textContent = `忽略了 ${advice.rejected.length} 条无法核对的建议（模型引用了不存在的编号或跨组比较）：`
      + advice.rejected.map((item) => item.reason).join('；');
    container.append(note);
  }
  if ((advice.missingGroups || []).length) {
    const note = document.createElement('p');
    note.className = 'ai-reject';
    note.textContent = `${advice.missingGroups.length} 个候选组模型没有给出结论，已如实留空，不替它编。`;
    container.append(note);
  }
}

function renderAi() {
  renderAiConfig();
  renderAiCandidates();
  renderAiAdvice();
}

async function saveAiConfig(patch) {
  state.ai.config = await window.skillPacker.aiSetConfig(patch);
  renderAiConfig();
}

/** 出网前的两步：先看清要发什么，再确认发送 */
function resetAdviseButton() {
  state.ai.pendingPreview = false;
  $('ai-advise-btn').textContent = '3 · 生成整理建议（会出网）';
}

async function runAiCandidates() {
  const button = $('ai-candidates-btn');
  button.disabled = true;
  button.textContent = '粗筛中…';
  try {
    state.ai.candidates = await window.skillPacker.aiCandidates();
    renderAiCandidates();
    const stats = state.ai.candidates.stats || {};
    aiHint(stats.groupCount
      ? `本地粗筛完成，${stats.groupCount} 组候选。这一步没有产生任何网络请求。`
      : '本地粗筛完成，没有发现疑似重复，不必调用模型。');
    resetAdviseButton();
  } catch (error) {
    aiHint(`粗筛失败：${error.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = '1 · 本地粗筛（不出网）';
  }
}

async function runAiPreview() {
  const button = $('ai-preview-btn');
  button.disabled = true;
  button.textContent = '生成预览…';
  try {
    const result = await window.skillPacker.aiPreview();
    state.ai.preview = result;
    const box = $('ai-payload-preview');
    if (result.empty || !result.payload) {
      box.hidden = true;
      box.textContent = '';
      aiHint('没有候选，没有东西要发送。');
      return;
    }
    const preview = result.preview;
    box.hidden = false;
    box.textContent = JSON.stringify(result.payload, null, 2);
    aiHint(`将要发送：${preview.skillCount} 个 Skill / ${preview.groupCount} 组 / 约 ${preview.estimatedChars} 字符`
      + `；字段：${preview.fields.join('、')}`
      + `；${preview.includesBody ? '含正文摘要' : '不含正文'}`
      + `；发往 ${preview.endpoint || '（未填地址）'}`);
  } catch (error) {
    aiHint(`预览失败：${error.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = '2 · 预览将要发送的内容';
  }
}

async function runAiAdvise() {
  const button = $('ai-advise-btn');
  if (!state.ai.pendingPreview) {
    await runAiPreview();
    if (!state.ai.preview || state.ai.preview.empty) return;
    state.ai.pendingPreview = true;
    button.textContent = `确认发送到 ${state.ai.preview.preview.endpoint || '模型'}（约 ${state.ai.preview.preview.estimatedChars} 字符）`;
    return;
  }

  button.disabled = true;
  button.textContent = '等待模型…';
  try {
    state.ai.advice = await window.skillPacker.aiAdvise();
    renderAiAdvice();
    const advice = state.ai.advice;
    aiHint(advice.error
      ? advice.error
      : `模型给出 ${(advice.groups || []).length} 条建议${(advice.rejected || []).length ? `，忽略 ${advice.rejected.length} 条无法核对的` : ''}。只建议，不动文件。`);
  } catch (error) {
    aiHint(`生成建议失败：${error.message || error}`);
  } finally {
    button.disabled = false;
    resetAdviseButton();
  }
}

/* ---------------- 详情面板 ---------------- */

function currentSelected() {
  return allSkills().find((skill) => skill.id === state.selectedId) || null;
}

function openDetail(skill) {
  state.selectedId = skill.id;
  const duplicates = duplicateNames();
  const usage = skill.usage || { total: 0, last30: 0, lastUsedAt: null };

  $('detail-avatar').textContent = String(skill.name || 'S').slice(0, 1).toUpperCase();
  $('detail-name').textContent = skill.name || skill.folderName;

  const pills = $('detail-pills');
  pills.textContent = '';
  const platform = document.createElement('span');
  platform.className = `pill pill-${skill.platform || 'shared'}`;
  platform.textContent = PLATFORM_NAMES[skill.platform] || skill.platform || '共享';
  pills.append(platform);
  const scope = document.createElement('span');
  scope.className = 'pill';
  scope.textContent = SCOPE_NAMES[skill.scope] || skill.scope || '用户级';
  pills.append(scope);

  const alert = $('detail-alert');
  const alerts = [];
  if (duplicates.has(String(skill.name || '').trim().toLocaleLowerCase('en-US'))) {
    alerts.push('存在同名 Skill。Codex 不会合并同名 Skill，两个都会出现在选择器里——需要你用作用域区分，或收窄其中一个的描述。');
  }
  if (!skill.description || skill.description === '暂无描述') {
    alerts.push('缺少 description。这会直接影响 Agent 能否匹配到它。');
  }
  if (alerts.length) {
    alert.textContent = alerts.join(' ');
    alert.hidden = false;
  } else {
    alert.hidden = true;
  }

  $('detail-description').textContent = skill.displayDescription || skill.description || '暂无描述';
  $('detail-description-source').textContent = skill.customDescription
    ? '来源：你写的自定义简介'
    : '来源：SKILL.md 的 frontmatter';

  const zhEl = $('detail-description-zh');
  const zhSourceEl = $('detail-description-zh-source');
  if (skill.descriptionZh) {
    zhEl.hidden = false;
    zhEl.textContent = skill.descriptionZh;
    zhSourceEl.hidden = false;
    zhSourceEl.textContent = '来源：中文简介（自动翻译或手动维护，仅存本机）';
  } else {
    zhEl.hidden = true;
    zhEl.textContent = '';
    zhSourceEl.hidden = true;
    zhSourceEl.textContent = '';
  }

  $('detail-source').textContent = `${skill.source || '—'}（${skill.rootId || '—'}）`;
  $('detail-path').textContent = skill.directoryPath || '—';
  $('detail-files').textContent = `${skill.fileCount} 个文件${skill.skippedSensitive ? `（已跳过 ${skill.skippedSensitive} 个凭据类文件）` : ''}`;
  $('detail-size').textContent = formatBytes(skill.sizeBytes);
  $('detail-modified').textContent = formatDate(skill.modifiedAt);
  $('detail-hash').textContent = String(skill.versionHash || '').slice(0, 16);

  $('detail-usage').textContent = `${usage.total} 次`;
  $('detail-usage30').textContent = `${usage.last30} 次`;
  $('detail-lastused').textContent = formatRecent(usage.lastUsedAt);

  $('detail-panel').hidden = false;
}

function closeDetail() {
  state.selectedId = null;
  $('detail-panel').hidden = true;
}

/* ---------------- 扫描 ---------------- */

function render() {
  updateCounts();
  renderRoots();
  renderScopeOptions();
  renderCatalog();
  renderUsageDashboard();
  renderCloud();
  renderAi();
  setView(state.view === 'usage' ? 'usage'
    : state.view === 'ai' ? 'ai'
      : state.view === 'cloud' ? 'cloud' : 'catalog');
}

async function scan() {
  const button = $('rescan');
  button.disabled = true;
  button.textContent = '扫描中…';
  try {
    state.scan = await window.skillPacker.scan();
    if (state.pendingScrollY) {
      window.scrollTo(0, state.pendingScrollY);
      state.pendingScrollY = 0;
    }
  } catch (error) {
    showToast(`扫描失败：${error.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = '重新扫描';
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  for (const node of document.querySelectorAll('.nav-item')) {
    node.addEventListener('click', () => {
      const view = node.getAttribute('data-view');
      // 只有目录视图才有范围概念；AI 整理 / 云同步点进去不该把 scope 清成 null
      if (view === 'catalog') state.scope = node.getAttribute('data-scope');
      setView(view);
      renderCatalog();
      saveUiState();
    });
  }

  $('scope-filter').addEventListener('change', (event) => {
    state.scope = event.target.value;
    renderCatalog();
    saveUiState();
  });

  $('sort-order').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderCatalog();
    saveUiState();
  });

  $('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderCatalog();
    saveUiState();
  });

  $('rescan').addEventListener('click', async () => { await scan(); render(); });

  $('manage-roots').addEventListener('click', async () => {
    try {
      const result = await window.skillPacker.addRoot();
      if (result) { state.scan = result; render(); showToast('已加入自定义目录'); }
    } catch (error) {
      showToast(`添加目录失败：${error.message || error}`);
    }
  });

  $('reload-ui').addEventListener('click', async () => { await window.skillPacker.reloadUi(); });

  $('export-inventory').addEventListener('click', async () => {
    try {
      const file = await window.skillPacker.exportInventory();
      if (file) showToast('清单已导出（不含脚本内容）');
    } catch (error) {
      showToast(`导出失败：${error.message || error}`);
    }
  });

  $('detail-close').addEventListener('click', closeDetail);

  $('open-skill').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    try {
      await window.skillPacker.openSkillFile(`${skill.directoryPath}\\SKILL.md`);
    } catch (error) {
      showToast(`打开失败：${error.message || error}`);
    }
  });

  $('reveal-skill').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    try {
      await window.skillPacker.revealSkillFile(`${skill.directoryPath}\\SKILL.md`);
    } catch (error) {
      showToast(`定位失败：${error.message || error}`);
    }
  });

  $('copy-path').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    await window.skillPacker.copyText(skill.directoryPath || '');
    showToast('已复制目录路径');
  });

  $('edit-description').addEventListener('click', () => {
    const skill = currentSelected();
    if (!skill) return;
    const input = $('description-input');
    input.value = skill.customDescription || '';
    $('description-count').textContent = `${input.value.length} / 300`;
    $('description-dialog').showModal();
  });

  $('description-input').addEventListener('input', (event) => {
    $('description-count').textContent = `${event.target.value.length} / 300`;
  });

  $('cancel-description').addEventListener('click', () => { $('description-dialog').close(); });

  $('clear-description').addEventListener('click', () => {
    $('description-input').value = '';
    $('description-count').textContent = '0 / 300';
  });

  $('save-description').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    const description = $('description-input').value.trim();
    await window.skillPacker.setDescription(skill.id, description);
    // 就地更新，不重扫磁盘
    skill.customDescription = description;
    skill.displayDescription = skill.descriptionZh || description || skill.description || '暂无描述';
    $('description-dialog').close();
    renderCatalog();
    openDetail(skill);
    showToast('已保存，正在翻译中文简介…');
    // 自动翻译钩子：保存自定义简介后顺手生成/刷新中文简介
    try {
      const result = await window.skillPacker.translateDescriptionZh(skill.id);
      skill.descriptionZh = (result && result.descriptionZh) || '';
      skill.displayDescription = skill.descriptionZh || description || skill.description || '暂无描述';
      renderCatalog();
      openDetail(skill);
      showToast('中文简介已更新');
    } catch (error) {
      showToast(`翻译失败：${error.message || error}`);
    }
  });

  $('translate-one').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    const button = $('translate-one');
    button.disabled = true;
    button.textContent = '翻译中…';
    try {
      const result = await window.skillPacker.translateDescriptionZh(skill.id);
      skill.descriptionZh = (result && result.descriptionZh) || '';
      skill.displayDescription = skill.descriptionZh || skill.customDescription || skill.description || '暂无描述';
      renderCatalog();
      openDetail(skill);
      showToast('已翻译为中文');
    } catch (error) {
      showToast(`翻译失败：${error.message || error}`);
    } finally {
      button.disabled = false;
      button.textContent = '翻译成中文';
    }
  });

  $('edit-description-zh').addEventListener('click', () => {
    const skill = currentSelected();
    if (!skill) return;
    const input = $('description-zh-input');
    input.value = skill.descriptionZh || '';
    $('description-zh-count').textContent = `${input.value.length} / 300`;
    $('description-zh-dialog').showModal();
  });

  $('description-zh-input').addEventListener('input', (event) => {
    $('description-zh-count').textContent = `${event.target.value.length} / 300`;
  });

  $('clear-description-zh').addEventListener('click', () => {
    $('description-zh-input').value = '';
    $('description-zh-count').textContent = '0 / 300';
  });

  $('cancel-description-zh').addEventListener('click', () => { $('description-zh-dialog').close(); });

  $('save-description-zh').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    const zh = $('description-zh-input').value.trim();
    await window.skillPacker.setDescriptionZh(skill.id, zh);
    skill.descriptionZh = zh;
    skill.displayDescription = zh || skill.customDescription || skill.description || '暂无描述';
    $('description-zh-dialog').close();
    renderCatalog();
    openDetail(skill);
    showToast(zh ? '中文简介已保存' : '已清空中文简介');
  });

  $('translate-all').addEventListener('click', async () => {
    const button = $('translate-all');
    button.disabled = true;
    button.textContent = '翻译中…';
    try {
      const result = await window.skillPacker.translateAllDescriptionZh();
      // 翻译结果已落盘，重扫一次把中文简介刷进内存
      state.scan = await window.skillPacker.scan();
      render();
      const total = (result && result.total) || 0;
      const saved = (result && result.saved) || 0;
      const failed = (result && result.failed) || 0;
      showToast(total === 0
        ? '所有 Skill 都已有中文简介'
        : `已翻译 ${saved} 个${failed ? `，失败 ${failed} 个` : ''}`);
    } catch (error) {
      showToast(`批量翻译失败：${error.message || error}`);
    } finally {
      button.disabled = false;
      button.textContent = '一键转中文';
    }
  });

  /* AI 整理 */
  $('ai-enabled').addEventListener('change', async (event) => {
    await saveAiConfig({ enabled: event.target.checked });
    resetAdviseButton();
    showToast(event.target.checked ? '已开启：生成建议时会向模型发送一次请求' : '已关闭：不会再有出网请求');
  });

  $('ai-save-config').addEventListener('click', async () => {
    const key = $('ai-api-key').value.trim();
    await saveAiConfig({
      baseUrl: $('ai-base-url').value.trim(),
      model: $('ai-model').value.trim(),
      apiKey: key || ((state.ai.config && state.ai.config.apiKeyMask) || ''),
      includeBody: $('ai-include-body').checked
    });
    resetAdviseButton();
    showToast('配置已保存到本机');
  });

  $('ai-candidates-btn').addEventListener('click', runAiCandidates);
  $('ai-preview-btn').addEventListener('click', runAiPreview);
  $('ai-advise-btn').addEventListener('click', runAiAdvise);

  $('ai-export-btn').addEventListener('click', async () => {
    if (!state.ai.advice) {
      showToast('还没有建议可导出');
      return;
    }
    try {
      const file = await window.skillPacker.aiExport({
        generatedAt: new Date().toISOString(),
        ...state.ai.advice
      });
      if (file) showToast('建议已导出');
    } catch (error) {
      showToast(`导出失败：${error.message || error}`);
    }
  });

  $('cloud-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('cloud-login');
    button.disabled = true;
    button.textContent = '登录中…';
    try {
      const result = await window.skillPacker.cloudLogin({
        email: $('cloud-email').value.trim(),
        password: $('cloud-password').value
      });
      state.cloudUser = result.user;
      $('cloud-password').value = '';
      await loadCloud();
      showToast('登录成功');
    } catch (error) {
      showToast(`登录失败：${error.message || error}`);
    } finally {
      button.disabled = false;
      button.textContent = '登录';
    }
  });

  $('cloud-logout').addEventListener('click', async () => {
    await window.skillPacker.cloudLogout();
    state.cloudUser = null;
    state.cloudSkills = [];
    renderCloud();
    showToast('已退出登录');
  });

  $('cloud-tab-mine').addEventListener('click', async () => {
    state.cloudTab = 'mine';
    await loadCloud();
  });

  $('cloud-tab-community').addEventListener('click', async () => {
    state.cloudTab = 'community';
    await loadCloud();
  });

  $('cloud-refresh').addEventListener('click', async () => { await loadCloud(); });

  $('upload-cloud').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    if (!state.cloudUser) {
      showToast('请先在「云同步」页登录');
      return;
    }
    try {
      await window.skillPacker.cloudUpload({ skill, visibility: 'private' });
      showToast('已上传到云端（私有）');
    } catch (error) {
      showToast(`上传失败：${error.message || error}`);
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase('en-US') === 'k') {
      event.preventDefault();
      $('search').focus();
      $('search').select();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLocaleLowerCase('en-US') === 'r') {
      event.preventDefault();
      window.skillPacker.reloadUi();
      return;
    }
    if (event.key === 'Escape') {
      if (!$('description-dialog').open && !$('detail-panel').hidden) closeDetail();
    }
  });

  // 重新加载后回到原来的位置，避免每次扫描都跳回顶部
  window.addEventListener('beforeunload', () => {
    state.pendingScrollY = window.scrollY;
    saveUiState();
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  applyUiState();
  bindEvents();
  try {
    $('app-version').textContent = `v${await window.skillPacker.version()}`;
  } catch {
    $('app-version').textContent = 'v—';
  }
  try {
    state.cloudUser = await window.skillPacker.cloudMe();
  } catch {
    state.cloudUser = null;
  }
  try {
    state.ai.config = await window.skillPacker.aiConfig();
  } catch {
    state.ai.config = null;
  }
  await scan();
  render();
}

boot();
