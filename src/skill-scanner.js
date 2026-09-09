const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.svn',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  'coverage'
]);

function normalizeText(value = '') {
  return String(value).replace(/^['"]|['"]$/g, '').trim();
}

function parseFrontmatter(content, fallbackName) {
  const result = { name: fallbackName, description: '', body: content };
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return result;

  const metadata = match[1].split(/\r?\n/);
  let currentKey = '';
  let block = [];
  const commitBlock = () => {
    if (currentKey && block.length) result[currentKey] = block.join(' ').trim();
    block = [];
  };

  for (const line of metadata) {
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (pair) {
      commitBlock();
      currentKey = pair[1];
      const value = normalizeText(pair[2]);
      if (value && value !== '|' && value !== '>') result[currentKey] = value;
      continue;
    }
    if (currentKey && /^\s+/.test(line)) block.push(line.trim());
  }
  commitBlock();
  result.body = normalized.slice(match[0].length).trim();
  result.name = normalizeText(result.name || fallbackName);
  result.description = normalizeText(result.description || '');
  return result;
}

function getDefaultRoots(homeDirectory = os.homedir()) {
  return [
    {
      id: 'codex-user',
      platform: 'codex',
      scope: '全局',
      label: 'Codex 用户技能',
      rootPath: path.join(homeDirectory, '.codex', 'skills'),
      builtin: true
    },
    {
      id: 'codex-plugins',
      platform: 'codex',
      scope: '插件',
      label: 'Codex 插件技能',
      rootPath: path.join(homeDirectory, '.codex', 'plugins', 'cache'),
      builtin: true
    },
    {
      id: 'shared-agents',
      platform: 'shared',
      scope: '全局',
      label: '共享 Agent Skills',
      rootPath: path.join(homeDirectory, '.agents', 'skills'),
      builtin: true
    },
    {
      id: 'trae-cn-user',
      platform: 'trae',
      scope: '全局',
      label: 'Trae 中文版技能',
      rootPath: path.join(homeDirectory, '.trae-cn', 'skills'),
      builtin: true
    },
    {
      id: 'trae-user',
      platform: 'trae',
      scope: '全局',
      label: 'Trae 国际版技能',
      rootPath: path.join(homeDirectory, '.trae', 'skills'),
      builtin: true
    },
    {
      id: 'trae-cli-user',
      platform: 'trae',
      scope: 'CLI',
      label: 'Trae CLI 技能',
      rootPath: path.join(homeDirectory, '.traecli', 'skills'),
      builtin: true
    }
  ];
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkForSkillFiles(rootPath, options = {}) {
  const maxDepth = options.maxDepth ?? 12;
  const files = [];
  const pending = [{ directory: rootPath, depth: 0 }];

  while (pending.length) {
    const { directory, depth } = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        files.push(path.join(directory, entry.name));
      } else if (
        entry.isDirectory() &&
        depth < maxDepth &&
        !SKIP_DIRECTORIES.has(entry.name.toLowerCase()) &&
        !entry.name.startsWith('.tmp')
      ) {
        pending.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
      }
    }
  }
  return files;
}

async function countResources(skillDirectory) {
  let fileCount = 0;
  let directoryCount = 0;
  try {
    const entries = await fs.readdir(skillDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.toLowerCase() === 'skill.md') continue;
      if (entry.isFile()) fileCount += 1;
      if (entry.isDirectory()) directoryCount += 1;
    }
  } catch {
    // 单个技能不可读时仍保留其主文件信息。
  }
  return { fileCount, directoryCount };
}

function classifySkillOwnership(skillFile, root) {
  const relativeParts = path.relative(root.rootPath, skillFile)
    .split(path.sep)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const firstDirectory = relativeParts[0] || '';
  const isCodexSystemSkill = root.id === 'codex-user' && firstDirectory === '.system';
  const isBundledPluginSkill = root.id === 'codex-plugins' && [
    'openai-bundled',
    'openai-primary-runtime'
  ].includes(firstDirectory);
  const isSystem = root.skillOwnership === 'system' || isCodexSystemSkill || isBundledPluginSkill;

  return {
    ownership: isSystem ? 'system' : 'personal',
    ownershipLabel: isSystem ? 'Codex 自带' : '个人 / 下载'
  };
}

async function readSkill(skillFile, root) {
  const stat = await fs.stat(skillFile);
  const content = await fs.readFile(skillFile, 'utf8');
  const skillDirectory = path.dirname(skillFile);
  const metadata = parseFrontmatter(content, path.basename(skillDirectory));
  const resources = await countResources(skillDirectory);
  const ownership = classifySkillOwnership(skillFile, root);
  return {
    id: Buffer.from(skillFile.toLowerCase()).toString('base64url'),
    name: metadata.name,
    description: metadata.description || '暂无描述',
    body: metadata.body,
    platform: root.platform,
    scope: root.scope || '自定义',
    source: root.label,
    rootId: root.id,
    ...ownership,
    path: skillDirectory,
    filePath: skillFile,
    modifiedAt: stat.mtime.toISOString(),
    size: stat.size,
    resourceFiles: resources.fileCount,
    resourceDirectories: resources.directoryCount,
    valid: Boolean(metadata.name && metadata.description),
    duplicate: false
  };
}

async function scanSkills(roots) {
  const availableRoots = [];
  const errors = [];
  const skillsByPath = new Map();

  for (const root of roots) {
    const exists = await pathExists(root.rootPath);
    availableRoots.push({ ...root, exists });
    if (!exists) continue;

    const files = await walkForSkillFiles(root.rootPath, { maxDepth: root.maxDepth ?? 12 });
    for (const skillFile of files) {
      const normalizedPath = path.normalize(skillFile).toLowerCase();
      if (skillsByPath.has(normalizedPath)) continue;
      try {
        skillsByPath.set(normalizedPath, await readSkill(skillFile, root));
      } catch (error) {
        errors.push({ path: skillFile, message: error.message });
      }
    }
  }

  const skills = [...skillsByPath.values()];
  const countsByName = new Map();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    countsByName.set(key, (countsByName.get(key) || 0) + 1);
  }
  for (const skill of skills) skill.duplicate = countsByName.get(skill.name.toLowerCase()) > 1;
  skills.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return {
    skills,
    roots: availableRoots,
    errors,
    scannedAt: new Date().toISOString()
  };
}

module.exports = {
  getDefaultRoots,
  parseFrontmatter,
  scanSkills,
  walkForSkillFiles
};
