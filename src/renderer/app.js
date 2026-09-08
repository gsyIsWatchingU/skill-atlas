const state = {
  result: { skills: [], roots: [], errors: [], scannedAt: null },
  platform: 'all',
  scope: 'all',
  search: '',
  sort: 'name',
  selected: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const platformNames = { codex: 'Codex', trae: 'Trae', shared: '共享' };
const filterNames = {
  all: '全部技能', codex: 'Codex', trae: 'Trae', shared: '共享目录',
  duplicate: '重名技能', invalid: '需完善'
};

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

function getDisplayDescription(skill) {
  return skill.customDescription || skill.description || '暂无简介';
}

function getFilteredSkills() {
  const query = state.search.trim().toLocaleLowerCase('zh-CN');
  let list = state.result.skills.filter((skill) => {
    if (state.platform === 'duplicate' && !skill.duplicate) return false;
    if (state.platform === 'invalid' && skill.valid) return false;
    if (!['all', 'duplicate', 'invalid'].includes(state.platform) && skill.platform !== state.platform) return false;
    if (state.scope !== 'all' && skill.scope !== state.scope) return false;
    if (!query) return true;
    return [skill.name, skill.customDescription, skill.description, skill.path, skill.source]
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(query);
  });

  list.sort((a, b) => {
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
  $('#metric-total').textContent = skills.length;
  $('#metric-codex').textContent = count('codex');
  $('#metric-trae').textContent = count('trae');
  $('#metric-health').textContent = `${health}%`;
  $('#metric-roots').textContent = `${activeRoots} 个有效目录`;
  $('#metric-issues').textContent = `${invalidCount} 个待完善`;
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
          ${skill.customDescription ? '<span class="custom-pill">中文简介</span>' : ''}
          ${skill.duplicate ? '<span class="warning-pill">重名</span>' : ''}
          ${skill.valid ? '' : '<span class="warning-pill">缺元数据</span>'}
        </div>
      </div>
      <h3>${escapeHtml(skill.name)}</h3>
      <p>${escapeHtml(getDisplayDescription(skill))}</p>
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
  $('#detail-avatar').textContent = initials(skill.name);
  $('#detail-avatar').style.setProperty('--platform-color', skill.platform === 'trae' ? '#45d4c5' : skill.platform === 'shared' ? '#6795ff' : '#ff8b3d');
  $('#detail-name').textContent = skill.name;
  $('#detail-description').textContent = getDisplayDescription(skill);
  $('#detail-description-label').textContent = skill.customDescription ? '自定义中文简介' : '原始简介';
  $('#detail-source').textContent = skill.source;
  $('#detail-modified').textContent = formatDate(skill.modifiedAt, true);
  $('#detail-resources').textContent = `${skill.resourceDirectories} 个目录 · ${skill.resourceFiles} 个文件`;
  $('#detail-size').textContent = formatSize(skill.size);
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
    updateCounts();
    renderRoots();
    renderScopeOptions();
    renderGrid();
    $('#scan-status').textContent = state.result.errors.length ? `完成 · ${state.result.errors.length} 个异常` : '扫描完成';
    $('#scan-time').textContent = formatDate(state.result.scannedAt, true);
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
  state.platform = button.dataset.platform;
  renderGrid();
}));

$('#search').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderGrid();
});
$('#scope-filter').addEventListener('change', (event) => {
  state.scope = event.target.value;
  renderGrid();
});
$('#sort-order').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderGrid();
});
$('#refresh').addEventListener('click', scan);
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
  if (event.key === 'Escape' && state.selected && !$('#description-dialog').open) closeDetail();
});

scan();
