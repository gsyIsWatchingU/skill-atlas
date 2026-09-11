const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 1000;
const MAX_SCAN_DEPTH = 12;
const SKIP_DIRECTORIES = new Set(['.git', '.svn', 'node_modules', '__pycache__', 'dist', 'build', 'coverage']);

const state = {
  localSkills: [],
  cloudSkills: [],
  communitySkills: [],
  user: null,
  busy: false
};

const elements = {
  cancelLegacy: document.querySelector('#cancel-legacy'),
  claimLegacy: document.querySelector('#claim-legacy'),
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
  scanLabel: document.querySelector('#scan-label'),
  toast: document.querySelector('#toast'),
  userMenu: document.querySelector('#user-menu'),
  userName: document.querySelector('#user-name')
};

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
  const details = document.createElement('p');
  details.className = 'skill-details';
  details.textContent = skill.fileCount + ' FILES · ' + formatBytes(skill.sizeBytes || 0);

  const actions = document.createElement('div');
  actions.className = 'skill-actions';
  if (source === 'local') {
    const cloud = findCloudSkill(skill);
    const sameVersion = cloud && cloud.versionHash === skill.versionHash;
    const canUpload = skill.ownership !== 'system' && skill.files.length > 0;
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

  card.append(meta, title, description, details, actions);
  return card;
}

function render() {
  elements.localSkills.replaceChildren();
  elements.cloudSkills.replaceChildren();
  elements.communitySkills.replaceChildren();
  state.localSkills.forEach(function (skill, index) {
    elements.localSkills.append(createSkillCard(skill, 'local', index));
  });
  state.cloudSkills.forEach(function (skill, index) {
    elements.cloudSkills.append(createSkillCard(skill, 'cloud', index));
  });
  state.communitySkills.forEach(function (skill, index) {
    elements.communitySkills.append(createSkillCard(skill, 'community', index));
  });

  const different = state.cloudSkills.filter(function (skill) {
    const local = findLocalSkill(skill);
    return local && local.versionHash !== skill.versionHash;
  }).length;
  elements.localCount.textContent = String(state.localSkills.length);
  elements.cloudCount.textContent = String(state.cloudSkills.length);
  elements.communityCount.textContent = String(state.communitySkills.length);
  elements.differentCount.textContent = String(different);
  elements.localEmpty.classList.toggle('hidden', state.localSkills.length > 0);
  elements.cloudEmpty.classList.toggle('hidden', state.cloudSkills.length > 0);
  elements.communityEmpty.classList.toggle('hidden', state.communitySkills.length > 0);
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
    state.cloudSkills = [];
    if (state.user) {
      try {
        const mineResult = await apiRequest('/api/skills?scope=mine');
        state.cloudSkills = mineResult.skills || [];
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

async function uploadSkill(index, visibility, button) {
  const skill = state.localSkills[index];
  if (!state.user) {
    window.location.href = '/api/auth/login';
    return;
  }
  if (!skill || skill.ownership === 'system') return;
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

elements.scanDirectory.addEventListener('click', startScan);
elements.directoryInput.addEventListener('change', handleInputScan);
elements.refreshCloud.addEventListener('click', refreshCloud);
elements.localSkills.addEventListener('click', function (event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.dataset.action === 'login') window.location.href = '/api/auth/login';
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

render();
renderAccount();
if (new URLSearchParams(window.location.search).has('auth_error')) {
  showToast('登录未完成，请重试', true);
  window.history.replaceState({}, '', window.location.pathname);
}
checkHealth();
