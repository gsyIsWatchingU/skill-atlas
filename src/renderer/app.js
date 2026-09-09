const UI_STATE_KEY = 'skill-atlas:ui-state';

function readUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY)) || {};
  } catch {
    return {};
  }
}

const restoredUiState = readUiState();
let pendingScrollY = Number(restoredUiState.scrollY) || 0;
const state = {
  result: { skills: [], roots: [], errors: [], scannedAt: null },
  view: restoredUiState.view === 'usage' ? 'usage' : 'catalog',
  platform: ['all', 'codex', 'trae', 'shared', 'duplicate', 'invalid', 'unused'].includes(restoredUiState.platform)
    ? restoredUiState.platform
    : 'all',
  scope: typeof restoredUiState.scope === 'string' ? restoredUiState.scope : 'all',
  search: typeof restoredUiState.search === 'string' ? restoredUiState.search : '',
  sort: ['name', 'usage', 'modified', 'source'].includes(restoredUiState.sort) ? restoredUiState.sort : 'name',
  selected: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const platformNames = { codex: 'Codex', trae: 'Trae', shared: '共享' };
const filterNames = {
  all: '全部技能', codex: 'Codex', trae: 'Trae', shared: '共享目录',
  duplicate: '重名技能', invalid: '需完善', unused: '从未使用'
};

const emptyUsage = () => ({ total: 0, last7: 0, last30: 0, lastUsedAt: null, sessions: 0 });

function normalizeUsageResult() {
  state.result.skills.forEach((skill) => { skill.usage = { ...emptyUsage(), ...skill.usage }; });
  state.result.usage ||= {};
  state.result.usage.summary ||= {
    totalUses: 0, last30: 0, usedSkills: 0, unusedSkills: state.result.skills.length, topSkill: null
  };
  state.result.usage.daily ||= [];
  state.result.usage.topSkills ||= [];
  state.result.usage.meta ||= { source: 'Codex 本地会话日志', sessionFiles: 0, errors: [] };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value, includeTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 1980) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: includeTime ? undefined : 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: includeTime ? '2-digit' : undefined,
    minute: includeTime ? '2-digit' : undefined
  }).format(date);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatRecent(value) {
  if (!value) return '从未使用';
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (diff < 0 || Number.isNaN(diff)) return formatDate(value);
  const days = Math.floor(diff / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return formatDate(value);
}

function initials(name) {
  const clean = String(name || 'S').replace(/[^\p{L}\p{N}]/gu, '');
  return (clean[0] || 'S').toUpperCase();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function saveUiState() {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({
      view: state.view,
      platform: state.platform,
      scope: state.scope,
      search: state.search,
      sort: state.sort,
      scrollY: window.scrollY
    }));
  } catch {
    // 存储不可用时不影响主功能。
  }
}

function applyUiState() {
  $('#search').value = state.search;
  if ($(`#sort-order option[value="${state.sort}"]`)) $('#sort-order').value = state.sort;
  $$('.nav-item').forEach((item) => item.classList.remove('active'));
  const active = state.view === 'usage'
    ? $('[data-view="usage"]')
    : $(`[data-platform="${state.platform}"]`);
  (active || $('[data-platform="all"]')).classList.add('active');
}

function reloadUi() {
  saveUiState();
  window.skillAtlas.reloadUi();
}

function getDisplayDescription(skill) {
  return skill.customDescription || skill.localizedDescription || skill.description || '暂无简介';
}

function getOwnershipLabel(skill) {
  return skill.ownershipLabel || (skill.ownership === 'system' ? 'Codex 自带' : '个人 / 下载');
}

function getFilteredSkills() {
  const query = state.search.trim().toLocaleLowerCase('zh-CN');
  let list = state.result.skills.filter((skill) => {
    if (state.platform === 'duplicate' && !skill.duplicate) return false;
    if (state.platform === 'invalid' && skill.valid) return false;
    if (state.platform === 'unused' && skill.usage.total > 0) return false;
    if (!['all', 'duplicate', 'invalid', 'unused'].includes(state.platform) && skill.platform !== state.platform) return false;
    if (state.scope !== 'all' && skill.scope !== state.scope) return false;
    if (!query) return true;
    return [skill.name, skill.customDescription, skill.localizedDescription, skill.description, skill.path, skill.source, getOwnershipLabel(skill)]
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(query);
  });

  list.sort((a, b) => {
    if (state.sort === 'usage') return b.usage.total - a.usage.total || a.name.localeCompare(b.name, 'zh-CN');
    if (state.sort === 'modified') return new Date(b.modifiedAt) - new Date(a.modifiedAt);
    if (state.sort === 'source') return a.source.localeCompare(b.source, 'zh-CN');
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return list;
}

function updateCounts() {
  const skills = state.result.skills;
  const count = (platform) => skills.filter((skill) => skill.platform === platform).length;
  const validCount = skills.filter((skill) => skill.valid).length;
  const duplicateCount = skills.filter((skill) => skill.duplicate).length;
  const invalidCount = skills.length - validCount;
  const health = skills.length ? Math.round((validCount / skills.length) * 100) : 100;
  const activeRoots = state.result.roots.filter((root) => root.exists).length;

  $('#count-all').textContent = skills.length;
  $('#count-codex').textContent = count('codex');
  $('#count-trae').textContent = count('trae');
  $('#count-shared').textContent = count('shared');
  $('#count-duplicate').textContent = duplicateCount;
  $('#count-invalid').textContent = invalidCount;
  $('#count-used').textContent = state.result.usage.summary.usedSkills;
  $('#metric-total').textContent = skills.length;
  $('#metric-codex').textContent = count('codex');
  $('#metric-trae').textContent = count('trae');
  $('#metric-health').textContent = `${health}%`;
  $('#metric-roots').textContent = `${activeRoots} 个有效目录`;
  $('#metric-issues').textContent = `${invalidCount} 个待完善`;
}

function renderUsageDashboard() {
  const { summary, daily, topSkills, meta } = state.result.usage;
  const coverage = state.result.skills.length
    ? Math.round((summary.usedSkills / state.result.skills.length) * 100)
    : 0;
  $('#metric-usage-total').textContent = summary.totalUses;
  $('#metric-usage-30').textContent = summary.last30;
  $('#metric-usage-active').textContent = summary.usedSkills;
  $('#metric-usage-unused').textContent = summary.unusedSkills;
  $('#usage-active-rate').textContent = `覆盖率 ${coverage}%`;
  $('#usage-source-note').textContent = meta.sessionFiles
    ? `${meta.sessionFiles} 个本地会话文件`
    : '未发现 Codex 会话日志';
  $('#trend-total').textContent = `${summary.last30} 次`;

  const trend = $('#usage-trend');
  const maxDaily = Math.max(1, ...daily.map((item) => item.count));
  trend.innerHTML = daily.length ? daily.map((item, index) => {
    const showLabel = index === 0 || index === daily.length - 1 || index === Math.floor(daily.length / 2);
    return `<div class="trend-item" title="${escapeHtml(item.date)} · ${item.count} 次">
      <div class="trend-track"><i data-height="${Math.round((item.count / maxDaily) * 100)}"></i></div>
      <span>${showLabel ? escapeHtml(item.date.slice(5).replace('-', '/')) : ''}</span>
    </div>`;
  }).join('') : '<div class="analytics-empty">暂无可统计的时间数据</div>';
  $$('#usage-trend [data-height]').forEach((bar) => { bar.style.height = `${bar.dataset.height}%`; });

  const ranking = $('#usage-ranking');
  const maxTotal = Math.max(1, ...topSkills.map((skill) => skill.total));
  ranking.innerHTML = topSkills.length ? topSkills.map((skill, index) => `
    <button class="ranking-row" data-skill-id="${escapeHtml(skill.id)}">
      <span class="ranking-index">${String(index + 1).padStart(2, '0')}</span>
      <span class="ranking-main"><strong>${escapeHtml(skill.name)}</strong><i><em data-width="${Math.round((skill.total / maxTotal) * 100)}"></em></i></span>
      <b>${skill.total}</b>
    </button>
  `).join('') : '<div class="analytics-empty compact">使用 Skill 后，这里会显示高频排行</div>';
  $$('#usage-ranking [data-width]').forEach((bar) => { bar.style.width = `${bar.dataset.width}%`; });
  $$('.ranking-row').forEach((button) => button.addEventListener('click', () => {
    const skill = state.result.skills.find((item) => item.id === button.dataset.skillId);
    if (skill) openDetail(skill);
  }));

  const unused = state.result.skills.filter((skill) => skill.usage.total === 0);
  $('#unused-skills').innerHTML = unused.length
    ? `${unused.slice(0, 16).map((skill) => `<button data-skill-id="${escapeHtml(skill.id)}">${escapeHtml(skill.name)}</button>`).join('')}${unused.length > 16 ? `<span>还有 ${unused.length - 16} 个</span>` : ''}`
    : '<div class="analytics-empty compact">所有已扫描 Skill 都有使用记录</div>';
  $$('#unused-skills button').forEach((button) => button.addEventListener('click', () => {
    const skill = state.result.skills.find((item) => item.id === button.dataset.skillId);
    if (skill) openDetail(skill);
  }));
}

function setView(view) {
  state.view = view;
  const usageMode = view === 'usage';
  $('#catalog-view').classList.toggle('hidden', usageMode);
  $('#usage-view').classList.toggle('hidden', !usageMode);
  $('.search-box').classList.toggle('hidden', usageMode);
  $('#export').classList.toggle('hidden', usageMode);
  $('#page-heading').textContent = usageMode ? '使用分析' : '技能总览';
  $('#breadcrumb').textContent = usageMode ? '使用分析' : (filterNames[state.platform] || '技能');
  if (usageMode) renderUsageDashboard();
  saveUiState();
}

function renderRoots() {
  const list = $('#root-list');
  list.innerHTML = state.result.roots.map((root) => `
    <div class="root-item ${root.exists ? 'available' : ''}" title="${escapeHtml(root.rootPath)}">
      <i></i>
      <span>${escapeHtml(root.label)}</span>
      <small>${root.exists ? '已连接' : '未发现'}</small>
      ${root.builtin ? '' : `<button class="root-remove" data-root-id="${escapeHtml(root.id)}" title="移除目录">×</button>`}
    </div>
  `).join('');

  $$('.root-remove').forEach((button) => button.addEventListener('click', async () => {
    await window.skillAtlas.removeRoot(button.dataset.rootId);
    showToast('扫描目录已移除');
    await scan();
  }));
}

function renderScopeOptions() {
  const select = $('#scope-filter');
  const scopes = [...new Set(state.result.skills.map((skill) => skill.scope))].sort();
  select.innerHTML = '<option value="all">全部</option>' + scopes.map((scope) =>
    `<option value="${escapeHtml(scope)}">${escapeHtml(scope)}</option>`
  ).join('');
  select.value = scopes.includes(state.scope) ? state.scope : 'all';
}

function renderGrid() {
  const skills = getFilteredSkills();
  const grid = $('#skill-grid');
  $('#loading').classList.add('hidden');
  $('#list-title').textContent = filterNames[state.platform] || '技能';
  $('#breadcrumb').textContent = filterNames[state.platform] || '技能';
  $('#list-subtitle').textContent = state.search
    ? `找到 ${skills.length} 个匹配项`
    : `共 ${skills.length} 个技能，可点击查看完整指令`;

  if (!skills.length) {
    grid.classList.add('hidden');
    $('#empty').classList.remove('hidden');
    return;
  }
  $('#empty').classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = skills.map((skill) => `
    <button class="skill-card" data-id="${escapeHtml(skill.id)}" data-platform="${escapeHtml(skill.platform)}">
      <div class="card-top">
        <div class="skill-avatar">${escapeHtml(initials(skill.name))}</div>
        <div class="card-badges">
          <span class="platform-pill ${escapeHtml(skill.platform)}">${escapeHtml(platformNames[skill.platform])}</span>
          <span class="scope-pill">${escapeHtml(skill.scope)}</span>
          <span class="origin-pill ${escapeHtml(skill.ownership || 'personal')}">${escapeHtml(getOwnershipLabel(skill))}</span>
          ${skill.customDescription
            ? '<span class="custom-pill custom">自定义简介</span>'
            : skill.localizedDescription ? '<span class="custom-pill">中文简介</span>' : ''}
          ${skill.duplicate ? '<span class="warning-pill">重名</span>' : ''}
          ${skill.valid ? '' : '<span class="warning-pill">缺元数据</span>'}
        </div>
      </div>
      <h3>${escapeHtml(skill.name)}</h3>
      <p>${escapeHtml(getDisplayDescription(skill))}</p>
      <div class="card-usage">
        <span><b>${skill.usage.total}</b> 次使用</span>
        <span>${escapeHtml(formatRecent(skill.usage.lastUsedAt))}</span>
      </div>
      <div class="card-footer">
        <span title="${escapeHtml(skill.source)}">${escapeHtml(skill.source)}</span>
        <span>${formatDate(skill.modifiedAt)}</span>
      </div>
    </button>
  `).join('');

  $$('.skill-card').forEach((card) => card.addEventListener('click', () => {
    const skill = state.result.skills.find((item) => item.id === card.dataset.id);
    if (skill) openDetail(skill);
  }));
}

function openDetail(skill) {
  state.selected = skill;
  const platform = platformNames[skill.platform];
  const platformPill = $('#detail-platform');
  platformPill.textContent = platform;
  platformPill.className = `platform-pill ${skill.platform}`;
  $('#detail-scope').textContent = skill.scope;
  const ownershipPill = $('#detail-ownership');
  ownershipPill.textContent = getOwnershipLabel(skill);
  ownershipPill.className = `origin-pill ${skill.ownership || 'personal'}`;
  $('#detail-avatar').textContent = initials(skill.name);
  $('#detail-avatar').style.setProperty('--platform-color', skill.platform === 'trae' ? '#45d4c5' : skill.platform === 'shared' ? '#6795ff' : '#ff8b3d');
  $('#detail-name').textContent = skill.name;
  $('#detail-description').textContent = getDisplayDescription(skill);
  $('#detail-description-label').textContent = skill.customDescription
    ? '自定义中文简介'
    : skill.localizedDescription ? '中文简介' : '原始简介';
  $('#detail-source').textContent = skill.source;
  $('#detail-modified').textContent = formatDate(skill.modifiedAt, true);
  $('#detail-resources').textContent = `${skill.resourceDirectories} 个目录 · ${skill.resourceFiles} 个文件`;
  $('#detail-size').textContent = formatSize(skill.size);
  $('#detail-usage').textContent = `${skill.usage.total} 次 · ${skill.usage.sessions} 个会话`;
  $('#detail-last-used').textContent = skill.usage.lastUsedAt ? formatDate(skill.usage.lastUsedAt, true) : '从未使用';
  $('#detail-path').textContent = skill.filePath;
  $('#detail-body').textContent = skill.body || '暂无正文';
  const alert = $('#detail-alert');
  const alerts = [];
  if (!skill.valid) alerts.push('Frontmatter 缺少 name 或 description，可能影响自动触发。');
  if (skill.duplicate) alerts.push('发现同名 Skill，请确认各平台的加载优先级。');
  alert.textContent = alerts.join(' ');
  alert.classList.toggle('hidden', !alerts.length);

  $('#detail-overlay').classList.remove('hidden');
  $('#detail-panel').classList.add('open');
  $('#detail-panel').setAttribute('aria-hidden', 'false');
}

function updateDescriptionCounter() {
  $('#description-count').textContent = `${$('#description-input').value.length} / 300`;
}

function openDescriptionDialog() {
  if (!state.selected) return;
  $('#description-input').value = state.selected.customDescription || '';
  $('#description-original').textContent = `原始简介：${state.selected.description || '暂无描述'}`;
  $('#clear-description').classList.toggle('hidden', !state.selected.customDescription);
  updateDescriptionCounter();
  $('#description-dialog').showModal();
  $('#description-input').focus();
}

async function saveSelectedDescription(description) {
  if (!state.selected) return;
  const skill = state.result.skills.find((item) => item.id === state.selected.id);
  if (!skill) return;
  const savedDescription = await window.skillAtlas.saveDescription(skill.id, description);
  skill.customDescription = savedDescription;
  state.selected = skill;
  renderGrid();
  openDetail(skill);
}

function closeDetail() {
  $('#detail-panel').classList.remove('open');
  $('#detail-panel').setAttribute('aria-hidden', 'true');
  setTimeout(() => $('#detail-overlay').classList.add('hidden'), 220);
  state.selected = null;
}

async function scan() {
  $('#loading').classList.remove('hidden');
  $('#skill-grid').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#scan-status').textContent = '正在扫描';
  $('#refresh').disabled = true;
  try {
    state.result = await window.skillAtlas.scan();
    normalizeUsageResult();
    updateCounts();
    renderRoots();
    renderScopeOptions();
    renderGrid();
    renderUsageDashboard();
    setView(state.view);
    if (pendingScrollY !== null) {
      requestAnimationFrame(() => window.scrollTo({ top: pendingScrollY, behavior: 'instant' }));
      pendingScrollY = null;
    }
    const localizedCount = state.result.skills.filter((skill) => skill.localizedDescription).length;
    $('#scan-status').textContent = state.result.errors.length ? `完成 · ${state.result.errors.length} 个异常` : '扫描完成';
    const scanTime = formatDate(state.result.scannedAt, true);
    $('#scan-time').textContent = `中文简介 ${localizedCount}/${state.result.skills.length} · ${scanTime}`;
  } catch (error) {
    $('#loading').classList.add('hidden');
    $('#empty').classList.remove('hidden');
    $('#scan-status').textContent = '扫描失败';
    showToast(`扫描失败：${error.message}`);
  } finally {
    $('#refresh').disabled = false;
  }
}

function openRootDialog() { $('#root-dialog').showModal(); }

$$('.nav-item').forEach((button) => button.addEventListener('click', () => {
  $$('.nav-item').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  if (button.dataset.view === 'usage') {
    setView('usage');
    return;
  }
  state.platform = button.dataset.platform;
  setView('catalog');
  renderGrid();
  saveUiState();
}));

$('#search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderGrid();
  saveUiState();
});
$('#scope-filter').addEventListener('change', (event) => {
  state.scope = event.target.value;
  renderGrid();
  saveUiState();
});
$('#sort-order').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderGrid();
  saveUiState();
});
$('#refresh').addEventListener('click', scan);
$('#reload-ui').addEventListener('click', reloadUi);
$('#show-unused').addEventListener('click', () => {
  state.platform = 'unused';
  state.sort = 'name';
  $('#sort-order').value = 'name';
  $$('.nav-item').forEach((item) => item.classList.remove('active'));
  setView('catalog');
  renderGrid();
  saveUiState();
});
$('#manage-roots').addEventListener('click', openRootDialog);
$('#empty-add').addEventListener('click', openRootDialog);
$('#choose-root').addEventListener('click', async (event) => {
  event.preventDefault();
  const platform = $('#new-root-platform').value;
  const root = await window.skillAtlas.addRoot(platform);
  if (root) {
    $('#root-dialog').close();
    showToast('扫描目录已添加');
    await scan();
  }
});
$('#close-detail').addEventListener('click', closeDetail);
$('#detail-overlay').addEventListener('click', closeDetail);
$('#open-skill').addEventListener('click', () => state.selected && window.skillAtlas.openPath(state.selected.filePath));
$('#reveal-skill').addEventListener('click', () => state.selected && window.skillAtlas.revealPath(state.selected.filePath));
$('#copy-path').addEventListener('click', async () => {
  if (!state.selected) return;
  await window.skillAtlas.copyText(state.selected.filePath);
  showToast('路径已复制');
});
$('#edit-description').addEventListener('click', openDescriptionDialog);
$('#description-input').addEventListener('input', updateDescriptionCounter);
$('#description-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const description = $('#description-input').value.trim();
  if (!description) {
    showToast('请输入中文简介，或使用“恢复原简介”');
    return;
  }
  try {
    await saveSelectedDescription(description);
    $('#description-dialog').close();
    showToast('中文简介已保存');
  } catch (error) {
    showToast(`保存失败：${error.message}`);
  }
});
$('#clear-description').addEventListener('click', async () => {
  try {
    await saveSelectedDescription('');
    $('#description-dialog').close();
    showToast('已恢复原始简介');
  } catch (error) {
    showToast(`恢复失败：${error.message}`);
  }
});
$('#export').addEventListener('click', async () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    total: state.result.skills.length,
    skills: state.result.skills.map(({ body, ...skill }) => skill)
  };
  const file = await window.skillAtlas.exportSkills(payload);
  if (file) showToast('清单导出成功');
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('#search').focus();
  }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    reloadUi();
  }
  if (event.key === 'Escape' && state.selected && !$('#description-dialog').open) closeDetail();
});

window.addEventListener('beforeunload', saveUiState);

window.skillAtlas.getVersion()
  .then((version) => { $('#app-version').textContent = `v${version}`; })
  .catch(() => { $('#app-version').textContent = 'v—'; });

applyUiState();
scan();
