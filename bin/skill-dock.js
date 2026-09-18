#!/usr/bin/env node
'use strict';

// Skill Dock 命令行入口：只读、纯本地、不联网。
// 设计原则：默认 dry-run，先把"发现了什么、会传什么、不传什么"打给用户看，
// 再让用户自己决定下一步。命令本身就承担解释与自证的职责。

const fs = require('node:fs/promises');
const path = require('node:path');

// 扫描逻辑来自共享内核，与桌面宿主（C 通道）用同一份实现，避免语义漂移。
const {
  DEFAULT_ROOTS,
  scanRoots
} = require('../src/scanner');

const CLI_VERSION = '0.1.0';

// Codex 初始技能列表的字符预算：上下文窗口未知时为 8000 字符。
// 超过这个值，Codex 会先缩短描述，再多则从列表中省略部分 Skill。
const INITIAL_LIST_BUDGET_CHARS = 8000;

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
const SCRIPT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.bash', '.zsh',
  '.ps1', '.psm1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt', '.php',
  '.pl', '.lua', '.sql', '.r'
]);

const USAGE = `Skill Dock 本地扫描（只读模式）

用法
  skill-dock scan [项目目录...]      扫描项目的 .agents/skills 与 .codex/skills
  skill-dock scan                    不指定目录时，扫描 Codex 默认的用户级目录
  skill-dock scan . --json out.json  同时把报告写成 JSON
  skill-dock scan . --include-scripts
                                     在"将上传"预演里也计入脚本类文件

参数
  --root <目录>      显式指定扫描根，可重复
  --json <文件>      把机器可读的报告写到文件
  --include-scripts  预演时把脚本类文件计入上传集合
  --no-follow-links  不跟随符号链接与 junction（回到旧行为）
  --dry-run          默认行为，显式写出不影响结果
  -h, --help         显示本帮助

符号链接
  默认跟随符号链接与 Windows junction——"把 Skill 链接进项目目录"正是 Skill Dock
  做项目级隔离的方式，不跟随就等于隔离完就失明。
  跟随不等于无记录：指向扫描根目录之外的链接会在报告里逐个列出真实目标，
  失效链接、链接成环与无权限目标都会单独告警。这些内容也能在 JSON 报告的 links 字段里查到。

安全边界
  本命令只读取本机文件，不联网，不上传任何内容，不修改任何文件。
  默认只把 .md 一类的文档文件计入"将来可上传"的集合，
  scripts/ 下的可执行代码默认排除在外。

从哪个目录运行
  要在本仓库里运行，先切到仓库根目录，或用绝对路径：
    cd /d E:\\prj-gsy\\skill-atlas && node bin\\skill-dock.js scan
    node "E:\\prj-gsy\\skill-atlas\\bin\\skill-dock.js" scan
  不带目录参数时扫描 Codex 用户级默认目录；带目录参数时只扫描该项目的
  .agents/skills 与 .codex/skills。
`;

function useColor() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function paint(text, code) {
  return useColor() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const bold = (text) => paint(text, '1');
const dim = (text) => paint(text, '2');
const green = (text) => paint(text, '32');
const yellow = (text) => paint(text, '33');
const red = (text) => paint(text, '31');

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function classifyFile(filePath) {
  const extension = path.extname(String(filePath || '')).toLocaleLowerCase('en-US');
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script';
  if (DOC_EXTENSIONS.has(extension)) return 'doc';
  return 'resource';
}

function byteLength(content) {
  if (Buffer.isBuffer(content)) return content.length;
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  return 0;
}

function parseArgs(argv) {
  const options = {
    command: '',
    targets: [],
    roots: [],
    jsonPath: '',
    includeScripts: false,
    followLinks: true,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') continue;
    if (arg === '--include-scripts') {
      options.includeScripts = true;
      continue;
    }
    if (arg === '--no-follow-links') {
      options.followLinks = false;
      continue;
    }
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root 需要一个目录参数');
      options.roots.push(value);
      index += 1;
      continue;
    }
    if (arg === '--json') {
      const value = argv[index + 1];
      if (!value) throw new Error('--json 需要一个文件路径');
      options.jsonPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);

    if (!options.command && (arg === 'scan' || arg === 'help')) {
      options.command = arg;
      continue;
    }
    options.targets.push(arg);
  }

  if (!options.command) options.command = options.help ? 'help' : 'scan';
  return options;
}

function projectRoots(projectDirectory) {
  const absolutePath = path.resolve(projectDirectory);
  return [
    {
      id: 'project-agents',
      label: '项目共享 Skill',
      displayPath: path.join(absolutePath, '.agents', 'skills'),
      absolutePath: path.join(absolutePath, '.agents', 'skills')
    },
    {
      id: 'project-codex',
      label: '项目 Codex Skill',
      displayPath: path.join(absolutePath, '.codex', 'skills'),
      absolutePath: path.join(absolutePath, '.codex', 'skills')
    }
  ];
}


// 把扫描结果整理成"每个 Skill 有几类文件"与"这次会传什么/不传什么"两份账。
function summarizeSkills(skills, options) {
  const buckets = { doc: { count: 0, bytes: 0 }, script: { count: 0, bytes: 0 }, resource: { count: 0, bytes: 0 } };
  const listed = [];

  for (const skill of skills) {
    const counts = { doc: { count: 0, bytes: 0 }, script: { count: 0, bytes: 0 }, resource: { count: 0, bytes: 0 } };

    for (const file of skill.files || []) {
      const kind = classifyFile(file.path);
      const size = byteLength(file.content);
      counts[kind].count += 1;
      counts[kind].bytes += size;
      buckets[kind].count += 1;
      buckets[kind].bytes += size;
    }

    listed.push({
      name: skill.name,
      folderName: skill.folderName,
      description: skill.description,
      source: skill.source,
      directoryPath: skill.directoryPath,
      versionHash: skill.versionHash,
      fileCount: skill.fileCount,
      sizeBytes: skill.sizeBytes,
      skippedSensitive: skill.skippedSensitive,
      counts
    });
  }

  const uploadCount = buckets.doc.count + (options.includeScripts ? buckets.script.count : 0);
  const uploadBytes = buckets.doc.bytes + (options.includeScripts ? buckets.script.bytes : 0);
  const withheldCount = buckets.script.count + buckets.resource.count - (options.includeScripts ? buckets.script.count : 0);
  const withheldBytes = buckets.script.bytes + buckets.resource.bytes - (options.includeScripts ? buckets.script.bytes : 0);

  return { buckets, listed, uploadCount, uploadBytes, withheldCount, withheldBytes };
}

function findWarnings(listed, links) {
  const warnings = [];

  const byName = new Map();
  for (const skill of listed) {
    const key = String(skill.name || skill.folderName || '').trim();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(skill);
  }
  for (const [name, group] of byName) {
    if (group.length > 1) {
      warnings.push({
        level: 'warn',
        title: `同名 Skill ${group.length} 个：${name}`,
        detail: 'Codex 不会合并同名 Skill，它们会同时出现在技能选择器里，容易误触发。建议改用工作流包隔离，或改名。'
      });
    }
  }

  const noDescription = listed.filter((skill) => {
    const value = String(skill.description || '').trim();
    return !value || value === '暂无描述';
  });
  if (noDescription.length) {
    warnings.push({
      level: 'warn',
      title: `${noDescription.length} 个 Skill 缺少 description`,
      detail: `没有描述就无法被隐式匹配，只能靠 $名称 显式调用：${noDescription.slice(0, 5).map((s) => s.name).join('、')}`
    });
  }

  const longDescription = listed.filter((skill) => String(skill.description || '').length > 300);
  if (longDescription.length) {
    warnings.push({
      level: 'info',
      title: `${longDescription.length} 个 Skill 的 description 超过 300 字`,
      detail: '描述过长时 Codex 会优先截断它。建议把触发关键词前置。'
    });
  }

  const withScripts = listed.filter((skill) => skill.counts.script.count > 0);
  if (withScripts.length) {
    warnings.push({
      level: 'info',
      title: `${withScripts.length} 个 Skill 目录内含脚本文件`,
      detail: '这些可执行代码默认不会被上传；需要随包分发时请单独确认。'
    });
  }

  // 跟随了哪些链接必须逐条可见：这是"隔离靠链接落地"的安全代价，
  // 用户得能看到每个跳出扫描根的目标究竟去了哪里。
  const outside = links.outsideRoot || [];
  if (outside.length) {
    warnings.push({
      level: 'info',
      title: `${outside.length} 个链接指向扫描根目录之外`,
      detail: `这是 Skill 隔离（软链/junction）的正常形态，但下列目标被一并读取了：${outside.slice(0, 3).map((item) => item.target).join('；')}${outside.length > 3 ? ' 等，完整清单见 JSON 报告' : ''}`
    });
  }

  const broken = links.broken || [];
  if (broken.length) {
    warnings.push({
      level: 'warn',
      title: `${broken.length} 个链接已失效（目标不存在）`,
      detail: `未计入版本哈希：${broken.slice(0, 5).map((item) => path.basename(item.linkPath)).join('、')}`
    });
  }

  const denied = links.denied || [];
  if (denied.length) {
    warnings.push({
      level: 'warn',
      title: `${denied.length} 个链接目标无法读取`,
      detail: `多因权限不足，已跳过：${denied.slice(0, 5).map((item) => path.basename(item.linkPath)).join('、')}`
    });
  }

  const cycle = links.cycle || [];
  if (cycle.length) {
    warnings.push({
      level: 'warn',
      title: `${cycle.length} 处链接成环`,
      detail: `同一次扫描里目标已被读过，为避免重复计入哈希而跳过：${cycle.slice(0, 5).map((item) => path.basename(item.linkPath)).join('、')}`
    });
  }

  const notFollowed = links.notFollowed || [];
  if (notFollowed.length) {
    warnings.push({
      level: 'info',
      title: `${notFollowed.length} 个链接未跟随（本次指定了 --no-follow-links）`,
      detail: '这些 Skill 被完全忽略。若你的 Skill 目录是用软链/junction 挂进来的，请去掉该参数重跑。'
    });
  }

  return warnings;
}

function renderReport(payload) {
  const lines = [];
  const { summary, roots, warnings, options, scope } = payload;

  lines.push('');
  lines.push(bold('Skill Dock 本地扫描报告') + dim(`  v${CLI_VERSION} · 只读模式 · 未联网`));
  lines.push(dim(`生成时间 ${payload.generatedAt}`));
  lines.push(dim(`当前目录 ${payload.cwd}｜扫描范围 ${scope === 'project' ? '指定项目' : '用户级默认目录'}`));
  lines.push('');

  lines.push(bold('扫描根'));
  for (const root of roots) {
    const followedCount = root.followedLinks || 0;
    const suffix = followedCount ? dim(`（跟随链接 ${followedCount}）`) : '';
    const statusText = root.status === 'ready'
      ? green(`✓ ${root.skillCount} 个 Skill`)
      : root.status === 'missing'
        ? dim('目录不存在')
        : red('目录无法读取');
    lines.push(`  ${statusText}${suffix}  ${root.path}`);
  }
  lines.push('');

  lines.push(bold(`Skill 清单（共 ${summary.listed.length} 个）`));
  if (!summary.listed.length) {
    lines.push(dim('  没有发现任何 Skill。'));
    if (scope === 'project') {
      lines.push(dim('  项目级扫描只看 <目录>/.agents/skills 与 <目录>/.codex/skills。'));
      lines.push(dim('  如果 Skill 装在用户级目录，请去掉目录参数再跑一次。'));
    } else {
      lines.push(dim(`  请确认当前目录是仓库根目录（${payload.cwd}），或改用绝对路径运行。`));
    }
  }
  for (const skill of summary.listed) {
    lines.push(`  · ${skill.name}  ${dim(`hash ${String(skill.versionHash || '').slice(0, 8)}`)}`);
    lines.push(`    ${dim(`来源 ${skill.source}｜${skill.fileCount} 个文件｜${formatBytes(skill.sizeBytes)}`)}`);
    if (skill.description) {
      lines.push(`    ${truncate(skill.description, 68)}`);
    }
    lines.push('');
  }

  lines.push(bold('上传预演（本次未执行）'));
  lines.push(`  将上传： ${summary.uploadCount} 个文件 · ${formatBytes(summary.uploadBytes)}${options.includeScripts ? dim('（含脚本，因显式指定 --include-scripts）') : dim('（仅文档类）')}`);
  lines.push(`  不上传： ${summary.withheldCount} 个文件 · ${formatBytes(summary.withheldBytes)}`);
  lines.push(`  分类明细： 文档 ${summary.buckets.doc.count} ｜ 脚本 ${summary.buckets.script.count} ｜ 资源 ${summary.buckets.resource.count}`);
  lines.push('');

  const budget = payload.budget;
  const budgetRatio = budget.total / INITIAL_LIST_BUDGET_CHARS;
  const budgetText = budgetRatio > 1
    ? red(`${budget.total} / ${INITIAL_LIST_BUDGET_CHARS} 字符（${(budgetRatio * 100).toFixed(0)}%）`)
    : budgetRatio > 0.7
      ? yellow(`${budget.total} / ${INITIAL_LIST_BUDGET_CHARS} 字符（${(budgetRatio * 100).toFixed(0)}%）`)
      : green(`${budget.total} / ${INITIAL_LIST_BUDGET_CHARS} 字符（${(budgetRatio * 100).toFixed(0)}%）`);
  lines.push(bold('初始技能列表预算'));
  lines.push(`  ${budgetText}`);
  lines.push(`  ${dim('Codex 启动时只加载名称与描述，列表上限约上下文窗口的 2%（未知时 8000 字符）。超过后会先缩短描述，再多则省略部分 Skill。')}`);
  lines.push('');

  if (warnings.length) {
    lines.push(bold(`需要注意（${warnings.length} 条）`));
    for (const warning of warnings) {
      const marker = warning.level === 'warn' ? yellow('!') : dim('·');
      lines.push(`  ${marker} ${warning.title}`);
      lines.push(`    ${dim(warning.detail)}`);
    }
    lines.push('');
  }

  lines.push(green('本次运行只读取了本机文件，未联网、未上传、未修改任何内容。'));
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || options.command === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const explicit = [...options.roots, ...options.targets];
  const roots = explicit.length
    ? explicit.flatMap((target) => projectRoots(target))
    : DEFAULT_ROOTS;

  const scanResult = await scanRoots({ roots, includeFiles: true, followLinks: options.followLinks });
  const summary = summarizeSkills(scanResult.skills, options);
  const warnings = findWarnings(summary.listed, scanResult.links);

  const budget = summary.listed.reduce((total, skill) => (
    total + String(skill.name || '').length + String(skill.description || '').length
  ), 0);

  const payload = {
    commandVersion: CLI_VERSION,
    generatedAt: new Date().toLocaleString('zh-CN'),
    mode: 'read-only',
    networkUsed: false,
    cwd: process.cwd(),
    scope: explicit.length ? 'project' : 'user-default',
    roots: scanResult.roots,
    skills: summary.listed,
    summary: {
      skillCount: summary.listed.length,
      listed: summary.listed,
      buckets: summary.buckets,
      uploadCount: summary.uploadCount,
      uploadBytes: summary.uploadBytes,
      withheldCount: summary.withheldCount,
      withheldBytes: summary.withheldBytes
    },
    budget: { total: budget, limit: INITIAL_LIST_BUDGET_CHARS },
    links: {
      followed: (scanResult.links.followed || []).length,
      outsideRoot: scanResult.links.outsideRoot,
      broken: scanResult.links.broken,
      cycle: scanResult.links.cycle,
      denied: scanResult.links.denied,
      notFollowed: (scanResult.links.notFollowed || []).length
    },
    warnings,
    options: { includeScripts: options.includeScripts, followLinks: options.followLinks !== false }
  };

  if (options.jsonPath) {
    const target = path.resolve(options.jsonPath);
    await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${renderReport(payload)}\n`);
  if (options.jsonPath) {
    process.stdout.write(`${dim(`报告已写入 ${path.resolve(options.jsonPath)}`)}\n\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n\n`);
  process.exitCode = 1;
});
