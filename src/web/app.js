const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 1000;
const MAX_SCAN_DEPTH = 12;
const SKIP_DIRECTORIES = new Set(['.git', '.svn', 'node_modules', '__pycache__', 'dist', 'build', 'coverage']);

const state = {
  localSkills: [],
  cloudSkills: [],
  accessToken: readSessionToken(),
  protected: false,
  busy: false
};

const elements = {
  accessToken: document.querySelector('#access-token'),
  cloudCount: document.querySelector('#cloud-count'),
  cloudEmpty: document.querySelector('#cloud-empty'),
  cloudLabel: document.querySelector('#cloud-label'),
  cloudSkills: document.querySelector('#cloud-skills'),
  confirmDialog: document.querySelector('#confirm-dialog'),
  confirmMessage: document.querySelector('#confirm-message'),
  confirmTitle: document.querySelector('#confirm-title'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionText: document.querySelector('#connection-text'),
  differentCount: document.querySelector('#different-count'),
  directoryInput: document.querySelector('#directory-input'),
  localCount: document.querySelector('#local-count'),
  localEmpty: document.querySelector('#local-empty'),
  localSkills: document.querySelector('#local-skills'),
  missingCount: document.querySelector('#missing-count'),
  refreshCloud: document.querySelector('#refresh-cloud'),
  saveToken: document.querySelector('#save-token'),
  scanDirectory: document.querySelector('#scan-directory'),
  scanLabel: document.querySelector('#scan-label'),
  toast: document.querySelector('#toast')
};

function readSessionToken() {
  try {
    return sessionStorage.getItem('skill-atlas-token') || '';
  } catch {
    return '';
  }
}

function saveSessionToken(value) {
  try {
    sessionStorage.setItem('skill-atlas-token', value);
  } catch {
    // 隐私模式禁用会话存储时，令牌仅保留在内存中。
  }
}

function normalizeName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').trim();
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
  elements.refreshCloud.disabled = value;
  if (label) elements.scanLabel.textContent = label;
}

async function apiRequest(pathname, options) {
  const requestOptions = Object.assign({}, options || {});
  requestOptions.headers = Object.assign({}, requestOptions.headers || {});
  if (state.accessToken) requestOptions.headers.Authorization = 'Bearer ' + state.accessToken;
  if (requestOptions.body) requestOptions.headers['Content-Type'] = 'application/json';
  const response = await fetch(pathname, requestOptions);
  const result = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error(result.error || '请求失败（' + response.status + '）');
  return result;
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

async function scanDirectoryHandle(rootHandle) {
  const found = [];
  await walkForSkills(rootHandle, rootHandle.name, [], 0, found);
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

function createButton(label, action, index, kind, disabled) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button ' + (kind || 'secondary');
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.index = String(index);
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
  origin.textContent = source === 'local' ? skill.source : 'PRIVATE CLOUD';
  const badge = document.createElement('span');
  badge.className = 'status-badge ' + status.className;
  badge.textContent = status.label;
  meta.append(origin, badge);

  const title = document.createElement('h3');
  title.textContent = skill.name;
  const description = document.createElement('p');
  description.className = 'skill-description';
  description.textContent = skill.description || '暂无描述';
  const details = document.createElement('p');
  details.className = 'skill-details';
  details.textContent = skill.fileCount + ' FILES · ' + formatBytes(skill.sizeBytes || 0);

  const actions = document.createElement('div');
  actions.className = 'skill-actions';
  if (source === 'local') {
    const cloud = findCloudSkill(skill);
    const synced = cloud && cloud.versionHash === skill.versionHash;
    const canUpload = skill.ownership !== 'system' && skill.files.length > 0;
    actions.append(createButton(
      synced ? '已同步' : canUpload ? (cloud ? '更新云端' : '上传云端') : '请重新扫描',
      'upload',
      index,
      synced ? 'secondary' : 'primary',
      synced || !canUpload
    ));
  } else {
    const local = findLocalSkill(skill);
    const installed = local && local.versionHash === skill.versionHash;
    actions.append(createButton(
      installed ? '已安装' : '安装到目录',
      'install',
      index,
      installed ? 'secondary' : 'primary',
      installed || typeof window.showDirectoryPicker !== 'function'
    ));
    actions.append(createButton('下载包', 'download', index, 'secondary', false));
  }

  card.append(meta, title, description, details, actions);
  return card;
}

function render() {
  elements.localSkills.replaceChildren();
  elements.cloudSkills.replaceChildren();
  state.localSkills.forEach(function (skill, index) {
    elements.localSkills.append(createSkillCard(skill, 'local', index));
  });
  state.cloudSkills.forEach(function (skill, index) {
    elements.cloudSkills.append(createSkillCard(skill, 'cloud', index));
  });

  const missing = state.cloudSkills.filter(function (skill) { return !findLocalSkill(skill); }).length;
  const different = state.cloudSkills.filter(function (skill) {
    const local = findLocalSkill(skill);
    return local && local.versionHash !== skill.versionHash;
  }).length;
  elements.localCount.textContent = String(state.localSkills.length);
  elements.cloudCount.textContent = String(state.cloudSkills.length);
  elements.missingCount.textContent = String(missing);
  elements.differentCount.textContent = String(different);
  elements.localEmpty.classList.toggle('hidden', state.localSkills.length > 0);
  elements.cloudEmpty.classList.toggle('hidden', state.cloudSkills.length > 0);
}

async function refreshCloud() {
  try {
    elements.cloudLabel.textContent = '正在读取';
    const result = await apiRequest('/api/skills');
    state.cloudSkills = result.skills || [];
    elements.cloudLabel.textContent = '已连接 · ' + state.cloudSkills.length + ' 个 Skill';
    setConnection('online', '云端已连接');
    render();
  } catch (error) {
    elements.cloudLabel.textContent = error.message;
    setConnection('offline', error.message);
    if (!(state.protected && !state.accessToken)) showToast(error.message, true);
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
  const files = [];
  for (const entry of skill.files) {
    files.push({ path: entry.path, contentBase64: await fileToBase64(entry.file) });
  }
  return {
    schemaVersion: 1,
    skill: {
      name: skill.name,
      description: skill.description,
      platform: skill.platform,
      folderName: skill.folderName
    },
    files: files
  };
}

async function uploadSkill(index, button) {
  const skill = state.localSkills[index];
  if (!skill || skill.ownership === 'system') return;
  button.disabled = true;
  button.textContent = '正在上传';
  try {
    const result = await apiRequest('/api/skills', {
      method: 'POST',
      body: JSON.stringify(await packageLocalSkill(skill))
    });
    showToast(result.skill.name + ' 已上传');
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

async function getCloudPackage(index) {
  const skill = state.cloudSkills[index];
  if (!skill) throw new Error('云端 Skill 不存在');
  return apiRequest('/api/skills/' + encodeURIComponent(skill.id));
}

async function installSkill(index, button) {
  if (typeof window.showDirectoryPicker !== 'function') {
    showToast('当前浏览器不支持直接安装，请下载 Skill 包', true);
    return;
  }
  button.disabled = true;
  button.textContent = '等待选择目录';
  try {
    const skillPackage = await getCloudPackage(index);
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

async function downloadSkill(index, button) {
  button.disabled = true;
  try {
    const skillPackage = await getCloudPackage(index);
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

async function scanWithDirectoryPicker() {
  const root = await window.showDirectoryPicker({ mode: 'read' });
  setBusy(true, '正在扫描 ' + root.name);
  const skills = await scanDirectoryHandle(root);
  mergeLocalSkills(skills);
  const skipped = skills.reduce(function (sum, skill) { return sum + skill.skippedSensitive; }, 0);
  elements.scanLabel.textContent = root.name + ' · 找到 ' + skills.length + ' 个 Skill' +
    (skipped ? ' · 已过滤 ' + skipped + ' 个敏感文件' : '');
  render();
  showToast('扫描完成');
}

async function startScan() {
  if (state.busy) return;
  if (typeof window.showDirectoryPicker !== 'function' || !window.isSecureContext) {
    elements.directoryInput.click();
    return;
  }
  try {
    await scanWithDirectoryPicker();
  } catch (error) {
    if (error.name !== 'AbortError') showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function handleInputScan(event) {
  if (!event.target.files.length) return;
  setBusy(true, '正在扫描已选择目录');
  try {
    const skills = await scanInputFiles(event.target.files);
    mergeLocalSkills(skills);
    elements.scanLabel.textContent = '兼容模式 · 找到 ' + skills.length + ' 个 Skill';
    render();
    showToast('扫描完成；当前浏览器仅支持下载，不能直接安装');
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
    state.protected = result.protected;
    if (state.protected && !state.accessToken) {
      setConnection('', '需要访问令牌');
      elements.cloudLabel.textContent = '请输入访问令牌';
      return;
    }
    await refreshCloud();
  } catch (error) {
    setConnection('offline', '云端不可用');
    elements.cloudLabel.textContent = error.message;
  }
}

elements.scanDirectory.addEventListener('click', startScan);
elements.directoryInput.addEventListener('change', handleInputScan);
elements.refreshCloud.addEventListener('click', refreshCloud);
elements.saveToken.addEventListener('click', function () {
  state.accessToken = elements.accessToken.value.trim();
  saveSessionToken(state.accessToken);
  refreshCloud();
});
elements.accessToken.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') elements.saveToken.click();
});
elements.localSkills.addEventListener('click', function (event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.dataset.action !== 'upload') return;
  uploadSkill(Number(button.dataset.index), button);
});
elements.cloudSkills.addEventListener('click', function (event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === 'install') installSkill(index, button);
  if (button.dataset.action === 'download') downloadSkill(index, button);
});

elements.accessToken.value = state.accessToken;
render();
checkHealth();
