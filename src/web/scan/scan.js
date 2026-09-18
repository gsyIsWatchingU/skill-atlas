'use strict';

(function () {
  const PROJECT_SUBDIRECTORIES = ['.agents/skills', '.codex/skills'];
  const SKIP_DIRECTORIES = new Set(['.git', '.svn', 'node_modules', '__pycache__', 'dist', 'build', 'coverage']);
  const SKIP_FILES = new Set(['.env', 'credentials.json']);
  const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
  const SCRIPT_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.sh', '.bash', '.zsh',
    '.ps1', '.psm1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt', '.php',
    '.pl', '.lua', '.sql', '.r'
  ]);
  const MAX_DEPTH = 10;
  const BUDGET_CHARS = 8000;

  function classify(name) {
    const dot = name.lastIndexOf('.');
    const extension = dot === -1 ? '' : name.slice(dot).toLowerCase();
    if (SCRIPT_EXTENSIONS.has(extension)) return 'script';
    if (DOC_EXTENSIONS.has(extension)) return 'doc';
    return 'resource';
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function parseFrontmatter(text, fallbackName) {
    const result = { name: fallbackName, description: '' };
    const normalized = String(text || '').replace(/^\uFEFF/, '');
    const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!match) return result;
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^(name|description):\s*(.*)$/i);
      if (!pair) continue;
      const value = pair[2].replace(/^['"]|['"]$/g, '').trim();
      if (!value) continue;
      if (pair[1].toLowerCase() === 'name') result.name = value;
      if (pair[1].toLowerCase() === 'description') result.description = value;
    }
    return result;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async function listChildren(directoryHandle) {
    const entries = [];
    for await (const handle of directoryHandle.values()) entries.push(handle);
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return entries;
  }

  async function getSubdirectory(directoryHandle, relativePath) {
    let current = directoryHandle;
    for (const segment of relativePath.split('/')) {
      try {
        current = await current.getDirectoryHandle(segment);
      } catch {
        return null;
      }
    }
    return current;
  }

  async function collectFiles(directoryHandle, prefix, depth, result) {
    if (depth > MAX_DEPTH) return;
    const entries = await listChildren(directoryHandle);

    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (entry.kind === 'directory') {
        if (SKIP_DIRECTORIES.has(lower)) continue;
        await collectFiles(entry, `${prefix}${entry.name}/`, depth + 1, result);
        continue;
      }
      if (SKIP_FILES.has(lower) || lower.endsWith('.pem') || lower.endsWith('.key')) continue;
      const file = await entry.getFile();
      const kind = classify(entry.name);
      result.files.push({ path: `${prefix}${entry.name}`, bytes: file.size, kind });
      result.buckets[kind].count += 1;
      result.buckets[kind].bytes += file.size;
    }
  }

  async function findSkills(directoryHandle, prefix, depth, output) {
    if (depth > MAX_DEPTH) return;
    const entries = await listChildren(directoryHandle);
    const skillFile = entries.find((entry) => entry.kind === 'file' && entry.name.toLowerCase() === 'skill.md');

    if (skillFile) {
      const text = await (await skillFile.getFile()).text();
      const metadata = parseFrontmatter(text, directoryHandle.name);
      const collected = {
        files: [],
        buckets: {
          doc: { count: 0, bytes: 0 },
          script: { count: 0, bytes: 0 },
          resource: { count: 0, bytes: 0 }
        }
      };
      await collectFiles(directoryHandle, '', 0, collected);
      output.push({
        name: metadata.name || directoryHandle.name,
        folderName: directoryHandle.name,
        description: metadata.description,
        location: prefix,
        files: collected.files,
        buckets: collected.buckets
      });
      return;
    }

    for (const entry of entries) {
      if (entry.kind !== 'directory') continue;
      if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      await findSkills(entry, `${prefix}${entry.name}/`, depth + 1, output);
    }
  }

  function buildWarnings(skills) {
    const warnings = [];

    const groups = new Map();
    for (const skill of skills) {
      const key = skill.name.trim();
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    for (const [name, count] of groups) {
      if (count > 1) {
        warnings.push({
          level: 'warn',
          title: `同名 Skill ${count} 个：${name}`,
          detail: 'Codex 不会合并同名 Skill，它们会同时出现在选择器里，容易误触发。'
        });
      }
    }

    const missing = skills.filter((skill) => !String(skill.description || '').trim());
    if (missing.length) {
      warnings.push({
        level: 'warn',
        title: `${missing.length} 个 Skill 缺少 description`,
        detail: `没有描述就无法被隐式匹配，只能靠 $名称 显式调用：${missing.slice(0, 5).map((item) => item.name).join('、')}`
      });
    }

    const tooLong = skills.filter((skill) => String(skill.description || '').length > 300);
    if (tooLong.length) {
      warnings.push({
        level: 'info',
        title: `${tooLong.length} 个 Skill 的 description 超过 300 字`,
        detail: '描述过长时 Codex 会优先截断它。建议把触发关键词前置。'
      });
    }

    const withScripts = skills.filter((skill) => skill.buckets.script.count > 0);
    if (withScripts.length) {
      warnings.push({
        level: 'info',
        title: `${withScripts.length} 个 Skill 目录内含脚本文件`,
        detail: '这些可执行代码不会被上传，本页也没有上传能力。'
      });
    }

    return warnings;
  }

  function renderReport(scopeLabel, roots, skills) {
    const lines = [];
    const totals = {
      doc: { count: 0, bytes: 0 },
      script: { count: 0, bytes: 0 },
      resource: { count: 0, bytes: 0 }
    };
    let budget = 0;

    for (const skill of skills) {
      for (const kind of ['doc', 'script', 'resource']) {
        totals[kind].count += skill.buckets[kind].count;
        totals[kind].bytes += skill.buckets[kind].bytes;
      }
      budget += skill.name.length + String(skill.description || '').length;
    }

    const ratio = budget / BUDGET_CHARS;
    const budgetClass = ratio > 1 ? 't-bad' : ratio > 0.7 ? 't-warn' : 't-ok';

    lines.push('<span class="t-dim">范围 ' + escapeHtml(scopeLabel) + '｜分析全程在本机完成，未联网</span>');
    lines.push('');
    lines.push('<span class="t-strong">扫描根</span>');
    for (const root of roots) {
      lines.push(root.found
        ? `  <span class="t-ok">✓ ${root.skillCount} 个 Skill</span>  ${escapeHtml(root.label)}`
        : `  <span class="t-dim">目录不存在</span>  ${escapeHtml(root.label)}`);
    }
    lines.push('');

    lines.push(`<span class="t-strong">Skill 清单（共 ${skills.length} 个）</span>`);
    if (!skills.length) {
      lines.push('  <span class="t-dim">· 没有发现任何 Skill。</span>');
    }
    for (const skill of skills) {
      const fileCount = skill.files.length;
      const size = skill.files.reduce((sum, file) => sum + file.bytes, 0);
      lines.push(`  · ${escapeHtml(skill.name)}  <span class="t-dim">${escapeHtml(skill.location || '.')}</span>`);
      lines.push(`    <span class="t-dim">${fileCount} 个文件｜${formatBytes(size)}</span>`);
      if (skill.description) {
        const text = String(skill.description).replace(/\s+/g, ' ').trim();
        lines.push(`    <span class="t-dim">${escapeHtml(text.length > 68 ? `${text.slice(0, 67)}…` : text)}</span>`);
      }
      lines.push('');
    }

    lines.push('<span class="t-strong">上传预演（本页没有上传能力）</span>');
    lines.push(`  将上传： ${totals.doc.count} 个文件 · ${formatBytes(totals.doc.bytes)}<span class="t-dim">（仅文档类）</span>`);
    lines.push(`  不上传： ${totals.script.count + totals.resource.count} 个文件 · ${formatBytes(totals.script.bytes + totals.resource.bytes)}`);
    lines.push(`  分类明细： 文档 ${totals.doc.count} ｜ 脚本 ${totals.script.count} ｜ 资源 ${totals.resource.count}`);
    lines.push('');

    lines.push('<span class="t-strong">初始技能列表预算</span>');
    lines.push(`  <span class="${budgetClass}">${budget} / ${BUDGET_CHARS} 字符（${(ratio * 100).toFixed(0)}%）</span>`);
    lines.push('  <span class="t-dim">Codex 启动时只加载名称与描述，列表上限约上下文窗口的 2%（未知时 8000 字符）。超过后会先缩短描述，再多则省略部分 Skill。</span>');
    lines.push('');

    const warnings = buildWarnings(skills);
    if (warnings.length) {
      lines.push(`<span class="t-strong">需要注意（${warnings.length} 条）</span>`);
      for (const warning of warnings) {
        const marker = warning.level === 'warn' ? '<span class="t-warn">!</span>' : '<span class="t-dim">·</span>';
        lines.push(`  ${marker} ${escapeHtml(warning.title)}`);
        lines.push(`    <span class="t-dim">${escapeHtml(warning.detail)}</span>`);
      }
      lines.push('');
    }

    lines.push('<span class="t-ok">分析已结束。没有文件被写入，也没有数据离开这台设备。</span>');
    return lines.join('\n');
  }

  function setStatus(element, message, isError) {
    element.textContent = message;
    element.classList.toggle('error', Boolean(isError));
    element.hidden = false;
  }

  async function analyze(directoryHandle, mode) {
    const status = document.getElementById('local-status');
    const output = document.getElementById('local-report');
    const roots = [];

    if (mode === 'project') {
      for (const relativePath of PROJECT_SUBDIRECTORIES) {
        const handle = await getSubdirectory(directoryHandle, relativePath);
        const found = [];
        if (handle) await findSkills(handle, '', 0, found);
        roots.push({ label: `${directoryHandle.name}/${relativePath}`, found: Boolean(handle), skillCount: found.length });
        roots[roots.length - 1].skills = found;
      }
    } else {
      const found = [];
      await findSkills(directoryHandle, '', 0, found);
      roots.push({ label: directoryHandle.name, found: true, skillCount: found.length, skills: found });
    }

    const skills = roots.flatMap((root) => root.skills || []);
    const scopeLabel = mode === 'project' ? `项目 ${directoryHandle.name}` : `目录 ${directoryHandle.name}`;

    setStatus(status, `已读取 ${skills.length} 个 Skill。分析完成，没有数据离开这台设备。`, false);
    output.innerHTML = renderReport(scopeLabel, roots, skills);
    output.hidden = false;
    output.scrollIntoView({ block: 'nearest' });
  }

  async function pickDirectory(mode) {
    const status = document.getElementById('local-status');
    const output = document.getElementById('local-report');
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      setStatus(status, '正在本机读取目录…', false);
      output.hidden = true;
      await analyze(handle, mode);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        status.hidden = true;
        return;
      }
      setStatus(status, `无法读取该目录：${error.message}`, true);
    }
  }

  async function loadCliInfo() {
    const commandBlock = document.getElementById('command');
    const endpoint = `${window.location.origin}/cli/skill-dock.js`;
    commandBlock.textContent = `curl.exe -fsSLO ${endpoint}\nnode skill-dock.js scan`;

    try {
      const response = await fetch('/api/cli/info');
      const payload = await response.json();
      const cli = payload.cli || {};
      if (!cli.available) throw new Error('脚本未随本次发布提供');
      document.getElementById('cli-version').textContent = `v${cli.version}`;
      document.getElementById('cli-size').textContent = formatBytes(cli.sizeBytes);
      document.getElementById('cli-sha').textContent = cli.sha256;
    } catch (error) {
      document.getElementById('cli-version').textContent = '不可用';
      document.getElementById('cli-size').textContent = '不可用';
      document.getElementById('cli-sha').textContent = error.message;
    }
  }

  async function copyInto(button, text) {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
    } catch {
      button.textContent = '请手动复制';
    }
    setTimeout(() => { button.textContent = original; }, 2000);
  }

  function bindCopy() {
    const commandButton = document.getElementById('copy');
    commandButton.addEventListener('click', () => {
      copyInto(commandButton, document.getElementById('command').textContent);
    });

    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', () => {
        const target = document.getElementById(button.dataset.copy);
        if (target) copyInto(button, target.textContent);
      });
    }
  }

  function bindSource() {
    const details = document.getElementById('source-details');
    if (!details) return;
    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      const target = document.getElementById('source');
      try {
        const response = await fetch('/cli/skill-dock.js');
        if (!response.ok) throw new Error('无法读取脚本');
        target.textContent = await response.text();
      } catch (error) {
        target.textContent = `无法读取脚本源码：${error.message}`;
        loaded = false;
      }
    });
  }

  function bindPickers() {
    const projectButton = document.getElementById('pick');
    const userButton = document.getElementById('pick-user');
    const hint = document.getElementById('pick-hint');

    if (!window.showDirectoryPicker) {
      projectButton.disabled = true;
      userButton.disabled = true;
      hint.textContent = '当前浏览器不支持目录读取，请用 Chrome 或 Edge 86 以上版本打开本页。';
      return;
    }

    projectButton.addEventListener('click', () => pickDirectory('project'));
    userButton.addEventListener('click', () => pickDirectory('skills'));
  }

  loadCliInfo();
  bindCopy();
  bindSource();
  bindPickers();
})();
