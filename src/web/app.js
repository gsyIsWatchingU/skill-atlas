const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 1000;
const MAX_SCAN_DEPTH = 12;
const SKIP_DIRECTORIES = new Set(['.git', '.svn', 'node_modules', '__pycache__', 'dist', 'build', 'coverage']);
const SCAN_DIRECTORY_DB = 'skill-packer-local';
const SCAN_DIRECTORY_STORE = 'scan-directories';
const HELPER_BASE_URL = 'http://127.0.0.1:18787';
const HELPER_TOKEN_STORAGE = 'skill-packer-helper-token';
const DEFAULT_SCAN_DIRECTORIES = [
  { id: 'codex-user', label: 'Codex 个人 Skill', path: '%USERPROFILE%\\.codex\\skills', custom: false },
  { id: 'shared-agents', label: '跨 Agent 共享 Skill', path: '%USERPROFILE%\\.agents\\skills', custom: false },
  { id: 'codex-plugins', label: 'Codex 插件 Skill', path: '%USERPROFILE%\\.codex\\plugins\\cache', custom: false }
];

const state = {
  localSkills: [],
  scanDirectories: DEFAULT_SCAN_DIRECTORIES.map(function (directory) {
    return Object.assign({ handle: null, status: 'waiting', skillCount: 0 }, directory);
  }),
  cloudSkills: [],
  communitySkills: [],
  user: null,
  busy: false,
  searchQuery: '',
  zhSummaries: {},
  authMode: 'login',
  helper: {
    token: '',
    connected: false,
    version: '',
    roots: {}
  }
};

const elements = {
  authCode: document.querySelector('#auth-code'),
  authDialog: document.querySelector('#auth-dialog'),
  authEmail: document.querySelector('#auth-email'),
  authForm: document.querySelector('#auth-form'),
  authLoginTab: document.querySelector('#auth-login-tab'),
  authMessage: document.querySelector('#auth-message'),
  authName: document.querySelector('#auth-name'),
  authPassword: document.querySelector('#auth-password'),
  authRegisterTab: document.querySelector('#auth-register-tab'),
  authResetRow: document.querySelector('#auth-reset-row'),
  authTitle: document.querySelector('#auth-title'),
  addScanDirectory: document.querySelector('#add-scan-directory'),
  cancelAuth: document.querySelector('#cancel-auth'),
  cancelLegacy: document.querySelector('#cancel-legacy'),
  claimLegacy: document.querySelector('#claim-legacy'),
  clearSearch: document.querySelector('#clear-search'),
  cloudCount: document.querySelector('#cloud-count'),
  cloudEmpty: document.querySelector('#cloud-empty'),
  cloudEmptyCopy: document.querySelector('#cloud-empty-copy'),
  cloudEmptyTitle: document.querySelector('#cloud-empty-title'),
  cloudLabel: document.querySelector('#cloud-label'),
  cloudSkills: document.querySelector('#cloud-skills'),
  communityCount: document.querySelector('#community-count'),
  communityEmpty: document.querySelector('#community-empty'),
  communityLabel: document.querySelector('#community-label'),
  communitySkills: document.querySelector('#community-skills'),
  confirmDialog: document.querySelector('#confirm-dialog'),
  confirmMessage: document.querySelector('#confirm-message'),
  confirmTitle: document.querySelector('#confirm-title'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionText: document.querySelector('#connection-text'),
  differentCount: document.querySelector('#different-count'),
  detectHelper: document.querySelector('#detect-helper'),
  desktopStatus: document.querySelector('#desktop-status'),
  desktopStatusLabel: document.querySelector('#desktop-status-label'),
  desktopStatusVersion: document.querySelector('#desktop-status-version'),
  downloadDesktop: document.querySelector('#download-desktop'),
  directoryInput: document.querySelector('#directory-input'),
  legacyDialog: document.querySelector('#legacy-dialog'),
  legacyForm: document.querySelector('#legacy-form'),
  legacyToken: document.querySelector('#legacy-token'),
  localCount: document.querySelector('#local-count'),
  localEmpty: document.querySelector('#local-empty'),
  localSkills: document.querySelector('#local-skills'),
  loginLink: document.querySelector('#login-link'),
  logout: document.querySelector('#logout'),
  refreshCloud: document.querySelector('#refresh-cloud'),
  scanDirectory: document.querySelector('#scan-directory'),
  scanDirectories: document.querySelector('#scan-directories'),
  scanDirectorySummary: document.querySelector('#scan-directory-summary'),
  scanLabel: document.querySelector('#scan-label'),
  searchCount: document.querySelector('#search-count'),
  sendAuthCode: document.querySelector('#send-auth-code'),
  skillSearch: document.querySelector('#skill-search'),
  submitAuth: document.querySelector('#submit-auth'),
  toast: document.querySelector('#toast'),
  userMenu: document.querySelector('#user-menu'),
  userName: document.querySelector('#user-name')
};

function normalizeName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').trim();
}

function normalizeSearchText(value) {
  return normalizeName(value);
}

function skillMatchesSearch(skill, query) {
  if (!query) return true;
  return [skill.name, skill.description, skill.folderName, skill.source]
    .filter(Boolean)
    .map(normalizeName)
    .join(' ')
    .includes(query);
}

// 中文简介：仅作为 Skill 元数据生成与缓存，绝不写回源文件。
// 离线确定性生成：优先复用已有的中文描述，否则从英文描述中抽取动词与名词组合成简介。
const ZH_VERB_TERMS = [
  ['create', '创建'], ['generate', '生成'], ['edit', '编辑'], ['read', '读取'], ['write', '写入'],
  ['manage', '管理'], ['analyze', '分析'], ['search', '检索'], ['convert', '转换'], ['translate', '翻译'],
  ['summarize', '总结'], ['extract', '提取'], ['review', '审阅'], ['draft', '起草'], ['plan', '规划'],
  ['schedule', '安排'], ['send', '发送'], ['upload', '上传'], ['download', '下载'], ['install', '安装'],
  ['scan', '扫描'], ['sync', '同步'], ['compare', '比较'], ['organize', '整理'], ['optimize', '优化'],
  ['classify', '分类'], ['detect', '检测'], ['process', '处理'], ['design', '设计'], ['build', '构建'],
  ['track', '跟踪'], ['monitor', '监控'], ['evaluate', '评估'], ['predict', '预测'], ['recommend', '推荐'],
  ['answer', '回答'], ['improve', '改进'], ['fix', '修复'], ['debug', '调试'], ['test', '测试'],
  ['format', '排版'], ['publish', '发布'], ['share', '分享'], ['import', '导入'], ['export', '导出'],
  ['merge', '合并'], ['filter', '筛选'], ['sort', '排序'], ['count', '统计'], ['calculate', '计算'],
  ['verify', '核验'], ['validate', '校验'], ['audit', '审计'], ['approve', '审批'], ['remind', '提醒'],
  ['notify', '通知'], ['collect', '收集'], ['explain', '解释'], ['query', '查询'], ['update', '更新'],
  ['delete', '删除'], ['remove', '移除'], ['package', '打包'], ['run', '运行'], ['check', '检查'],
  ['inspect', '检查'], ['list', '列出'], ['find', '查找'], ['select', '选择'], ['open', '打开'],
  ['save', '保存'], ['load', '加载'], ['apply', '应用'], ['use', '使用']
];

const ZH_NOUN_TERMS = [
  ['spreadsheet', '表格'], ['excel', 'Excel 表格'], ['sheet', '表格'], ['document', '文档'],
  ['docx', 'Word 文档'], ['presentation', '演示文稿'], ['slide', '幻灯片'], ['ppt', 'PPT'],
  ['image', '图片'], ['picture', '图片'], ['photo', '照片'], ['screenshot', '截图'],
  ['video', '视频'], ['audio', '音频'], ['voice', '语音'], ['music', '音乐'],
  ['file', '文件'], ['folder', '目录'], ['directory', '目录'], ['data', '数据'],
  ['report', '报告'], ['contract', '合同'], ['agreement', '协议'], ['meeting', '会议'],
  ['minutes', '会议纪要'], ['email', '邮件'], ['mail', '邮件'], ['message', '消息'],
  ['task', '任务'], ['todo', '待办'], ['calendar', '日历'], ['code', '代码'],
  ['script', '脚本'], ['api', '接口'], ['database', '数据库'], ['website', '网站'],
  ['webpage', '网页'], ['page', '页面'], ['application', '应用'], ['skill', '技能'],
  ['template', '模板'], ['project', '项目'], ['customer', '客户'], ['order', '订单'],
  ['product', '产品'], ['inventory', '库存'], ['marketing', '营销'], ['content', '内容'],
  ['article', '文章'], ['news', '新闻'], ['finance', '财务'], ['stock', '股票'],
  ['chart', '图表'], ['graph', '图表'], ['diagram', '示意图'], ['workflow', '工作流'],
  ['agent', '智能体'], ['summary', '摘要'], ['title', '标题'], ['keyword', '关键词'],
  ['language', '语言'], ['manual', '手册'], ['guide', '指南'], ['tutorial', '教程'],
  ['checklist', '清单'], ['invoice', '发票'], ['receipt', '收据'], ['payment', '支付'],
  ['refund', '退款'], ['shipping', '物流'], ['logistics', '物流'], ['warehouse', '仓储'],
  ['quality', '质量'], ['issue', '问题'], ['error', '错误'], ['log', '日志'],
  ['config', '配置'], ['deploy', '部署'], ['commit', '提交'], ['branch', '分支'],
  ['github', 'GitHub'], ['readme', '说明文档'], ['cron', '定时任务'], ['questionnaire', '问卷'],
  ['survey', '调研'], ['interview', '访谈'], ['proposal', '方案'], ['budget', '预算'],
  ['risk', '风险'], ['compliance', '合规'], ['legal', '法律'], ['patent', '专利'],
  ['research', '研究'], ['paper', '论文'], ['literature', '文献'], ['medical', '医疗'],
  ['health', '健康'], ['user', '用户']
];

function matchZhTerms(text, terms) {
  const lower = String(text || '').toLocaleLowerCase('en-US');
  const found = [];
  const seen = new Set();
  for (const entry of terms) {
    const en = entry[0];
    const zh = entry[1];
    if (seen.has(zh)) continue;
    const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = lower.match(new RegExp('\\b' + escaped + '\\b', 'i'));
    if (match) {
      seen.add(zh);
      found.push({ zh: zh, pos: match.index });
    }
  }
  return found.sort(function (a, b) { return a.pos - b.pos; }).map(function (item) { return item.zh; });
}

function generateZhSummary(skill) {
  const displayName = String(skill.name || skill.folderName || '').trim() || '该技能';
  const description = String(skill.description || '').trim();
  if (/[\u4e00-\u9fa5]/.test(description)) {
    return description.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  const verbs = matchZhTerms(description, ZH_VERB_TERMS).slice(0, 6);
  const nouns = matchZhTerms(description, ZH_NOUN_TERMS).slice(0, 8);
  const verbText = verbs.join('、');
  const nounText = nouns.join('、');
  if (verbText && nounText) return '「' + displayName + '」技能：提供' + verbText + '等能力，适用于' + nounText + '等场景。';
  if (verbText) return '「' + displayName + '」技能：提供' + verbText + '等能力。';
  if (nounText) return '「' + displayName + '」技能：围绕' + nounText + '等提供处理能力。';
  return description
    ? '「' + displayName + '」技能：' + description.replace(/\s+/g, ' ').trim().slice(0, 80)
    : '「' + displayName + '」技能：暂无简介。';
}

const ZH_SUMMARY_STORAGE = 'skill-packer-zh-summaries';

function loadZhSummaries() {
  try {
    const raw = window.localStorage.getItem(ZH_SUMMARY_STORAGE);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistZhSummaries() {
  try {
    window.localStorage.setItem(ZH_SUMMARY_STORAGE, JSON.stringify(state.zhSummaries));
  } catch {}
}

function getSkillZhSummary(skill) {
  if (skill.zhSummary) return skill.zhSummary;
  const key = normalizeName(skill.name);
  return state.zhSummaries[key] || generateZhSummary(skill);
}

// 增量补齐：只给没有中文简介的 Skill 生成，已生成的保持不变。
function ensureZhSummaries(skills) {
  let changed = false;
  for (const skill of skills || []) {
    if (!skill) continue;
    const key = normalizeName(skill.name);
    if (skill.zhSummary || state.zhSummaries[key]) continue;
    state.zhSummaries[key] = generateZhSummary(skill);
    changed = true;
  }
  if (changed) persistZhSummaries();
}

function truncateZh(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function findDuplicateGroups(skills) {
  const api = window.SkillDedup;
  if (api) return api.findDuplicateGroups(skills || state.localSkills);
  const list = skills || state.localSkills;
  const groups = new Map();
  for (const skill of list) {
    const key = normalizeName(skill.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(skill);
  }
  const result = [];
  for (const entry of groups) {
    const key = entry[0];
    const list2 = entry[1];
    if (list2.length > 1) result.push({ key: key, name: list2[0].name, skills: list2 });
  }
  return result;
}

// 扫描后检测同名 Skill：提醒用户每组只保留文件最全的一个，仅移出本机清单，不删除磁盘源文件。
async function promptDuplicateDedup() {
  const groups = findDuplicateGroups();
  if (!groups.length) return;
  const summary = groups.slice(0, 5).map(function (group) {
    return group.name + '（' + group.skills.length + ' 个版本）';
  }).join('、');
  const more = groups.length > 5 ? ' 等 ' + groups.length + ' 组' : '';
  const confirmed = await confirmAction(
    '发现重复 Skill',
    '同名 Skill 共 ' + groups.length + ' 组：' + summary + more +
    '。每组只保留文件最全的一个，其余移出本机清单（不会删除磁盘上的源文件）。是否继续？'
  );
  if (!confirmed) return;
  const api = window.SkillDedup;
  const result = api
    ? api.dedupeDuplicateSkills(state.localSkills)
    : dedupeDuplicateSkillsFallback(state.localSkills);
  state.localSkills = result.keptSkills;
  render();
  showToast('已去重：保留 ' + result.keptSkills.length + ' 个，移出 ' + result.removedCount + ' 个重复项');
}

// 兼容降级：SkillDedup 模块未加载时使用内置逻辑。
function dedupeDuplicateSkillsFallback(skills) {
  const groups = findDuplicateGroups(skills);
  const keep = new Set();
  let removedCount = 0;
  for (const group of groups) {
    group.skills.sort(function (a, b) {
      return (b.fileCount - a.fileCount) || (b.sizeBytes - a.sizeBytes);
    });
    keep.add(group.skills[0]);
    removedCount += group.skills.length - 1;
  }
  return {
    keptSkills: (skills || []).filter(function (skill) {
      return keep.has(skill) || !groups.some(function (group) {
        return group.skills.includes(skill);
      });
    }),
    removedCount: removedCount
  };
}

function formatBytes(value) {
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1024 / 1024).toFixed(1) + ' MB';
}

function showToast(message, isError) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', Boolean(isError));
  elements.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(function () {
    elements.toast.classList.remove('show');
  }, 2600);
}

function setConnection(mode, text) {
  elements.connectionDot.className = 'connection-dot' + (mode ? ' ' + mode : '');
  elements.connectionText.textContent = text;
}

function setBusy(value, label) {
  state.busy = value;
  elements.scanDirectory.disabled = value;
  elements.addScanDirectory.disabled = value;
  elements.refreshCloud.disabled = value;
  if (label) elements.scanLabel.textContent = label;
}

function openScanDirectoryDatabase() {
  if (!window.indexedDB) return Promise.resolve(null);
  return new Promise(function (resolve, reject) {
    const request = window.indexedDB.open(SCAN_DIRECTORY_DB, 1);
    request.onupgradeneeded = function () {
      if (!request.result.objectStoreNames.contains(SCAN_DIRECTORY_STORE)) {
        request.result.createObjectStore(SCAN_DIRECTORY_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

async function readStoredScanDirectories() {
  const database = await openScanDirectoryDatabase();
  if (!database) return [];
  return new Promise(function (resolve, reject) {
    const transaction = database.transaction(SCAN_DIRECTORY_STORE, 'readonly');
    const request = transaction.objectStore(SCAN_DIRECTORY_STORE).getAll();
    request.onsuccess = function () { resolve(request.result || []); };
    request.onerror = function () { reject(request.error); };
    transaction.oncomplete = function () { database.close(); };
  });
}

async function storeScanDirectory(directory) {
  const database = await openScanDirectoryDatabase();
  if (!database) return;
  return new Promise(function (resolve, reject) {
    const transaction = database.transaction(SCAN_DIRECTORY_STORE, 'readwrite');
    transaction.objectStore(SCAN_DIRECTORY_STORE).put({
      id: directory.id,
      label: directory.label,
      path: directory.path,
      custom: directory.custom,
      handle: directory.handle
    });
    transaction.oncomplete = function () { database.close(); resolve(); };
    transaction.onerror = function () { database.close(); reject(transaction.error); };
  });
}

async function removeStoredScanDirectory(id) {
  const database = await openScanDirectoryDatabase();
  if (!database) return;
  return new Promise(function (resolve, reject) {
    const transaction = database.transaction(SCAN_DIRECTORY_STORE, 'readwrite');
    transaction.objectStore(SCAN_DIRECTORY_STORE).delete(id);
    transaction.oncomplete = function () { database.close(); resolve(); };
    transaction.onerror = function () { database.close(); reject(transaction.error); };
  });
}

async function apiRequest(pathname, options) {
  const requestOptions = Object.assign({}, options || {});
  requestOptions.headers = Object.assign({}, requestOptions.headers || {});
  if (requestOptions.body) requestOptions.headers['Content-Type'] = 'application/json';
  const response = await fetch(pathname, requestOptions);
  const result = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    const error = new Error(result.error || '请求失败（' + response.status + '）');
    error.status = response.status;
    throw error;
  }
  return result;
}

function helperTokenFromLocation() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('helper') || '';
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return '';
  try {
    window.localStorage.setItem(HELPER_TOKEN_STORAGE, token);
  } catch {}
  window.history.replaceState({}, '', window.location.pathname + window.location.search);
  return token;
}

function storedHelperToken() {
  try {
    const token = window.localStorage.getItem(HELPER_TOKEN_STORAGE) || '';
    return /^[A-Za-z0-9_-]{32,}$/.test(token) ? token : '';
  } catch {
    return '';
  }
}

/**
 * 本地助手（B 通道 CLI）的状态渲染。
 *
 * 首页不再暴露"复制命令跑脚本"的引导，但助手本身仍然可用：
 * 自动化与 CI 场景直接跑 `node bin/skill-packer.js`（或 npm run helper）即可，
 * helper token 通过 URL hash 带过来，这里只负责显示连接态。
 */
function renderHelper() {
  // 首启的桌面版不渲染这些节点，做空值保护
  if (!elements.helperStatus) return;
  const status = state.helper.connected ? 'connected' : state.helper.token ? 'pending' : 'disconnected';
  elements.helperStatus.className = 'helper-connection-status ' + status;
  if (elements.helperStatusLabel) {
    elements.helperStatusLabel.textContent = state.helper.connected
      ? '已连接'
      : state.helper.token ? '等待连接' : '未连接';
  }
  if (elements.helperStatusVersion) {
    elements.helperStatusVersion.textContent = state.helper.connected && state.helper.version
      ? 'v' + state.helper.version
      : '';
  }
  if (elements.helperCopy) {
    elements.helperCopy.textContent = state.helper.connected
      ? '已启用只读直达扫描。'
      : '本地助手（CLI）适用于自动化与 CI；桌面版无需命令行。';
  }
  if (elements.detectHelper) {
    elements.detectHelper.disabled = state.busy;
    elements.detectHelper.textContent = '重新检测';
  }
}

async function helperRequest(pathname, timeoutMs) {
  if (!state.helper.token) throw new Error('本地助手尚未配对');
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || 3000);
  try {
    const response = await fetch(HELPER_BASE_URL + pathname, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + state.helper.token },
      cache: 'no-store',
      signal: controller.signal,
      targetAddressSpace: 'loopback'
    });
    const result = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(result.error || '本地助手请求失败（' + response.status + '）');
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('本地助手响应超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function detectHelper(silent) {
  if (!state.helper.token) {
    state.helper.connected = false;
    renderHelper();
    renderScanDirectories();
    if (!silent) showToast('本地助手未配对；桌面版不需要这一步', true);
    return false;
  }
  try {
    const health = await helperRequest('/v1/health', 1800);
    state.helper.connected = Boolean(health.ok);
    state.helper.version = health.version || '';
  } catch {
    state.helper.connected = false;
    state.helper.version = '';
  }
  renderHelper();
  renderScanDirectories();
  if (!silent) showToast(
    state.helper.connected ? '本地助手已连接' : '本地助手未连接；桌面版可持续管理，网页端需手动授权文件夹',
    !state.helper.connected
  );
  return state.helper.connected;
}

function applyHelperScan(result) {
  state.helper.roots = {};
  for (const root of result.roots || []) state.helper.roots[root.id] = root;
  for (const directory of DEFAULT_SCAN_DIRECTORIES) {
    const skills = (result.skills || []).filter(function (skill) {
      return skill.scanDirectoryId === directory.id;
    });
    replaceLocalSkillsForDirectory(directory.id, skills);
  }
  render();
  renderScanDirectories();
}

async function scanWithHelper(automatic) {
  if (state.busy) return false;
  if (!state.helper.connected && !await detectHelper(true)) {
    if (!automatic) showToast('本地助手未连接；也可用浏览器授权模式直接选择文件夹', true);
    return false;
  }
  setBusy(true, '本地助手正在扫描默认目录');
  renderHelper();
  try {
    const result = await helperRequest('/v1/scan', 120000);
    applyHelperScan(result);
    const ready = (result.roots || []).filter(function (root) { return root.status === 'ready'; }).length;
    elements.scanLabel.textContent = '助手已扫描 ' + ready + ' 个目录 · 找到 ' + (result.skills || []).length + ' 个 Skill';
    if (!automatic) showToast('本地助手扫描完成');
    ensureZhSummaries(result.skills || []);
    render();
    renderScanDirectories();
    await promptDuplicateDedup();
    return true;
  } catch (error) {
    state.helper.connected = false;
    if (!automatic) showToast(error.message, true);
    return false;
  } finally {
    setBusy(false);
    renderHelper();
    renderScanDirectories();
  }
}

async function scanDefaultSources() {
  if (state.helper.token && await scanWithHelper(false)) return;
  await scanAllConfiguredDirectories(false);
}

async function initializeHelper() {
  state.helper.token = helperTokenFromLocation() || storedHelperToken();
  renderHelper();
  return detectHelper(true);
}

function setAuthMessage(message, isError) {
  elements.authMessage.textContent = message || '';
  elements.authMessage.classList.toggle('hidden', !message);
  elements.authMessage.classList.toggle('error', Boolean(isError));
}

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  elements.authTitle.textContent = registering ? '注册统一账号' : '登录 Skill Packer';
  elements.authLoginTab.classList.toggle('active', !registering);
  elements.authRegisterTab.classList.toggle('active', registering);
  document.querySelectorAll('.auth-register-only').forEach(function (node) {
    node.classList.toggle('hidden', !registering);
  });
  elements.authCode.required = registering;
  elements.authPassword.minLength = registering ? 6 : 1;
  elements.authPassword.autocomplete = registering ? 'new-password' : 'current-password';
  elements.authResetRow.classList.toggle('hidden', registering);
  elements.submitAuth.textContent = registering ? '注册并登录' : '登录';
  setAuthMessage('', false);
}

function openAuthDialog() {
  setAuthMode('login');
  elements.authPassword.value = '';
  elements.authCode.value = '';
  elements.authDialog.showModal();
  elements.authEmail.focus();
}

function parseFrontmatter(content, fallbackName) {
  const result = { name: fallbackName, description: '' };
  const normalized = String(content || '').replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return result;
  const lines = match[1].split(/\r?\n/);
  let currentKey = '';
  let block = [];

  function commitBlock() {
    if (currentKey && block.length) result[currentKey] = block.join(' ').trim();
    block = [];
  }

  for (const line of lines) {
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (pair) {
      commitBlock();
      currentKey = pair[1];
      const value = pair[2].replace(/^['"]|['"]$/g, '').trim();
      if (value && value !== '|' && value !== '>') result[currentKey] = value;
    } else if (currentKey && /^\s+/.test(line)) {
      block.push(line.trim());
    }
  }
  commitBlock();
  result.name = String(result.name || fallbackName).trim();
  result.description = String(result.description || '').trim();
  return result;
}

function shouldSkipFile(name) {
  const lower = name.toLocaleLowerCase('en-US');
  return lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower === 'credentials.json';
}

async function collectDirectoryFiles(directoryHandle, prefix, depth, result) {
  if (depth > MAX_SCAN_DEPTH) return;
  const entries = [];
  for await (const entry of directoryHandle.values()) entries.push(entry);
  entries.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

  for (const entry of entries) {
    if (entry.kind === 'directory') {
      if (!SKIP_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))) {
        await collectDirectoryFiles(entry, prefix + entry.name + '/', depth + 1, result);
      }
      continue;
    }
    if (shouldSkipFile(entry.name)) {
      result.skippedSensitive += 1;
      continue;
    }
    const file = await entry.getFile();
    result.sizeBytes += file.size;
    if (result.sizeBytes > MAX_SKILL_BYTES) throw new Error('单个 Skill 不能超过 20 MB');
    result.files.push({ path: prefix + entry.name, file: file });
    if (result.files.length > MAX_SKILL_FILES) throw new Error('单个 Skill 文件数不能超过 1000');
  }
}

async function fingerprintFiles(files) {
  const chunks = [];
  const encoder = new TextEncoder();
  const zero = new Uint8Array([0]);
  const sorted = [...files].sort(function (a, b) {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  for (const entry of sorted) {
    chunks.push(encoder.encode(entry.path), zero, await entry.file.arrayBuffer(), zero);
  }
  const digest = await crypto.subtle.digest('SHA-256', await new Blob(chunks).arrayBuffer());
  return Array.from(new Uint8Array(digest), function (byte) {
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

function isSystemPath(pathSegments) {
  return pathSegments.some(function (segment) {
    const lower = segment.toLocaleLowerCase('en-US');
    return lower === '.system' || lower === 'openai-bundled' || lower === 'openai-primary-runtime';
  });
}

async function createLocalSkill(directoryHandle, rootName, pathSegments) {
  let skillFile;
  try {
    skillFile = await (await directoryHandle.getFileHandle('SKILL.md')).getFile();
  } catch {
    try {
      skillFile = await (await directoryHandle.getFileHandle('skill.md')).getFile();
    } catch {
      return null;
    }
  }

  const metadata = parseFrontmatter(await skillFile.text(), directoryHandle.name);
  const collected = { files: [], sizeBytes: 0, skippedSensitive: 0 };
  await collectDirectoryFiles(directoryHandle, '', 0, collected);
  const versionHash = await fingerprintFiles(collected.files);
  return {
    name: metadata.name,
    description: metadata.description || '暂无描述',
    folderName: directoryHandle.name,
    platform: 'shared',
    source: rootName,
    ownership: isSystemPath(pathSegments) ? 'system' : 'personal',
    versionHash: versionHash,
    fileCount: collected.files.length,
    sizeBytes: collected.sizeBytes,
    skippedSensitive: collected.skippedSensitive,
    files: collected.files
  };
}

async function walkForSkills(directoryHandle, rootName, pathSegments, depth, output) {
  if (depth > MAX_SCAN_DEPTH) return;
  const entries = [];
  let hasSkillFile = false;
  for await (const entry of directoryHandle.values()) {
    entries.push(entry);
    if (entry.kind === 'file' && entry.name.toLocaleLowerCase('en-US') === 'skill.md') hasSkillFile = true;
  }

  if (hasSkillFile) {
    const skill = await createLocalSkill(directoryHandle, rootName, pathSegments);
    if (skill) output.push(skill);
  }

  for (const entry of entries) {
    if (
      entry.kind === 'directory' &&
      !SKIP_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))
    ) {
      await walkForSkills(entry, rootName, pathSegments.concat(entry.name), depth + 1, output);
    }
  }
}

async function scanDirectoryHandle(rootHandle, sourceLabel) {
  const found = [];
  await walkForSkills(rootHandle, sourceLabel || rootHandle.name, [], 0, found);
  return found;
}

async function createInputSkill(skillPath, files) {
  const prefix = skillPath.slice(0, -'SKILL.md'.length);
  const packageFiles = files
    .filter(function (file) { return file.webkitRelativePath.startsWith(prefix); })
    .filter(function (file) { return !shouldSkipFile(file.name); })
    .map(function (file) { return { path: file.webkitRelativePath.slice(prefix.length), file: file }; });
  const skillFile = packageFiles.find(function (entry) {
    return entry.path.toLocaleLowerCase('en-US') === 'skill.md';
  });
  if (!skillFile) return null;
  const metadata = parseFrontmatter(await skillFile.file.text(), prefix.split('/').filter(Boolean).pop());
  const sizeBytes = packageFiles.reduce(function (total, entry) { return total + entry.file.size; }, 0);
  if (sizeBytes > MAX_SKILL_BYTES || packageFiles.length > MAX_SKILL_FILES) {
    throw new Error('单个 Skill 超过 20 MB 或 1000 个文件');
  }
  const segments = prefix.split('/').filter(Boolean);
  return {
    name: metadata.name,
    description: metadata.description || '暂无描述',
    folderName: segments[segments.length - 1],
    platform: 'shared',
    source: segments[0] || '已选择目录',
    ownership: isSystemPath(segments) ? 'system' : 'personal',
    versionHash: await fingerprintFiles(packageFiles),
    fileCount: packageFiles.length,
    sizeBytes: sizeBytes,
    skippedSensitive: 0,
    files: packageFiles
  };
}

async function scanInputFiles(fileList) {
  const files = Array.from(fileList);
  const skillPaths = files
    .map(function (file) { return file.webkitRelativePath; })
    .filter(function (relativePath) { return relativePath.toLocaleLowerCase('en-US').endsWith('/skill.md'); });
  const results = [];
  for (const skillPath of skillPaths) {
    const skill = await createInputSkill(skillPath, files);
    if (skill) results.push(skill);
  }
  return results;
}

function mergeLocalSkills(skills) {
  const merged = new Map();
  for (const skill of state.localSkills.concat(skills)) {
    merged.set(normalizeName(skill.name) + ':' + skill.versionHash, skill);
  }
  state.localSkills = [...merged.values()].sort(function (a, b) {
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

function replaceLocalSkillsForDirectory(directoryId, skills) {
  state.localSkills = state.localSkills.filter(function (skill) {
    return skill.scanDirectoryId !== directoryId;
  });
  for (const skill of skills) skill.scanDirectoryId = directoryId;
  mergeLocalSkills(skills);
}

function findCloudSkill(localSkill) {
  return state.cloudSkills.find(function (skill) {
    return normalizeName(skill.name) === normalizeName(localSkill.name);
  });
}

function findLocalSkill(cloudSkill) {
  const candidates = state.localSkills.filter(function (skill) {
    return normalizeName(skill.name) === normalizeName(cloudSkill.name);
  });
  return candidates.find(function (skill) {
    return skill.versionHash === cloudSkill.versionHash;
  }) || candidates[0];
}

function getLocalStatus(skill) {
  if (skill.ownership === 'system') return { label: '系统自带', className: '' };
  const cloud = findCloudSkill(skill);
  if (!cloud) return { label: '仅本机', className: 'missing' };
  if (cloud.versionHash === skill.versionHash) return { label: '已同步', className: 'synced' };
  return { label: '版本不同', className: 'different' };
}

function getCloudStatus(skill) {
  const local = findLocalSkill(skill);
  if (!local) return { label: '本机缺失', className: 'missing' };
  if (local.versionHash === skill.versionHash) return { label: '已安装', className: 'synced' };
  return { label: '版本不同', className: 'different' };
}

function createButton(label, action, index, kind, disabled, source) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button ' + (kind || 'secondary');
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.index = String(index);
  if (source) button.dataset.source = source;
  button.disabled = Boolean(disabled);
  return button;
}

function createSkillCard(skill, source, index) {
  const status = source === 'local' ? getLocalStatus(skill) : getCloudStatus(skill);
  const card = document.createElement('article');
  card.className = 'skill-card';

  const meta = document.createElement('div');
  meta.className = 'skill-meta';
  const origin = document.createElement('span');
  origin.className = 'skill-origin';
  if (source === 'local') origin.textContent = skill.source;
  if (source === 'cloud') origin.textContent = skill.visibility === 'community' ? '我的 · 社区' : '我的 · 私有';
  if (source === 'community') origin.textContent = 'BY ' + (skill.authorName || '社区用户');
  const badge = document.createElement('span');
  badge.className = 'status-badge ' + status.className;
  badge.textContent = status.label;
  meta.append(origin, badge);

  const title = document.createElement('h3');
  title.textContent = skill.name;
  const description = document.createElement('p');
  description.className = 'skill-description';
  description.textContent = skill.description || '暂无描述';
  const zhSummary = document.createElement('p');
  zhSummary.className = 'skill-zh-summary';
  zhSummary.textContent = '中文简介：' + truncateZh(getSkillZhSummary(skill), 60);
  const details = document.createElement('p');
  details.className = 'skill-details';
  details.textContent = skill.fileCount + ' FILES · ' + formatBytes(skill.sizeBytes || 0);

  const actions = document.createElement('div');
  actions.className = 'skill-actions';
  if (source === 'local') {
    const cloud = findCloudSkill(skill);
    const sameVersion = cloud && cloud.versionHash === skill.versionHash;
    // 所有本机 Skill 均可上传，不再按「系统自带」拦截。
    const canUpload = Boolean(skill.helperSkillId) || (
      Array.isArray(skill.files) && skill.files.length > 0
    );
    if (!state.user && canUpload) {
      actions.append(createButton('登录后上传', 'login', index, 'primary', false, source));
    } else if (canUpload) {
      const privateSynced = sameVersion && cloud.visibility === 'private';
      const communitySynced = sameVersion && cloud.visibility === 'community';
      actions.append(createButton(
        privateSynced ? '已私有同步' : '同步为私有',
        'upload-private',
        index,
        privateSynced ? 'secondary' : 'primary',
        privateSynced,
        source
      ));
      actions.append(createButton(
        communitySynced ? '已发布社区' : '发布到社区',
        'upload-community',
        index,
        'secondary',
        communitySynced,
        source
      ));
    } else {
      actions.append(createButton('不可上传', 'none', index, 'secondary', true, source));
    }
  } else {
    const local = findLocalSkill(skill);
    const installed = local && local.versionHash === skill.versionHash;
    actions.append(createButton(
      installed ? '已安装' : '安装到目录',
      'install',
      index,
      installed ? 'secondary' : 'primary',
      installed || typeof window.showDirectoryPicker !== 'function',
      source
    ));
    actions.append(createButton('下载包', 'download', index, 'secondary', false, source));
    if (source === 'cloud') {
      actions.append(createButton(
        skill.visibility === 'community' ? '设为私有' : '发布社区',
        'toggle-visibility',
        index,
        'secondary',
        false,
        source
      ));
      actions.append(createButton('删除', 'delete', index, 'danger', false, source));
    }
  }

  card.append(meta, title, description, zhSummary, details, actions);
  return card;
}

function scanDirectoryStatus(directory) {
  const helperRoot = !directory.custom && state.helper.connected
    ? state.helper.roots[directory.id]
    : null;
  if (helperRoot?.status === 'ready') return { label: helperRoot.skillCount + ' 个 Skill', className: 'synced' };
  if (helperRoot?.status === 'missing') return { label: '目录不存在', className: 'missing' };
  if (helperRoot?.status === 'error') return { label: '扫描失败', className: 'different' };
  if (!directory.custom && state.helper.connected) return { label: '助手待扫描', className: '' };
  if (directory.status === 'scanning') return { label: '扫描中', className: '' };
  if (directory.status === 'ready') return { label: directory.skillCount + ' 个 Skill', className: 'synced' };
  if (directory.status === 'error') return { label: '扫描失败', className: 'different' };
  if (directory.handle) return { label: '需重新授权', className: 'missing' };
  return { label: '待授权', className: 'missing' };
}

function createScanDirectoryCard(directory, index) {
  const card = document.createElement('article');
  card.className = 'scan-directory-card' + (directory.custom ? ' custom' : '');

  const header = document.createElement('div');
  header.className = 'scan-directory-card-header';
  const title = document.createElement('strong');
  title.textContent = directory.label;
  const status = scanDirectoryStatus(directory);
  const badge = document.createElement('span');
  badge.className = 'status-badge ' + status.className;
  badge.textContent = status.label;
  header.append(title, badge);

  const path = document.createElement('code');
  path.textContent = directory.path;
  path.title = directory.path;
  const detail = document.createElement('small');
  const helperRoot = !directory.custom && state.helper.connected
    ? state.helper.roots[directory.id]
    : null;
  detail.textContent = helperRoot?.status === 'ready'
    ? '本地助手直接读取，无需浏览器授权'
    : helperRoot?.status === 'missing'
      ? '当前电脑中没有此目录'
      : helperRoot?.status === 'error'
        ? (helperRoot.error || '助手无法读取该目录')
        : directory.status === 'error'
    ? (directory.error || '无法读取该目录')
    : directory.handle
      ? '已关联：' + directory.handle.name
      : directory.custom
        ? '首次授权后将保存到当前浏览器'
        : '启动助手可直接扫描；浏览器授权为备用模式';

  const actions = document.createElement('div');
  actions.className = 'scan-directory-actions';
  if (!directory.custom && !state.helper.connected) {
    actions.append(createButton('复制路径', 'copy-directory-path', index, 'secondary', state.busy));
  }
  if (directory.custom || !state.helper.connected) {
    const authorizeLabel = directory.handle
      ? directory.status === 'permission' ? '重新授权' : '更换目录'
      : directory.custom ? '授权目录' : '浏览器授权';
    const authorize = createButton(
      authorizeLabel,
      'authorize-directory',
      index,
      directory.handle ? 'secondary' : 'primary',
      state.busy || typeof window.showDirectoryPicker !== 'function'
    );
    actions.append(authorize);
  }
  if (directory.custom) {
    actions.append(createButton('移除', 'remove-directory', index, 'danger', state.busy));
  }

  card.append(header, path, detail, actions);
  return card;
}

function renderScanDirectories() {
  elements.scanDirectories.replaceChildren();
  state.scanDirectories.forEach(function (directory, index) {
    elements.scanDirectories.append(createScanDirectoryCard(directory, index));
  });
  if (state.helper.connected) {
    const helperRoots = Object.values(state.helper.roots);
    const ready = helperRoots.filter(function (root) { return root.status === 'ready'; }).length;
    elements.scanDirectorySummary.textContent = '助手已连接' + (helperRoots.length ? ' · 已扫描 ' + ready + ' / 3' : '');
  } else {
    const authorized = state.scanDirectories.filter(function (directory) { return Boolean(directory.handle); }).length;
    const ready = state.scanDirectories.filter(function (directory) { return directory.status === 'ready'; }).length;
    elements.scanDirectorySummary.textContent = '浏览器已授权 ' + authorized + ' / ' + state.scanDirectories.length +
      (ready ? ' · 已扫描 ' + ready : '');
  }
}

function renderSectionEmpty(emptyElement, totalCount, visibleCount, searching, getDefault) {
  const strong = emptyElement.querySelector('strong');
  const span = emptyElement.querySelector('span');
  const defaults = getDefault();
  if (searching && totalCount > 0 && visibleCount === 0) {
    strong.textContent = '没有匹配的 Skill';
    span.textContent = '没有找到与「' + state.searchQuery + '」匹配的 Skill，换个关键词试试。';
    emptyElement.classList.remove('hidden');
    return;
  }
  emptyElement.classList.toggle('hidden', totalCount > 0);
  strong.textContent = defaults.title;
  span.textContent = defaults.copy;
}

function renderSearchSummary(searching, visible) {
  if (!searching) {
    elements.searchCount.textContent = '';
    elements.clearSearch.hidden = true;
    return;
  }
  elements.clearSearch.hidden = false;
  const total = visible.local + visible.cloud + visible.community;
  const grand = state.localSkills.length + state.cloudSkills.length + state.communitySkills.length;
  elements.searchCount.textContent = '匹配 ' + total + ' / ' + grand + ' 个（本机 ' +
    visible.local + ' · 云端 ' + visible.cloud + ' · 社区 ' + visible.community + '）';
}

function render() {
  elements.localSkills.replaceChildren();
  elements.cloudSkills.replaceChildren();
  elements.communitySkills.replaceChildren();
  const query = normalizeSearchText(state.searchQuery);
  const searching = Boolean(query);
  const visible = { local: 0, cloud: 0, community: 0 };

  state.localSkills.forEach(function (skill, index) {
    if (searching && !skillMatchesSearch(skill, query)) return;
    visible.local += 1;
    elements.localSkills.append(createSkillCard(skill, 'local', index));
  });
  state.cloudSkills.forEach(function (skill, index) {
    if (searching && !skillMatchesSearch(skill, query)) return;
    visible.cloud += 1;
    elements.cloudSkills.append(createSkillCard(skill, 'cloud', index));
  });
  state.communitySkills.forEach(function (skill, index) {
    if (searching && !skillMatchesSearch(skill, query)) return;
    visible.community += 1;
    elements.communitySkills.append(createSkillCard(skill, 'community', index));
  });

  renderSectionEmpty(elements.localEmpty, state.localSkills.length, visible.local, searching, function () {
    return { title: '还没有本机清单', copy: '在上方授权至少一个默认目录后，Skill 会自动出现在这里。' };
  });
  renderSectionEmpty(elements.cloudEmpty, state.cloudSkills.length, visible.cloud, searching, function () {
    return state.user
      ? { title: '我的云端仓库为空', copy: '扫描本机目录后，可选择私有同步或发布到社区。' }
      : { title: '登录后使用私有同步', copy: '你的私有 Skill 与其他账号完全隔离。' };
  });
  renderSectionEmpty(elements.communityEmpty, state.communitySkills.length, visible.community, searching, function () {
    return { title: '社区暂时为空', copy: '登录后可将自己的 Skill 发布到社区。' };
  });
  renderSearchSummary(searching, visible);

  const different = state.cloudSkills.filter(function (skill) {
    const local = findLocalSkill(skill);
    return local && local.versionHash !== skill.versionHash;
  }).length;
  elements.localCount.textContent = String(state.localSkills.length);
  elements.cloudCount.textContent = String(state.cloudSkills.length);
  elements.communityCount.textContent = String(state.communitySkills.length);
  elements.differentCount.textContent = String(different);
}

function renderAccount() {
  elements.loginLink.classList.toggle('hidden', Boolean(state.user));
  elements.userMenu.classList.toggle('hidden', !state.user);
  elements.userName.textContent = state.user ? state.user.displayName : '';
  elements.cloudEmptyTitle.textContent = state.user ? '我的云端仓库为空' : '登录后使用私有同步';
  elements.cloudEmptyCopy.textContent = state.user
    ? '扫描本机目录后，可选择私有同步或发布到社区。'
    : '你的私有 Skill 与其他账号完全隔离。';
}

async function refreshCloud() {
  try {
    elements.communityLabel.textContent = '正在读取';
    elements.cloudLabel.textContent = state.user ? '正在读取' : '登录后同步';
    const communityResult = await apiRequest('/api/skills?scope=community');
    state.communitySkills = communityResult.skills || [];
    ensureZhSummaries(state.communitySkills);
    state.cloudSkills = [];
    if (state.user) {
      try {
        const mineResult = await apiRequest('/api/skills?scope=mine');
        state.cloudSkills = mineResult.skills || [];
        ensureZhSummaries(state.cloudSkills);
      } catch (error) {
        if (error.status !== 401) throw error;
        state.user = null;
        renderAccount();
      }
    }
    elements.communityLabel.textContent = state.communitySkills.length + ' 个公开 Skill';
    elements.cloudLabel.textContent = state.user ? state.cloudSkills.length + ' 个 Skill' : '登录后同步';
    setConnection('online', state.user ? '账号已连接' : '社区已连接');
    render();
  } catch (error) {
    elements.communityLabel.textContent = error.message;
    setConnection('offline', error.message);
    showToast(error.message, true);
  }
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function packageLocalSkill(skill) {
  if (skill.helperSkillId) {
    return helperRequest('/v1/skills/' + encodeURIComponent(skill.helperSkillId) + '/package', 120000);
  }
  const files = [];
  for (const entry of skill.files) {
    files.push({ path: entry.path, contentBase64: await fileToBase64(entry.file) });
  }
  return {
    schemaVersion: 1,
    skill: {
      name: skill.name,
      description: skill.description,
      zhSummary: getSkillZhSummary(skill),
      platform: skill.platform,
      folderName: skill.folderName
    },
    files: files
  };
}

async function uploadSkill(index, visibility, button) {
  const skill = state.localSkills[index];
  if (!state.user) {
    openAuthDialog();
    return;
  }
  if (!skill) return;
  button.disabled = true;
  button.textContent = '正在上传';
  try {
    const payload = await packageLocalSkill(skill);
    payload.visibility = visibility;
    const result = await apiRequest('/api/skills', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    showToast(result.skill.name + (visibility === 'community' ? ' 已发布到社区' : ' 已私有同步'));
    await refreshCloud();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
    button.textContent = '重试上传';
  }
}

function confirmAction(title, message) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmDialog.returnValue = '';
  elements.confirmDialog.showModal();
  return new Promise(function (resolve) {
    elements.confirmDialog.addEventListener('close', function onClose() {
      resolve(elements.confirmDialog.returnValue === 'confirm');
    }, { once: true });
  });
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safePackageSegments(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    !normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ||
    segments.some(function (segment) { return !segment || segment === '.' || segment === '..'; })
  ) {
    throw new Error('云端 Skill 包含不安全路径');
  }
  return segments;
}

async function directoryExists(parent, name) {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function writePackageToDirectory(parent, skillPackage) {
  const folderName = skillPackage.skill.folderName || skillPackage.id;
  const existing = await directoryExists(parent, folderName);
  if (existing) {
    const confirmed = await confirmAction(
      '覆盖已有 Skill？',
      '目标目录中已存在“' + folderName + '”。继续后会覆盖同名文件，但不会删除额外文件。'
    );
    if (!confirmed) return false;
  }
  const target = existing || await parent.getDirectoryHandle(folderName, { create: true });
  for (const file of skillPackage.files) {
    const segments = safePackageSegments(file.path);
    const fileName = segments.pop();
    let directory = target;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(base64ToBytes(file.contentBase64));
    } finally {
      await writable.close();
    }
  }
  return true;
}

function skillCollection(source) {
  return source === 'community' ? state.communitySkills : state.cloudSkills;
}

async function getCloudPackage(index, source) {
  const skill = skillCollection(source)[index];
  if (!skill) throw new Error('云端 Skill 不存在');
  return apiRequest('/api/skills/' + encodeURIComponent(skill.id));
}

async function installSkill(index, source, button) {
  if (typeof window.showDirectoryPicker !== 'function') {
    showToast('当前浏览器不支持直接安装，请下载 Skill 包', true);
    return;
  }
  button.disabled = true;
  button.textContent = '等待选择目录';
  try {
    const skillPackage = await getCloudPackage(index, source);
    const targetRoot = await window.showDirectoryPicker({ mode: 'readwrite' });
    button.textContent = '正在写入';
    const installed = await writePackageToDirectory(targetRoot, skillPackage);
    if (!installed) return;
    state.localSkills = state.localSkills.filter(function (skill) {
      return normalizeName(skill.name) !== normalizeName(skillPackage.skill.name);
    });
    state.localSkills.push({
      name: skillPackage.skill.name,
      description: skillPackage.skill.description,
      folderName: skillPackage.skill.folderName,
      platform: skillPackage.skill.platform,
      source: targetRoot.name,
      ownership: 'personal',
      versionHash: skillPackage.versionHash,
      fileCount: skillPackage.files.length,
      sizeBytes: skillPackage.files.reduce(function (sum, file) {
        return sum + Math.floor(file.contentBase64.length * 0.75);
      }, 0),
      skippedSensitive: 0,
      files: []
    });
    mergeLocalSkills([]);
    render();
    showToast(skillPackage.skill.name + ' 已安装');
  } catch (error) {
    if (error.name !== 'AbortError') showToast(error.message, true);
  } finally {
    button.disabled = false;
    render();
  }
}

async function downloadSkill(index, source, button) {
  button.disabled = true;
  try {
    const skillPackage = await getCloudPackage(index, source);
    const blob = new Blob([JSON.stringify(skillPackage, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = (skillPackage.skill.folderName || skillPackage.id) + '.skill-atlas.json';
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('Skill 包已下载');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function toggleVisibility(index, button) {
  const skill = state.cloudSkills[index];
  if (!skill) return;
  const visibility = skill.visibility === 'community' ? 'private' : 'community';
  if (visibility === 'community') {
    const confirmed = await confirmAction(
      '发布到社区？',
      '发布后，所有访客都可以查看和下载这个 Skill。'
    );
    if (!confirmed) return;
  }
  button.disabled = true;
  try {
    await apiRequest('/api/skills/' + encodeURIComponent(skill.id), {
      method: 'PATCH',
      body: JSON.stringify({ visibility: visibility })
    });
    showToast(visibility === 'community' ? '已发布到社区' : '已设为私有');
    await refreshCloud();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
}

async function deleteCloudSkill(index, button) {
  const skill = state.cloudSkills[index];
  if (!skill) return;
  const confirmed = await confirmAction(
    '删除云端 Skill？',
    '将删除“' + skill.name + '”的全部云端版本，本机文件不会受影响。'
  );
  if (!confirmed) return;
  button.disabled = true;
  try {
    await apiRequest('/api/skills/' + encodeURIComponent(skill.id), { method: 'DELETE' });
    showToast(skill.name + ' 已从云端删除');
    await refreshCloud();
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
}

async function directoryHasReadPermission(directory) {
  if (!directory.handle) return false;
  if (typeof directory.handle.queryPermission !== 'function') return true;
  return await directory.handle.queryPermission({ mode: 'read' }) === 'granted';
}

async function scanConfiguredDirectory(directory) {
  if (!directory.handle) return false;
  if (!await directoryHasReadPermission(directory)) {
    directory.status = 'permission';
    directory.error = '';
    renderScanDirectories();
    return false;
  }

  directory.status = 'scanning';
  directory.error = '';
  renderScanDirectories();
  try {
    const skills = await scanDirectoryHandle(directory.handle, directory.label);
    if (directory.id === 'codex-plugins') {
      for (const skill of skills) skill.ownership = 'system';
    }
    replaceLocalSkillsForDirectory(directory.id, skills);
    ensureZhSummaries(skills);
    directory.skillCount = skills.length;
    directory.status = 'ready';
    render();
    renderScanDirectories();
    return true;
  } catch (error) {
    directory.status = 'error';
    directory.error = error.message;
    renderScanDirectories();
    return false;
  }
}

async function scanAllConfiguredDirectories(automatic) {
  if (state.busy) return;
  if (typeof window.showDirectoryPicker !== 'function' || !window.isSecureContext) {
    if (!automatic) elements.directoryInput.click();
    return;
  }

  setBusy(true, automatic ? '正在自动扫描默认目录' : '正在扫描默认目录');
  renderScanDirectories();
  let scanned = 0;
  try {
    for (const directory of state.scanDirectories) {
      if (await scanConfiguredDirectory(directory)) scanned += 1;
    }
    elements.scanLabel.textContent = scanned
      ? '已扫描 ' + scanned + ' 个目录 · 找到 ' + state.localSkills.length + ' 个 Skill'
      : '默认目录尚未授权';
    if (!automatic) {
      showToast(scanned ? '默认目录扫描完成' : '请先授权至少一个默认目录', !scanned);
    }
    if (scanned) await promptDuplicateDedup();
  } finally {
    setBusy(false);
    renderScanDirectories();
  }
}

async function authorizeScanDirectory(index) {
  const directory = state.scanDirectories[index];
  if (!directory || state.busy) return;
  if (typeof window.showDirectoryPicker !== 'function' || !window.isSecureContext) {
    elements.directoryInput.click();
    return;
  }

  try {
    if (
      directory.handle && directory.status === 'permission' &&
      typeof directory.handle.requestPermission === 'function'
    ) {
      const permission = await directory.handle.requestPermission({ mode: 'read' });
      if (permission !== 'granted') {
        showToast('未获得该目录的读取权限', true);
        return;
      }
    } else {
      directory.handle = await window.showDirectoryPicker({ mode: 'read' });
    }
    directory.status = 'waiting';
    directory.error = '';
    try {
      await storeScanDirectory(directory);
    } catch {
      showToast('目录可以扫描，但当前浏览器无法保存授权', true);
    }
    setBusy(true, '正在扫描 ' + directory.label);
    await scanConfiguredDirectory(directory);
    elements.scanLabel.textContent = directory.label + ' · 找到 ' + directory.skillCount + ' 个 Skill';
    showToast(directory.label + ' 已设为默认扫描目录');
    await promptDuplicateDedup();
  } catch (error) {
    if (error.name !== 'AbortError') showToast(error.message, true);
  } finally {
    setBusy(false);
    renderScanDirectories();
  }
}

async function copyScanDirectoryPath(index, button) {
  const directory = state.scanDirectories[index];
  if (!directory || directory.custom) return;
  try {
    await navigator.clipboard.writeText(directory.path);
    button.textContent = '已复制';
    showToast('路径已复制；点击“授权目录”后粘贴到地址栏');
    setTimeout(function () {
      if (button.isConnected) button.textContent = '复制路径';
    }, 1800);
  } catch {
    showToast('复制失败，请手动复制卡片中的路径', true);
  }
}

async function addScanDirectory() {
  if (state.busy) return;
  if (typeof window.showDirectoryPicker !== 'function' || !window.isSecureContext) {
    elements.directoryInput.click();
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    for (let index = 0; index < state.scanDirectories.length; index += 1) {
      const existing = state.scanDirectories[index];
      if (existing.handle && typeof existing.handle.isSameEntry === 'function' && await existing.handle.isSameEntry(handle)) {
        showToast('该目录已经在默认扫描列表中');
        return;
      }
    }
    const directory = {
      id: 'custom-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()),
      label: '自定义 · ' + handle.name,
      path: handle.name,
      custom: true,
      handle: handle,
      status: 'waiting',
      skillCount: 0,
      error: ''
    };
    state.scanDirectories.push(directory);
    try {
      await storeScanDirectory(directory);
    } catch {
      showToast('目录可以扫描，但当前浏览器无法保存授权', true);
    }
    setBusy(true, '正在扫描 ' + directory.label);
    await scanConfiguredDirectory(directory);
    elements.scanLabel.textContent = directory.label + ' · 找到 ' + directory.skillCount + ' 个 Skill';
    showToast('已新增默认扫描目录');
    await promptDuplicateDedup();
  } catch (error) {
    if (error.name !== 'AbortError') showToast(error.message, true);
  } finally {
    setBusy(false);
    renderScanDirectories();
  }
}

async function removeScanDirectory(index) {
  const directory = state.scanDirectories[index];
  if (!directory || !directory.custom || state.busy) return;
  try {
    await removeStoredScanDirectory(directory.id);
    state.scanDirectories.splice(index, 1);
    replaceLocalSkillsForDirectory(directory.id, []);
    render();
    renderScanDirectories();
    showToast('已移除默认扫描目录');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function initializeScanDirectories() {
  try {
    const stored = await readStoredScanDirectories();
    const storedById = new Map(stored.map(function (directory) { return [directory.id, directory]; }));
    state.scanDirectories = DEFAULT_SCAN_DIRECTORIES.map(function (directory) {
      const saved = storedById.get(directory.id);
      return Object.assign({ handle: saved?.handle || null, status: 'waiting', skillCount: 0, error: '' }, directory);
    });
    for (const directory of stored) {
      if (!directory.custom || DEFAULT_SCAN_DIRECTORIES.some(function (item) { return item.id === directory.id; })) continue;
      state.scanDirectories.push(Object.assign({ status: 'waiting', skillCount: 0, error: '' }, directory));
    }
  } catch {
    state.scanDirectories = DEFAULT_SCAN_DIRECTORIES.map(function (directory) {
      return Object.assign({ handle: null, status: 'waiting', skillCount: 0, error: '' }, directory);
    });
  }
  renderScanDirectories();
}

async function handleInputScan(event) {
  if (!event.target.files.length) return;
  setBusy(true, '正在扫描已选择目录');
  try {
    const skills = await scanInputFiles(event.target.files);
    mergeLocalSkills(skills);
    ensureZhSummaries(skills);
    elements.scanLabel.textContent = '兼容模式 · 找到 ' + skills.length + ' 个 Skill';
    render();
    showToast('扫描完成；当前浏览器仅支持下载，不能直接安装');
    await promptDuplicateDedup();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    event.target.value = '';
    setBusy(false);
  }
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('服务不可用');
    const account = await apiRequest('/api/auth/me');
    state.user = account.user || null;
    renderAccount();
    if (!result.ssoConfigured) {
      elements.loginLink.classList.add('disabled');
      elements.loginLink.removeAttribute('href');
      elements.loginLink.title = '统一账号尚未配置';
    }
    await refreshCloud();
  } catch (error) {
    setConnection('offline', '云端不可用');
    elements.cloudLabel.textContent = error.message;
    elements.communityLabel.textContent = error.message;
  }
}

elements.scanDirectory.addEventListener('click', scanDefaultSources);
elements.addScanDirectory.addEventListener('click', addScanDirectory);
if (elements.detectHelper) {
  elements.detectHelper.addEventListener('click', async function () {
    if (await detectHelper(false)) await scanWithHelper(false);
  });
}

/**
 * 桌面版检测。
 *
 * 这里刻意不再给"复制一条 PowerShell 命令去下载脚本再运行"——那是上一版的
 * 安装方式，绝大多数人过不去（见 docs/solution.md §11 缺陷 #5）。
 * 现在默认路径是下载桌面应用（C 通道的只读形态）；本地助手（B 通道 CLI）
 * 仍然可用，但只作为自动化/CI 的可选入口，不再出现在首页主引导里。
 */
async function detectDesktopApp() {
  const status = elements.desktopStatus;
  if (!status) return;
  // 页面本身被桌面版内嵌加载时（file:// 或带 desktop=1），直接判定为已安装
  const embedded = window.location.protocol === 'file:' ||
    new URLSearchParams(window.location.search).has('desktop');
  status.className = 'desktop-connection-status ' + (embedded ? 'connected' : 'disconnected');
  if (elements.desktopStatusLabel) {
    elements.desktopStatusLabel.textContent = embedded ? '已在使用桌面版' : '未检测到桌面版';
  }
  if (elements.desktopStatusVersion) {
    elements.desktopStatusVersion.textContent = embedded ? '只读模式' : '';
  }
  if (elements.downloadDesktop) {
    elements.downloadDesktop.textContent = embedded ? '查看版本说明' : '下载桌面版';
  }
}
detectDesktopApp();

elements.scanDirectories.addEventListener('click', function (event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === 'copy-directory-path') copyScanDirectoryPath(index, button);
  if (button.dataset.action === 'authorize-directory') authorizeScanDirectory(index);
  if (button.dataset.action === 'remove-directory') removeScanDirectory(index);
});
elements.loginLink.addEventListener('click', openAuthDialog);
elements.authLoginTab.addEventListener('click', function () { setAuthMode('login'); });
elements.authRegisterTab.addEventListener('click', function () { setAuthMode('register'); });
elements.cancelAuth.addEventListener('click', function () { elements.authDialog.close(); });
elements.authCode.addEventListener('input', function () {
  elements.authCode.value = elements.authCode.value.replace(/\D/g, '').slice(0, 6);
});
elements.sendAuthCode.addEventListener('click', async function () {
  if (!elements.authEmail.value) {
    setAuthMessage('请先填写邮箱', true);
    return;
  }
  elements.sendAuthCode.disabled = true;
  setAuthMessage('', false);
  try {
    const result = await apiRequest('/api/auth/register-code', {
      method: 'POST',
      body: JSON.stringify({ email: elements.authEmail.value })
    });
    setAuthMessage(result.message || '验证码已发送', false);
  } catch (error) {
    setAuthMessage(error.message, true);
  } finally {
    elements.sendAuthCode.disabled = false;
  }
});
elements.authForm.addEventListener('submit', async function (event) {
  event.preventDefault();
  elements.submitAuth.disabled = true;
  setAuthMessage('', false);
  const registering = state.authMode === 'register';
  try {
    const result = await apiRequest(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: elements.authEmail.value,
        password: elements.authPassword.value,
        code: registering ? elements.authCode.value : undefined,
        name: registering ? elements.authName.value : undefined
      })
    });
    state.user = result.user;
    elements.authDialog.close();
    renderAccount();
    await refreshCloud();
    showToast(registering ? '注册成功' : '登录成功');
  } catch (error) {
    setAuthMessage(error.message, true);
  } finally {
    elements.submitAuth.disabled = false;
  }
});
elements.directoryInput.addEventListener('change', handleInputScan);
elements.refreshCloud.addEventListener('click', refreshCloud);
elements.skillSearch.addEventListener('input', function () {
  state.searchQuery = elements.skillSearch.value;
  render();
});
elements.clearSearch.addEventListener('click', function () {
  state.searchQuery = '';
  elements.skillSearch.value = '';
  render();
  elements.skillSearch.focus();
});
elements.localSkills.addEventListener('click', function (event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === 'login') openAuthDialog();
  if (button.dataset.action === 'upload-private') uploadSkill(index, 'private', button);
  if (button.dataset.action === 'upload-community') uploadSkill(index, 'community', button);
});
elements.cloudSkills.addEventListener('click', function (event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === 'install') installSkill(index, 'cloud', button);
  if (button.dataset.action === 'download') downloadSkill(index, 'cloud', button);
  if (button.dataset.action === 'toggle-visibility') toggleVisibility(index, button);
  if (button.dataset.action === 'delete') deleteCloudSkill(index, button);
});
elements.communitySkills.addEventListener('click', function (event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === 'install') installSkill(index, 'community', button);
  if (button.dataset.action === 'download') downloadSkill(index, 'community', button);
});

elements.logout.addEventListener('click', async function () {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.cloudSkills = [];
    renderAccount();
    await refreshCloud();
    showToast('已退出登录');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.claimLegacy.addEventListener('click', function () {
  elements.legacyToken.value = '';
  elements.legacyDialog.showModal();
});
elements.cancelLegacy.addEventListener('click', function () {
  elements.legacyDialog.close();
});
elements.legacyForm.addEventListener('submit', async function (event) {
  event.preventDefault();
  try {
    const result = await apiRequest('/api/auth/claim-legacy', {
      method: 'POST',
      body: JSON.stringify({ legacyToken: elements.legacyToken.value })
    });
    elements.legacyDialog.close();
    await refreshCloud();
    showToast('已认领 ' + result.claimedLegacyCount + ' 个旧 Skill');
  } catch (error) {
    showToast(error.message, true);
  }
});

state.zhSummaries = loadZhSummaries();
render();
renderAccount();
renderHelper();
renderScanDirectories();
if (new URLSearchParams(window.location.search).has('auth_error')) {
  showToast('登录未完成，请重试', true);
  window.history.replaceState({}, '', window.location.pathname);
}
checkHealth();
const helperInitialization = initializeHelper();
helperInitialization.then(function (connected) {
  if (connected) scanWithHelper(true);
});
Promise.all([initializeScanDirectories(), helperInitialization]).then(function (results) {
  if (!results[1]) scanAllConfiguredDirectories(true);
});
