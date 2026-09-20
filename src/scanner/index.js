'use strict';

/**
 * 共享扫描内核 —— 无 Electron / 无 HTTP 依赖的纯 Node 模块。
 *
 * 存在的理由：此前仓库里有三套互相漂移的扫描实现
 *   - `src/web/helper/skill-packer-helper.js`（本地 HTTP 助手）
 *   - `src/web/app.js`（浏览器 File System Access，物理上无法复用本模块）
 *   - `src/web/scan/scan.js`（/scan/ 零安装页，同上）
 * 现在把 Node 侧收敛成这一份，供 B 通道 CLI 与 C 通道宿主（Electron 桌面应用）共用。
 *
 * 语义以 docs/solution.md §11.1 为准，四条不可让步约束：
 *   1. 默认跟随链接（隔离的形态就是"链接进项目目录"，不跟随等于功能自残）
 *   2. 不拒绝跳出扫描根的链接（隔离必然跳出项目目录），代价用透明度补 —— 每个外部目标进报告
 *   3. 哈希与上传一律用**逻辑路径**，不用 realpath
 *      （同一个 Skill 从不同链接位置被发现时必须得到同一个版本哈希）
 *   4. 同一个链接在一次扫描里只记一次（入口遍历与文件收集都会碰到它）
 *
 * 设计约束（供 Electron 复用）：
 *   - 不依赖 cwd / 全局可变状态；所有输入通过 options 传入，可重入
 *   - 不写任何文件、不发任何网络请求（宿主层负责落盘与上传）
 *   - 用 lstat 作为链接判据入口，不用 stat（stat 会跟随链接，junctions 上行为不一致）
 */

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SCANNER_VERSION = '1.1.0';

const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 1000;
const MAX_SCAN_DEPTH = 12;
const SKIP_DIRECTORIES = new Set([
  '.git', '.svn', 'node_modules', '__pycache__', 'dist', 'build', 'coverage'
]);

/**
 * 链接处理结果分桶。默认跟随，但"跟随了什么、跳到哪去"必须完全可见，
 * 所以每一类都留记录，不允许静默跳过（§11.1）。
 */
const LINK_BUCKETS = ['followed', 'outsideRoot', 'broken', 'cycle', 'denied', 'notFollowed'];

/**
 * 默认扫描根。
 *
 * 覆盖本机四类 Skill 来源：Codex（个人 + 插件缓存）、跨 Agent 共享、
 * WorkBuddy、豆包（内置 + 用户自定义）。缺失的根如实报 `missing`，不臆造。
 *
 * 路径基准分两种：
 *   - 默认相对用户主目录（%USERPROFILE%）：segments 直接拼在 home 下。
 *   - `base: 'localAppData'`：豆包桌面端的技能不在主目录，而在
 *     %LOCALAPPDATA%\Doubao\... 下，单独用一个基准解析。
 *
 * §7「最小授权」要求这些根是**默认候选**，调用方（桌面首启、CLI）可裁剪；
 * `required: false` 表示缺失不报错。
 */
const DEFAULT_ROOTS = [
  {
    id: 'codex-user',
    platform: 'codex',
    scope: 'user',
    label: 'Codex 个人 Skill',
    displayPath: '%USERPROFILE%\\.codex\\skills',
    segments: ['.codex', 'skills']
  },
  {
    id: 'shared-agents',
    platform: 'shared',
    scope: 'user',
    label: '跨 Agent 共享 Skill',
    displayPath: '%USERPROFILE%\\.agents\\skills',
    segments: ['.agents', 'skills']
  },
  {
    id: 'workbuddy-user',
    platform: 'workbuddy',
    scope: 'user',
    label: 'WorkBuddy 个人 Skill',
    displayPath: '%USERPROFILE%\\.workbuddy\\skills',
    segments: ['.workbuddy', 'skills']
  },
  {
    id: 'doubao-system',
    platform: 'doubao',
    scope: 'system',
    system: true,
    label: '豆包内置 Skill',
    base: 'localAppData',
    displayPath: '%LOCALAPPDATA%\\Doubao\\User Data\\Default\\.doubao\\agent_mode\\workspace\\.skills',
    segments: ['Doubao', 'User Data', 'Default', '.doubao', 'agent_mode', 'workspace', '.skills']
  },
  {
    id: 'doubao-user',
    platform: 'doubao',
    scope: 'user',
    label: '豆包用户 Skill',
    base: 'localAppData',
    displayPath: '%LOCALAPPDATA%\\Doubao\\User Data\\Default\\.doubao\\agent_mode\\workspace\\.user_skills',
    segments: ['Doubao', 'User Data', 'Default', '.doubao', 'agent_mode', 'workspace', '.user_skills']
  },
  {
    id: 'codex-plugins',
    platform: 'codex',
    scope: 'plugin',
    system: true,
    label: 'Codex 插件 Skill',
    displayPath: '%USERPROFILE%\\.codex\\plugins\\cache',
    segments: ['.codex', 'plugins', 'cache']
  }
];

/* ---------------- 元数据 ---------------- */

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 * 支持块标量（`|` 与 `>`）：值写在后续缩进行里，需要拼成一段。
 */
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

/** 凭据类文件永不入哈希、永不上传（§7 上传边界） */
function shouldSkipFile(name) {
  const lower = String(name).toLocaleLowerCase('en-US');
  return lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower === 'credentials.json';
}

/** Codex 内置运行时目录，不属于用户 Skill */
function isSystemPath(pathSegments) {
  return pathSegments.some((segment) => {
    const lower = String(segment).toLocaleLowerCase('en-US');
    return lower === '.system' || lower === 'openai-bundled' || lower === 'openai-primary-runtime';
  });
}

/** 稳定排序：不依赖 locale，避免不同机器上哈希不一致 */
function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 版本哈希：`sha256(path + \0 + content + \0)` 按 path 排序累加。
 * 一律用**逻辑路径**（用户看到的路径），不用 realpath —— 见模块头注释约束 3。
 */
function computeVersionHash(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => comparePath(a.path, b.path))) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/* ---------------- 链接处理 ---------------- */

function emptyLinkBuckets() {
  const links = {};
  for (const bucket of LINK_BUCKETS) links[bucket] = [];
  return links;
}

function summarizeLinks(links) {
  const summary = {};
  for (const bucket of LINK_BUCKETS) summary[bucket] = (links[bucket] || []).length;
  return summary;
}

function createLinkState(allowedRealRoots, followLinks) {
  const links = emptyLinkBuckets();
  return {
    followLinks: followLinks !== false,
    allowedRealRoots,
    visitedRealDirs: new Set(),
    // 入口遍历会先解析一次链接，文件收集随后还会碰到同一链接；同一个链接只应有一份结果。
    recordedLinks: new Set(),
    realpathCache: new Map(),
    links
  };
}

function recordLink(state, bucket, linkPath, target, error) {
  if (state.recordedLinks.has(linkPath)) return;
  state.recordedLinks.add(linkPath);
  state.links[bucket].push({ linkPath, target: target || '', error: error || '' });
}

/** realpath 有成本，只在链接项上调用并缓存 */
async function canonicalPath(filePath, state) {
  if (state.realpathCache.has(filePath)) return state.realpathCache.get(filePath);
  let resolved;
  try {
    resolved = await fs.realpath(filePath);
  } catch (error) {
    resolved = { error: error.code || 'EIO' };
  }
  state.realpathCache.set(filePath, resolved);
  return resolved;
}

/**
 * 判断目标是否落在任一扫描根内。
 * 不能用 startsWith —— `/project` 会把 `/project-secret` 误判成在根内。
 */
function findContainingRoot(state, targetReal) {
  return state.allowedRealRoots.find((rootReal) => {
    const relative = path.relative(rootReal, targetReal);
    if (relative === '') return true;
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }) || null;
}

async function markDirectoryVisited(directoryPath, state) {
  const resolved = await canonicalPath(directoryPath, state);
  if (typeof resolved === 'string') state.visitedRealDirs.add(resolved);
}

/**
 * 解析一个链接项，返回 'directory' | 'file'；无法安全处理时返回 null，
 * 原因已记入 state.links 的对应桶。
 */
async function resolveEntryLink(absolutePath, state) {
  if (!state.followLinks) {
    recordLink(state, 'notFollowed', absolutePath);
    return null;
  }

  const resolved = await canonicalPath(absolutePath, state);
  if (typeof resolved !== 'string') {
    recordLink(state, 'broken', absolutePath, '', resolved.error);
    return null;
  }

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    recordLink(state, 'denied', absolutePath, resolved, error.code || 'EACCES');
    return null;
  }

  if (!stat.isDirectory() && !stat.isFile()) return null;

  // 成环要先于记账：目标已经在遍历里出现过的话，这次不会真的进去，
  // 若先记成 followed，报告里的"跟随数"就会包含一个并没有跟随的链接。
  if (stat.isDirectory() && state.visitedRealDirs.has(resolved)) {
    recordLink(state, 'cycle', absolutePath, resolved);
    return null;
  }

  if (findContainingRoot(state, resolved)) {
    recordLink(state, 'followed', absolutePath, resolved);
  } else {
    // 隔离场景天然跳出扫描根（项目 -> 中央 Skill 仓库），所以这里是"记下来"而不是"拒绝"。
    recordLink(state, 'outsideRoot', absolutePath, resolved);
  }

  return stat.isDirectory() ? 'directory' : 'file';
}

/* ---------------- 遍历 ---------------- */

async function collectDirectoryFiles(directoryPath, prefix, depth, result, state) {
  if (depth > MAX_SCAN_DEPTH) return;
  const linkState = state || createLinkState([], true);
  await markDirectoryVisited(directoryPath, linkState);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((a, b) => comparePath(a.name, b.name));

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    const lowerName = entry.name.toLocaleLowerCase('en-US');
    let kind;

    if (entry.isSymbolicLink()) {
      // 目录链接包含 Windows junction：两者在 readdir 里都报 isSymbolicLink。
      kind = await resolveEntryLink(absolutePath, linkState);
      if (!kind) continue;
    } else if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(lowerName)) continue;
      kind = 'directory';
    } else if (entry.isFile()) {
      kind = 'file';
    } else {
      continue;
    }

    if (kind === 'directory') {
      await collectDirectoryFiles(absolutePath, `${prefix}${entry.name}/`, depth + 1, result, linkState);
      continue;
    }

    if (shouldSkipFile(entry.name)) {
      result.skippedSensitive += 1;
      continue;
    }
    // 哈希与上传都用逻辑路径：同一个 Skill 通过不同链接路径被发现时结果必须一致。
    let content;
    try {
      content = await fs.readFile(absolutePath);
    } catch (error) {
      recordLink(linkState, 'denied', absolutePath, '', error.code || 'EACCES');
      continue;
    }
    result.sizeBytes += content.length;
    if (result.sizeBytes > MAX_SKILL_BYTES) throw new Error('单个 Skill 不能超过 20 MB');
    result.files.push({ path: `${prefix}${entry.name}`, content });
    if (result.files.length > MAX_SKILL_FILES) throw new Error('单个 Skill 文件数不能超过 1000');
  }
}

/** 读取一个 Skill 目录，产出含版本哈希与资源统计的对象 */
async function readSkill(directoryPath, root, relativeSegments, options = {}, state) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const skillEntry = entries.find((entry) => (
    entry.isFile() && entry.name.toLocaleLowerCase('en-US') === 'skill.md'
  ));
  if (!skillEntry) return null;

  const skillFile = await fs.readFile(path.join(directoryPath, skillEntry.name), 'utf8');
  const metadata = parseFrontmatter(skillFile, path.basename(directoryPath));
  const collected = { files: [], sizeBytes: 0, skippedSensitive: 0 };
  await collectDirectoryFiles(directoryPath, '', 0, collected, state);

  let modifiedAt = null;
  try {
    const stat = await fs.stat(path.join(directoryPath, skillEntry.name));
    modifiedAt = stat.mtime.toISOString();
  } catch { /* 时间拿不到不影响扫描 */ }

  // 物理路径用于去重（链接与真实路径会指向同一目录），逻辑路径用于哈希与展示。
  // 复用 state 的 realpath 缓存，避免重复系统调用。
  let realDirectoryPath = directoryPath;
  if (state) {
    const resolved = await canonicalPath(directoryPath, state);
    if (typeof resolved === 'string') realDirectoryPath = resolved;
  } else {
    realDirectoryPath = await fs.realpath(directoryPath).catch(() => directoryPath);
  }

  const skill = {
    // 稳定标识：用逻辑目录路径。它是"这一次扫描里的这个 Skill 实例"的身份，
    // 渲染层的选中态、自定义简介的键都依赖它 —— 缺了它这些功能会静默失效。
    id: directoryPath,
    name: metadata.name,
    description: metadata.description || '暂无描述',
    folderName: path.basename(directoryPath),
    platform: root.platform || 'shared',
    scope: root.scope || 'user',
    source: root.label,
    rootId: root.id,
    scanDirectoryId: root.id,
    ownership: (root.system || root.id === 'codex-plugins' || isSystemPath(relativeSegments)) ? 'system' : 'personal',
    versionHash: computeVersionHash(collected.files),
    fileCount: collected.files.length,
    sizeBytes: collected.sizeBytes,
    skippedSensitive: collected.skippedSensitive,
    modifiedAt,
    directoryPath,
    realDirectoryPath
  };
  // 只有显式要求时才带上文件内容（上传与打包用）；默认不带，扫描结果留在内存即可。
  if (options.includeFiles) skill.files = collected.files;
  return skill;
}

async function walkForSkills(directoryPath, root, relativeSegments, depth, options, output, state) {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') return;
    throw error;
  }
  await markDirectoryVisited(directoryPath, state);

  if (entries.some((entry) => entry.isFile() && entry.name.toLocaleLowerCase('en-US') === 'skill.md')) {
    const skill = await readSkill(directoryPath, root, relativeSegments, options, state);
    if (skill) output.push(skill);
  }

  entries.sort((a, b) => comparePath(a.name, b.name));
  for (const entry of entries) {
    const lowerName = entry.name.toLocaleLowerCase('en-US');
    if (SKIP_DIRECTORIES.has(lowerName)) continue;
    if (entry.isSymbolicLink()) {
      // 隔离场景正是"整个 Skill 目录都是链接"，这里必须跟进去。
      if (await resolveEntryLink(path.join(directoryPath, entry.name), state) !== 'directory') continue;
    } else if (!entry.isDirectory()) {
      continue;
    }
    await walkForSkills(
      path.join(directoryPath, entry.name),
      root,
      relativeSegments.concat(entry.name),
      depth + 1,
      options,
      output,
      state
    );
  }
}

/* ---------------- 对外入口 ---------------- */

/**
 * 解析根的基准目录。默认用户主目录；`base: 'localAppData'` 指向
 * %LOCALAPPDATA%（豆包桌面端技能所在），取不到时退回主目录下的 AppData\Local。
 */
function resolveRootBase(base, homeDirectory) {
  if (base === 'localAppData') {
    return process.env.LOCALAPPDATA
      || path.join(homeDirectory, 'AppData', 'Local');
  }
  return homeDirectory;
}

function resolveRoots(homeDirectory, roots = DEFAULT_ROOTS) {
  return roots.map((root) => ({
    ...root,
    absolutePath: root.absolutePath
      || path.join(resolveRootBase(root.base, homeDirectory), ...(root.segments || []))
  }));
}

/**
 * 扫描一组根。可重入、无副作用、不联网、不写文件。
 *
 * @param {object} options
 * @param {string} [options.homeDirectory] 家目录，默认 os.homedir()
 * @param {Array}  [options.roots] 扫描根，默认 DEFAULT_ROOTS
 * @param {boolean}[options.followLinks=true] false 时全部记 notFollowed
 * @param {boolean}[options.includeFiles=false] 是否带上文件内容（上传/打包才需要）
 * @returns {Promise<{roots, skills, links, followLinks, scannerVersion}>}
 */
async function scanRoots(options = {}) {
  const followLinks = options.followLinks !== false;
  const homeDirectory = options.homeDirectory || os.homedir();
  const roots = resolveRoots(homeDirectory, options.roots);
  const skills = [];
  const rootResults = [];
  const links = emptyLinkBuckets();

  // 允许跨越扫描根之间互相引用：一个根里的链接指向另一个扫描根属于正常用法。
  const allowedRealRoots = [];
  for (const root of roots) {
    const resolved = await fs.realpath(root.absolutePath).catch(() => null);
    if (resolved) allowedRealRoots.push(resolved);
  }

  for (const root of roots) {
    // 每个根各自一套 visited：两个不同的根链到同一目标时，算两个 Skill 实例（作用域不同）。
    const state = createLinkState(allowedRealRoots, followLinks);
    try {
      const stat = await fs.stat(root.absolutePath);
      if (!stat.isDirectory()) throw Object.assign(new Error('不是目录'), { code: 'ENOTDIR' });
      const rootSkills = [];
      await walkForSkills(root.absolutePath, root, [], 0, options, rootSkills, state);
      skills.push(...rootSkills);
      rootResults.push({
        id: root.id,
        label: root.label,
        platform: root.platform || 'shared',
        path: root.absolutePath,
        displayPath: root.displayPath,
        status: 'ready',
        skillCount: rootSkills.length,
        followedLinks: state.links.followed.length
      });
    } catch (error) {
      const missing = error.code === 'ENOENT';
      rootResults.push({
        id: root.id,
        label: root.label,
        platform: root.platform || 'shared',
        path: root.absolutePath,
        displayPath: root.displayPath,
        status: missing ? 'missing' : 'error',
        skillCount: 0,
        followedLinks: 0,
        error: missing ? '目录不存在' : '目录无法读取'
      });
    }
    for (const bucket of LINK_BUCKETS) links[bucket].push(...state.links[bucket]);
  }

  return { roots: rootResults, skills, links, followLinks, scannerVersion: SCANNER_VERSION };
}

/**
 * 按**物理目录**去重（不做同名合并 —— Codex 同名 Skill 不合并，见 docs/solution.md §6）。
 *
 * 注意不是按逻辑路径去重：同一个目录可以同时以 `.agents/inner-link`（链接）
 * 和 `.agents/skills-real/inner`（真实路径）两种逻辑路径被发现，两者文本不同
 * 却是同一份 Skill。所以优先用扫描期已算好的 `realDirectoryPath`，
 * 拿不到时才退回逻辑路径 —— 保持同步函数签名，调用方不用改成 await。
 *
 * 版本哈希仍然用逻辑路径（约束 3），两者互不影响。
 */
function dedupeByDirectory(skills) {
  const seen = new Set();
  const output = [];
  for (const skill of skills) {
    const physical = skill.realDirectoryPath || skill.directoryPath;
    const key = path.resolve(physical).toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(skill);
  }
  return output;
}

module.exports = {
  DEFAULT_ROOTS,
  LINK_BUCKETS,
  MAX_SCAN_DEPTH,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  SCANNER_VERSION,
  SKIP_DIRECTORIES,
  collectDirectoryFiles,
  comparePath,
  computeVersionHash,
  createLinkState,
  dedupeByDirectory,
  emptyLinkBuckets,
  isSystemPath,
  parseFrontmatter,
  readSkill,
  resolveEntryLink,
  resolveRoots,
  scanRoots,
  shouldSkipFile,
  summarizeLinks,
  walkForSkills
};
