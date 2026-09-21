'use strict';

/**
 * 统一技能库：把散落在各 IDE 用户技能目录里的个人 Skill，汇聚到一个中央目录，
 * 再在每个 IDE 目录里建 junction（目录链接）指回去 —— 一份物理文件，所有 IDE 都能识别。
 *
 * 「算计划」和「动文件」分开：
 *   - buildUnifyPlan 纯函数，只读扫描结果，不碰盘，可重入、可测试；
 *   - applyUnify / rollbackUnify 才真正移动文件、建 junction，并写 manifest 供回滚。
 *
 * 只处理个人技能（ownership === 'personal'）：
 *   豆包内置 .skills、Codex 插件缓存、.system 都是只读系统技能，不动。
 *
 * 重复识别分两层：
 *   1. 同名 —— 目录名 / frontmatter name 相同；
 *   2. 改名副本 —— 目录名与 frontmatter name 不同，但文件内容完全一致
 *      （仅 frontmatter 的 `name:` 行有差异）。用「内容指纹」判定：指纹相同即同一份。
 *   两组关系用并查集合成一个大组：A 与 B 同名、B 与 C 同指纹 → A、B、C 同组。
 *
 * 去重与冲突策略：
 *   - 同名内容相同 = 真重复：中央已有的那份优先当正本（不白搬），其它 IDE 里的重复副本就地换成 junction。
 *   - 改名副本 = 真重复：组内按「被更多根使用 > 修改时间最新 > 字典序」选一个正本名，
 *     跨根的副本换成 junction（保留原目录名，指向中央正本），同一根内的副本进备份并换成 junction，可回滚。
 *   - 同名内容不同 = 真冲突：默认整组阻断；只有用户在预览中明确选择正本后，
 *     才会先备份其它版本，再逐项替换为指向所选正本的链接。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CENTRAL_ROOT_ID, DEFAULT_ROOTS } = require('./ide-adapters');

const LINK_TARGET_ROOT_IDS = DEFAULT_ROOTS.filter((root) => root.unifyTarget).map((root) => root.id);
const BACKUP_DIRNAME = '.unify-backup';

// 与 src/scanner/index.js 的 SKIP_DIRECTORIES 保持一致：指纹遍历不进入这些目录。
const FINGERPRINT_SKIP_DIRS = new Set([
  '.git', '.svn', 'node_modules', '__pycache__', 'dist', 'build', 'coverage'
]);

/** childPath 是否落在 parentPath 之内（大小写不敏感） */
function isUnder(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isInsideOrEqual(childPath, parentPath) {
  return path.resolve(childPath) === path.resolve(parentPath) || isUnder(childPath, parentPath);
}

/** 回滚前验证 manifest 内每个路径，防止被篡改的记录越出受管 Skill 根。 */
function validateUnifyManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('统一 manifest 格式无效');
  const centralDir = path.resolve(String(options.centralDir || ''));
  const manifestCentral = path.resolve(String(manifest.centralDir || ''));
  if (!centralDir || manifestCentral !== centralDir) throw new Error('统一 manifest 的中央目录不匹配');

  const backupBase = path.join(centralDir, BACKUP_DIRNAME);
  const backupRoot = path.resolve(String(manifest.backupRoot || ''));
  if (!isUnder(backupRoot, backupBase)) throw new Error('统一 manifest 的备份目录越界');
  if (options.manifestPath && path.resolve(options.manifestPath) !== path.join(backupRoot, 'manifest.json')) {
    throw new Error('统一 manifest 文件位置与记录不匹配');
  }

  const targetRoots = (options.targetRoots || []).map((root) => path.resolve(root));
  const assertTargetPath = (value, label) => {
    const full = path.resolve(String(value || ''));
    if (!targetRoots.some((root) => isUnder(full, root))) throw new Error(`${label} 越出 IDE Skill 根`);
  };
  const assertCentralData = (value, label) => {
    const full = path.resolve(String(value || ''));
    if (!isUnder(full, centralDir) || isInsideOrEqual(full, backupBase)) throw new Error(`${label} 越出中央 Skill 根`);
  };
  const assertBackupPath = (value, label) => {
    if (!isUnder(path.resolve(String(value || '')), backupRoot)) throw new Error(`${label} 越出本次备份目录`);
  };

  for (const entry of manifest.junctioned || []) {
    assertTargetPath(entry.linkPath, '链接路径');
    assertCentralData(entry.target, '链接目标');
  }
  for (const entry of manifest.moved || []) {
    assertTargetPath(entry.from, '移动源路径');
    assertCentralData(entry.to, '移动目标路径');
  }
  for (const entry of manifest.backedUp || []) {
    assertCentralData(entry.from, '中央备份源路径');
    assertBackupPath(entry.to, '中央备份目标路径');
  }
  for (const entry of manifest.removedDuplicates || []) {
    assertTargetPath(entry.from, '副本备份源路径');
    assertBackupPath(entry.to, '副本备份目标路径');
  }
  return true;
}

function modifiedTime(skill) {
  return new Date(skill.modifiedAt || 0).getTime();
}

/** 比较两个 Skill 的修改时间：新者返回正数；时间相同按平台字典序稳定排序 */
function compareModified(left, right) {
  const diff = modifiedTime(left) - modifiedTime(right);
  if (diff !== 0) return diff;
  return String(left.platform).localeCompare(String(right.platform));
}

function normalizeSkillName(name) {
  return String(name || '').trim().toLocaleLowerCase('en-US');
}

/** 渲染层只回传这个不含路径的稳定候选编号，主进程不接受任意文件路径。 */
function skillCandidateId(skill) {
  return createHash('sha256')
    .update(`${skill.rootId || ''}\0${skill.directoryPath || ''}\0${skill.versionHash || ''}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/* ---------------- 内容指纹（改名副本识别） ---------------- */

/**
 * 剥掉 SKILL.md frontmatter 里的 name 行（归一化为固定占位）。
 * 只处理文件开头由 `---` 围起来的 frontmatter 区，正文里的 name: 不动。
 * 用途：两个目录"内容完全一致、只有技能名不同"应视为同一份（改名副本）。
 */
function normalizeFrontmatterName(content) {
  const lines = String(content).split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return String(content);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return String(content);
  for (let i = 1; i < end; i += 1) {
    if (/^name\s*:/i.test(lines[i])) lines[i] = 'name: __skill_name__';
  }
  return lines.join('\n');
}

/**
 * 内容指纹（纯函数）：sha256(相对路径 + '\0' + 内容 + '\0') 按路径排序累加。
 * 与版本哈希（versionHash）的差别：SKILL.md 的 frontmatter name 行先归一化，
 * 因此"改名副本"（目录名、技能名不同，文件内容一致）会得到相同指纹。
 * 目录结构或任何非 name 内容不同 → 指纹不同，不会被误合并。
 */
function computeContentFingerprint(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    const content = path.basename(file.path).toLocaleLowerCase('en-US') === 'skill.md'
      ? normalizeFrontmatterName(file.content)
      : file.content;
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 读一个 Skill 目录的所有文件（相对路径 + 内容），用于算内容指纹。读不到/含链接时返回 null（保守）。 */
async function readSkillFiles(directoryPath) {
  const files = [];
  async function walk(relativePath) {
    const absolutePath = path.join(directoryPath, relativePath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true }).catch(() => null);
    if (!entries) return false; // 权限/不存在：调用方放弃该 skill
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false; // 链接目录保守跳过
      const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (FINGERPRINT_SKIP_DIRS.has(entry.name)) continue;
        if (!(await walk(childRel))) return false;
      } else if (entry.isFile()) {
        const content = await fs.readFile(path.join(directoryPath, ...childRel.split('/')));
        files.push({ path: childRel, content });
      }
    }
    return true;
  }
  const ok = await walk('');
  return ok ? files : null;
}

/**
 * 给扫描结果里的每个个人 Skill 补上 contentFingerprint（读盘、async）。
 * 只处理 personal：系统内置与插件缓存是只读的，不需要也不应该参与改名副本判定。
 * 返回新的 scanResult，不改原对象。
 */
async function enrichWithFingerprints(scanResult) {
  const skills = await Promise.all((scanResult.skills || []).map(async (skill) => {
    if (skill.ownership === 'system') return skill;
    const dirPath = skill.realDirectoryPath || skill.directoryPath;
    if (!dirPath) return skill;
    const files = await readSkillFiles(dirPath);
    if (!files || !files.length) return skill;
    return { ...skill, contentFingerprint: computeContentFingerprint(files) };
  }));
  return { ...scanResult, skills };
}

/* ---------------- 分组 ---------------- */

/**
 * 组内正本名：被更多根使用的名字优先（用户依赖更广），
 * 平局取修改时间最新成员的名字，再平局按字典序（确定性，可复现）。
 */
function pickCanonicalName(group) {
  const byName = new Map();
  for (const skill of group) {
    let entry = byName.get(skill.name);
    if (!entry) {
      entry = { roots: new Set(), latest: null };
      byName.set(skill.name, entry);
    }
    entry.roots.add(skill.rootId);
    if (!entry.latest || compareModified(skill, entry.latest) > 0) entry.latest = skill;
  }
  const ranked = [...byName.entries()].sort((a, b) => (
    (b[1].roots.size - a[1].roots.size)
    || compareModified(b[1].latest, a[1].latest)
    || String(a[0]).localeCompare(String(b[0]))
  ));
  return ranked[0][0];
}

/**
 * 组内正本：canonicalName 名下的成员里选。
 * 中央已有一份且（无冲突，或与最新内容相同）→ 优先中央那份（不白搬）；
 * 否则取修改时间最新。
 * 返回 { canonical, centralAction: 'keep' | 'move-to-central', conflict }。
 */
function pickCanonicalMember(group, canonicalName, centralDir, selectedCandidateId) {
  const named = group.filter((skill) => skill.name === canonicalName);
  const centralMember = named.find((skill) => isUnder(
    skill.realDirectoryPath || skill.directoryPath,
    centralDir
  ));
  const hashes = new Set(named.map((skill) => skill.versionHash));
  const conflict = hashes.size > 1;
  const newest = [...named].sort(compareModified)[named.length - 1];

  let canonical = newest;
  let centralAction = 'move-to-central';
  let conflictResolved = !conflict;

  if (conflict && selectedCandidateId) {
    const selected = named.find((skill) => skillCandidateId(skill) === selectedCandidateId);
    if (!selected) throw new Error(`冲突选择已失效：${canonicalName}`);
    const selectedCentral = named.find((skill) => (
      isUnder(skill.realDirectoryPath || skill.directoryPath, centralDir)
      && skill.versionHash === selected.versionHash
    ));
    canonical = selectedCentral || selected;
    centralAction = isUnder(canonical.realDirectoryPath || canonical.directoryPath, centralDir)
      ? 'keep'
      : 'move-to-central';
    conflictResolved = true;
    return { canonical, centralAction, conflict, conflictResolved };
  }

  if (conflict) {
    canonical = centralMember || newest;
    return { canonical, centralAction: 'blocked-conflict', conflict, conflictResolved: false };
  }

  if (centralMember && !conflict) {
    canonical = centralMember;
    centralAction = 'keep';
  }
  return { canonical, centralAction, conflict, conflictResolved };
}

/** 每个目标根的动作：正本原位换链接 / 同名副本备份换链接 / 改名副本备份换链接 / 同名分叉保留 / 建新链接 */
function buildLinks(group, canonical, canonicalName, centralDir, targetRoots, conflictResolved) {
  const canonicalPath = canonical.realDirectoryPath || canonical.directoryPath;
  const centralPath = path.join(centralDir, canonicalName);

  const membersByRoot = new Map();
  for (const skill of group) {
    if (!membersByRoot.has(skill.rootId)) membersByRoot.set(skill.rootId, []);
    membersByRoot.get(skill.rootId).push(skill);
  }

  const links = [];
  for (const root of targetRoots) {
    if (root.path === centralDir) continue;
    const members = membersByRoot.get(root.id) || [];
    if (!members.length) {
      links.push({
        rootId: root.id,
        platform: root.platform,
        linkPath: path.join(root.path, canonicalName),
        target: centralPath,
        action: 'create-junction'
      });
      continue;
    }
    for (const member of members) {
      const linkPath = path.join(root.path, member.name);
      if ((member.realDirectoryPath || member.directoryPath) === canonicalPath) {
        // 正本从这里搬走，原位换链接指回中央
        links.push({ rootId: root.id, platform: root.platform, linkPath, target: centralPath, action: 'replace-with-junction' });
      } else if (member.name === canonicalName) {
        links.push(member.versionHash === canonical.versionHash
          ? { rootId: root.id, platform: root.platform, linkPath, target: centralPath, action: 'replace-duplicate' }
          : (conflictResolved
            ? { rootId: root.id, platform: root.platform, linkPath, target: centralPath, action: 'replace-conflict' }
            : { rootId: root.id, platform: root.platform, linkPath, target: centralPath, action: 'skip-conflict', reason: '同名但内容不同，等待选择' }));
      } else if (member.contentFingerprint && member.contentFingerprint === canonical.contentFingerprint) {
        // 改名副本：内容与正本一致，保留原目录名换成链接
        links.push({ rootId: root.id, platform: root.platform, linkPath, target: centralPath, action: 'replace-renamed' });
      } else {
        links.push({ rootId: root.id, platform: root.platform, linkPath, target: centralPath, action: 'skip-local', reason: '异名但内容分叉' });
      }
    }
  }
  return links;
}

/* ---------------- 计划构建 ---------------- */

/**
 * 构建统一计划（纯函数）。
 * scanResult.skills 里的 Skill 若带 contentFingerprint（见 enrichWithFingerprints），
 * 会把"改名副本"（同内容不同名）也并入统一；不带则退化为只按同名分组。
 */
function buildUnifyPlan(scanResult, options = {}) {
  const centralRootId = options.centralRootId || CENTRAL_ROOT_ID;
  const roots = scanResult.roots || [];
  const centralRoot = roots.find((root) => root.id === centralRootId);
  if (!centralRoot) throw new Error(`找不到中央根：${centralRootId}`);
  const centralDir = centralRoot.path;

  // 只向本机真实存在、adapter 明确允许写入的个人目录建链；不为未安装 IDE 臆造目录。
  const targetRoots = roots.filter((root) => (
    (root.unifyTarget === true || (root.unifyTarget === undefined && LINK_TARGET_ROOT_IDS.includes(root.id)))
    && root.unifyEligible !== false
    && root.status !== 'missing'
    && root.status !== 'error'
  ));

  const personal = (scanResult.skills || []).filter((skill) => (
    skill.ownership !== 'system' && skill.unifyEligible !== false
  ));

  // 同名 OR 同指纹 → 并查集合并成组
  const byName = new Map();
  const byFingerprint = new Map();
  personal.forEach((skill, index) => {
    const nameKey = normalizeSkillName(skill.name);
    if (nameKey) {
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(index);
    }
    if (skill.contentFingerprint) {
      if (!byFingerprint.has(skill.contentFingerprint)) byFingerprint.set(skill.contentFingerprint, []);
      byFingerprint.get(skill.contentFingerprint).push(index);
    }
  });

  const parent = personal.map((_skill, index) => index);
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
  for (const members of byName.values()) {
    for (let i = 1; i < members.length; i += 1) union(members[0], members[i]);
  }
  for (const members of byFingerprint.values()) {
    for (let i = 1; i < members.length; i += 1) union(members[0], members[i]);
  }

  const buckets = new Map();
  personal.forEach((skill, index) => {
    const root = find(index);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(skill);
  });

  const items = [];
  for (const group of buckets.values()) {
    const canonicalName = pickCanonicalName(group);
    const groupId = normalizeSkillName(canonicalName);
    const selectedCandidateId = options.conflictChoices && options.conflictChoices[groupId];
    const { canonical, centralAction, conflict, conflictResolved } = pickCanonicalMember(
      group,
      canonicalName,
      centralDir,
      selectedCandidateId
    );
    const canonicalPath = canonical.realDirectoryPath || canonical.directoryPath;
    const centralPath = path.join(centralDir, canonicalName);
    const links = conflictResolved
      ? buildLinks(group, canonical, canonicalName, centralDir, targetRoots, conflictResolved)
      : [];

    const superseded = group
      .filter((skill) => skill !== canonical)
      .map((skill) => ({
        name: skill.name,
        rootId: skill.rootId,
        platform: skill.platform,
        sourcePath: skill.realDirectoryPath || skill.directoryPath,
        modifiedAt: skill.modifiedAt,
        reason: skill.name === canonicalName
          ? (skill.versionHash === canonical.versionHash
            ? '与正本内容相同的同名副本'
            : '同名但内容不同，保留更新的版本')
          : (skill.contentFingerprint && skill.contentFingerprint === canonical.contentFingerprint
            ? '与正本内容相同的改名副本'
            : '异名但内容分叉，保留本地')
      }));

    items.push({
      groupId,
      name: canonicalName,
      conflict,
      conflictResolved,
      blocked: conflict && !conflictResolved,
      candidates: group
        .filter((skill) => skill.name === canonicalName)
        .map((skill) => ({
          id: skillCandidateId(skill),
          rootId: skill.rootId,
          platform: skill.platform,
          source: skill.source,
          directoryPath: skill.directoryPath,
          versionHash: skill.versionHash,
          fileCount: skill.fileCount,
          modifiedAt: skill.modifiedAt
        })),
      canonical: {
        rootId: canonical.rootId,
        platform: canonical.platform,
        sourcePath: canonicalPath,
        modifiedAt: canonical.modifiedAt
      },
      centralAction,
      centralPath,
      links,
      superseded
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));

  const count = (pred) => items.reduce((n, item) => n + item.links.filter(pred).length, 0);
  const summary = {
    names: items.length,
    moves: items.filter((item) => item.centralAction === 'move-to-central').length,
    keepInCentral: items.filter((item) => item.centralAction === 'keep').length,
    conflicts: items.filter((item) => item.conflict).length,
    unresolvedConflicts: items.filter((item) => item.blocked).length,
    createJunctions: count((l) => l.action === 'create-junction'),
    replaceWithJunction: count((l) => l.action === 'replace-with-junction'),
    replaceDuplicates: count((l) => l.action === 'replace-duplicate'),
    replaceRenamed: count((l) => l.action === 'replace-renamed'),
    replaceConflicts: count((l) => l.action === 'replace-conflict'),
    skipLocal: count((l) => l.action === 'skip-local')
  };

  return {
    centralDir,
    targetRoots: targetRoots.map((r) => ({
      id: r.id,
      platform: r.platform,
      adapterName: r.adapterName,
      path: r.path,
      linkVerified: r.linkVerified === true
    })),
    items,
    summary
  };
}

async function dirExists(dirPath) {
  try {
    const stat = await fs.lstat(dirPath);
    return stat.isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function entryExists(entryPath) {
  try {
    await fs.lstat(entryPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** rename 跨盘时降级为 copy + 删除源目录。 */
async function moveDirectory(from, to) {
  try {
    await fs.rename(from, to);
    return 'rename';
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
  }
  await fs.cp(from, to, { recursive: true, force: false, errorOnExist: true, dereference: false });
  await fs.rm(from, { recursive: true, force: false });
  return 'copy-remove';
}

/** 建 junction（Windows 目录链接，普通权限即可）。父目录缺失时先创建。 */
async function makeJunction(linkPath, target) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath, 'junction');
}

/**
 * 执行统一。返回 { manifest, manifestPath }。仅在 --apply 调用。
 */
async function applyUnify(plan) {
  const executableItems = plan.items.filter((item) => !item.blocked);
  if (!executableItems.length) throw new Error('没有可执行项；请先处理同名冲突');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(plan.centralDir, BACKUP_DIRNAME, timestamp);
  await fs.mkdir(backupRoot, { recursive: true });

  const manifest = {
    version: 2,
    status: 'started',
    timestamp,
    centralDir: plan.centralDir,
    backupRoot,
    moved: [],
    junctioned: [],
    removedDuplicates: [],
    backedUp: [],
    error: null
  };

  const manifestPath = path.join(backupRoot, 'manifest.json');
  const persistManifest = () => fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await persistManifest();

  try {
    for (const item of executableItems) {
    // 1) 正本进中央
    if (item.centralAction === 'move-to-central') {
      if (await dirExists(item.centralPath)) {
        const backupPath = path.join(backupRoot, 'central-conflict', item.name);
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        const method = await moveDirectory(item.centralPath, backupPath);
        manifest.backedUp.push({ from: item.centralPath, to: backupPath });
        manifest.backedUp[manifest.backedUp.length - 1].method = method;
        await persistManifest();
      }
      await fs.mkdir(path.dirname(item.centralPath), { recursive: true });
      const method = await moveDirectory(item.canonical.sourcePath, item.centralPath);
      manifest.moved.push({ from: item.canonical.sourcePath, to: item.centralPath, method });
      await persistManifest();
    }

    // 2) 各 IDE 目录建/替换 junction
    for (const link of item.links) {
      if (link.action === 'create-junction') {
        if (await entryExists(link.linkPath)) continue;
        await makeJunction(link.linkPath, link.target);
        manifest.junctioned.push({ linkPath: link.linkPath, target: link.target });
        await persistManifest();
      } else if (link.action === 'replace-with-junction') {
        // 正本已搬走，原位建链接；若竞态下仍存在且非链接，保留不覆盖
        if (!(await entryExists(link.linkPath))) {
          await makeJunction(link.linkPath, link.target);
          manifest.junctioned.push({ linkPath: link.linkPath, target: link.target });
          await persistManifest();
        }
      } else if (link.action === 'replace-duplicate' || link.action === 'replace-renamed' || link.action === 'replace-conflict') {
        // 内容与正本相同的重复副本（同名 / 改名）：挪进备份（不直接删），原位换成链接；回滚可还原。
        const stat = await fs.lstat(link.linkPath).catch(() => null);
        if (stat && stat.isDirectory() && !stat.isSymbolicLink()) {
          const backupPath = path.join(
            backupRoot,
            'removed-duplicates',
            link.rootId,
            item.name,
            path.basename(link.linkPath)
          );
          await fs.mkdir(path.dirname(backupPath), { recursive: true });
          const method = await moveDirectory(link.linkPath, backupPath);
          manifest.removedDuplicates.push({
            from: link.linkPath,
            to: backupPath,
            reason: link.action === 'replace-renamed'
              ? 'renamed'
              : link.action === 'replace-conflict' ? 'resolved-conflict' : 'same-name',
            method
          });
          await persistManifest();
          await makeJunction(link.linkPath, link.target);
          manifest.junctioned.push({ linkPath: link.linkPath, target: link.target });
          await persistManifest();
        }
      }
      // skip-local：保留本地分叉旧版，不动。
    }
    }
    manifest.status = 'completed';
    await persistManifest();
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = String(error && error.message ? error.message : error);
    await persistManifest().catch(() => {});
    error.message = `${error.message}（恢复记录：${manifestPath}）`;
    throw error;
  }
  return { manifest, manifestPath };
}

/** 按 manifest 回滚。 */
async function rollbackUnify(manifest) {
  // 先删建的 junction
  for (const entry of [...(manifest.junctioned || [])].reverse()) {
    try {
      const stat = await fs.lstat(entry.linkPath);
      if (!stat.isSymbolicLink()) throw new Error(`回滚停止：入口已不是链接 ${entry.linkPath}`);
      await fs.rm(entry.linkPath, { recursive: false, force: false });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // 先把搬进中央的正本搬回原位（腾出中央路径），再把中央旧版备份搬回。
  for (const entry of [...(manifest.moved || [])].reverse()) {
    await moveDirectory(entry.to, entry.from);
  }
  for (const entry of [...(manifest.backedUp || [])].reverse()) {
    await moveDirectory(entry.to, entry.from);
  }
  // 被替换成链接的重复副本，从备份搬回原位。
  for (const entry of [...(manifest.removedDuplicates || [])].reverse()) {
    await moveDirectory(entry.to, entry.from);
  }
  await fs.rm(manifest.backupRoot, { recursive: true, force: true }).catch(() => {});
  // 备份父目录若已清空则一并移除（还有其它时间戳备份时非空，删除失败会被忽略）
  await fs.rmdir(path.dirname(manifest.backupRoot)).catch(() => {});
}

module.exports = {
  BACKUP_DIRNAME,
  CENTRAL_ROOT_ID,
  LINK_TARGET_ROOT_IDS,
  applyUnify,
  buildUnifyPlan,
  computeContentFingerprint,
  enrichWithFingerprints,
  normalizeFrontmatterName,
  skillCandidateId,
  validateUnifyManifest,
  rollbackUnify
};
