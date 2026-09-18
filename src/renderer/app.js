'use strict';

/**
 * 渲染层逻辑。
 *
 * 与主进程的全部交互都经 `window.skillDock`（preload 暴露的白名单方法）。
 * 这里**没有** fetch、没有 Node API —— 扫描结果由主进程算好后一次性返回。
 *
 * 一个刻意的设计：任何「写入」相关的按钮在这版都不存在。
 * 装不上 Skill 的落差用明确的只读提示补（见侧边栏 readonly-note），
 * 而不是放一个点了没反应的假按钮。
 */

const UI_STATE_KEY = 'skill-dock-ui-state';

const state = {
  view: 'catalog',
  scope: 'all',
  search: '',
  sort: 'name',
  selectedId: null,
  scan: null,
  pendingScrollY: 0
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

const PLATFORM_NAMES = { codex: 'Codex', trae: 'Trae', shared: '共享' };
const SCOPE_NAMES = { user: '用户级', plugin: '插件', cli: 'CLI', project: '项目级', custom: '自定义' };

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
    case 'trae': skills = skills.filter((s) => s.platform === 'trae'); break;
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
    trae: skills.filter((s) => s.platform === 'trae').length,
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
  const readyRoots = rootResults.filter((root) => root.status === 'ready');
  $('metric-skills-hint').textContent = `${skills.filter((s) => s.platform === 'codex').length} 个来自 Codex`;

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
        const result = await window.skillDock.removeRoot(root.id);
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
    ['all', '全部'], ['codex', 'Codex'], ['trae', 'Trae'], ['shared', '共享目录'],
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
  for (const node of document.querySelectorAll('.nav-item')) {
    node.classList.toggle('is-active', node.getAttribute('data-view') === view && node.getAttribute('data-scope') === state.scope);
  }
  saveUiState();
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
  setView(state.view === 'usage' ? 'usage' : 'catalog');
}

async function scan() {
  const button = $('rescan');
  button.disabled = true;
  button.textContent = '扫描中…';
  try {
    state.scan = await window.skillDock.scan();
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
      state.scope = node.getAttribute('data-scope');
      setView(node.getAttribute('data-view'));
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
      const result = await window.skillDock.addRoot();
      if (result) { state.scan = result; render(); showToast('已加入自定义目录'); }
    } catch (error) {
      showToast(`添加目录失败：${error.message || error}`);
    }
  });

  $('reload-ui').addEventListener('click', async () => { await window.skillDock.reloadUi(); });

  $('export-inventory').addEventListener('click', async () => {
    try {
      const file = await window.skillDock.exportInventory();
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
      await window.skillDock.openSkillFile(`${skill.directoryPath}\\SKILL.md`);
    } catch (error) {
      showToast(`打开失败：${error.message || error}`);
    }
  });

  $('reveal-skill').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    try {
      await window.skillDock.revealSkillFile(`${skill.directoryPath}\\SKILL.md`);
    } catch (error) {
      showToast(`定位失败：${error.message || error}`);
    }
  });

  $('copy-path').addEventListener('click', async () => {
    const skill = currentSelected();
    if (!skill) return;
    await window.skillDock.copyText(skill.directoryPath || '');
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
    await window.skillDock.setDescription(skill.id, description);
    // 就地更新，不重扫磁盘
    skill.customDescription = description;
    skill.displayDescription = description || skill.description || '暂无描述';
    $('description-dialog').close();
    renderCatalog();
    openDetail(skill);
    showToast('已保存');
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
      window.skillDock.reloadUi();
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
    $('app-version').textContent = `v${await window.skillDock.version()}`;
  } catch {
    $('app-version').textContent = 'v—';
  }
  await scan();
  render();
}

boot();
