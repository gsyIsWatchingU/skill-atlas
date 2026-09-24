'use strict';

/**
 * 项目环境：把一个工作流入口及其依赖逐项链接到项目，不复制 Skill 内容。
 * 所有写入都先生成计划；冲突默认阻断；apply 记录 manifest 并支持回滚。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const PROJECT_TOOLS = Object.freeze({
  codex: Object.freeze({ id: 'codex', name: 'Codex', segments: ['.agents', 'skills'] }),
  claude: Object.freeze({ id: 'claude', name: 'Claude Code', segments: ['.claude', 'skills'] }),
  cursor: Object.freeze({ id: 'cursor', name: 'Cursor', segments: ['.agents', 'skills'] })
});

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeFolderName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || path.basename(name) !== name || /[\\/]/.test(name)) {
    throw new Error(`不安全的 Skill 目录名：${name || '空值'}`);
  }
  return name;
}

function normalizeTools(values) {
  const requested = Array.isArray(values) ? values : [];
  const tools = [...new Set(requested.map(String))]
    .map((id) => PROJECT_TOOLS[id])
    .filter(Boolean);
  if (!tools.length) throw new Error('至少选择一个目标 Agent');
  return tools;
}

async function inspectTarget(sourcePath, targetPath) {
  try {
    const stat = await fs.lstat(targetPath);
    if (!stat.isSymbolicLink()) return { state: 'conflict', detail: '目标已存在且不是链接' };
    try {
      const [actualSource, actualTarget] = await Promise.all([
        fs.realpath(sourcePath),
        fs.realpath(targetPath)
      ]);
      if (path.resolve(actualSource) === path.resolve(actualTarget)) {
        return { state: 'unchanged', detail: '已指向同一正本' };
      }
      return { state: 'conflict', detail: '目标链接指向其他位置' };
    } catch {
      return { state: 'conflict', detail: '目标链接已失效' };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'create-junction', detail: '将创建 Junction' };
    throw error;
  }
}

function workflowSources(workflow, resolvedSteps, entryPath) {
  const items = [{
    kind: 'workflow-entry',
    skillName: workflow.entrySkillName,
    folderName: workflow.entrySkillName,
    versionHash: '',
    sourcePath: entryPath
  }];
  for (const step of resolvedSteps) {
    const current = step.current || {};
    items.push({
      kind: 'component',
      skillName: current.name || step.skillName,
      folderName: safeFolderName(current.folderName || step.folderName || current.name || step.skillName),
      versionHash: current.versionHash || step.versionHash || '',
      sourcePath: current.directoryPath || step.skillId
    });
  }
  const byFolder = new Map();
  for (const item of items) {
    item.folderName = safeFolderName(item.folderName);
    item.sourcePath = path.resolve(String(item.sourcePath || ''));
    const key = item.folderName.toLocaleLowerCase('en-US');
    const existing = byFolder.get(key);
    if (existing && existing.sourcePath !== item.sourcePath) {
      throw new Error(`业务流中存在同目录名但来源不同的 Skill：${item.folderName}`);
    }
    if (!existing) byFolder.set(key, item);
  }
  return [...byFolder.values()];
}

function planSignature(plan) {
  const stable = plan.actions.map((action) => ({
    targetPath: action.targetPath,
    sourcePath: action.sourcePath,
    state: action.state,
    tools: action.tools
  }));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

async function buildProjectPlan({ workflow, resolvedSteps, entryPath, projectRoot, tools }) {
  const root = path.resolve(String(projectRoot || ''));
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('项目目录不存在或不可读');
  const selectedTools = normalizeTools(tools);
  const sources = workflowSources(workflow, resolvedSteps, entryPath);
  for (const source of sources) {
    const sourceStat = await fs.stat(source.sourcePath).catch(() => null);
    if (!sourceStat || !sourceStat.isDirectory()) {
      throw new Error(`Skill「${source.skillName}」的正本目录不存在`);
    }
  }

  const actionMap = new Map();
  for (const tool of selectedTools) {
    const targetRoot = path.join(root, ...tool.segments);
    for (const source of sources) {
      const targetPath = path.join(targetRoot, source.folderName);
      if (!isInside(root, targetPath)) throw new Error('项目环境目标路径越界');
      const key = path.resolve(targetPath).toLocaleLowerCase('en-US');
      const existing = actionMap.get(key);
      if (existing) {
        if (existing.sourcePath !== source.sourcePath) {
          throw new Error(`多个 Agent 对 ${source.folderName} 的来源解析不一致`);
        }
        existing.tools.push(tool.id);
        continue;
      }
      const inspected = await inspectTarget(source.sourcePath, targetPath);
      actionMap.set(key, {
        kind: source.kind,
        skillName: source.skillName,
        folderName: source.folderName,
        versionHash: source.versionHash,
        sourcePath: source.sourcePath,
        targetPath,
        tools: [tool.id],
        state: inspected.state,
        detail: inspected.detail
      });
    }
  }

  const actions = [...actionMap.values()];
  const plan = {
    schemaVersion: 1,
    planId: randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    entrySkillName: workflow.entrySkillName,
    projectRoot: root,
    tools: selectedTools.map((tool) => tool.id),
    actions,
    summary: {
      create: actions.filter((action) => action.state === 'create-junction').length,
      unchanged: actions.filter((action) => action.state === 'unchanged').length,
      conflicts: actions.filter((action) => action.state === 'conflict').length
    }
  };
  plan.signature = planSignature(plan);
  return plan;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

async function ensureProjectMetadata(projectRoot) {
  const filePath = path.join(projectRoot, '.skill-packer', 'project.json');
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (typeof value.projectKey === 'string' && value.projectKey) return { value, created: false };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const value = {
    schemaVersion: 1,
    projectKey: randomUUID(),
    name: path.basename(projectRoot),
    createdAt: new Date().toISOString()
  };
  await writeJsonAtomic(filePath, value);
  return { value, created: true };
}

async function applyProjectPlan(plan) {
  if (!plan || !Array.isArray(plan.actions)) throw new Error('项目环境计划无效');
  if (plan.summary && plan.summary.conflicts > 0) throw new Error('项目中存在同名冲突，不能执行');
  const current = await Promise.all(plan.actions.map(async (action) => ({
    ...action,
    ...(await inspectTarget(action.sourcePath, action.targetPath))
  })));
  const refreshed = { ...plan, actions: current };
  refreshed.signature = planSignature(refreshed);
  if (refreshed.signature !== plan.signature) throw new Error('项目目录在预览后发生变化，请重新预览');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const applyRoot = path.join(plan.projectRoot, '.skill-packer', 'workflow-applies', timestamp);
  const manifestPath = path.join(applyRoot, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    status: 'started',
    workflowId: plan.workflowId,
    workflowName: plan.workflowName,
    entrySkillName: plan.entrySkillName,
    projectRoot: plan.projectRoot,
    tools: plan.tools,
    createdJunctions: [],
    unchanged: plan.actions.filter((action) => action.state === 'unchanged'),
    projectMetadataCreated: false,
    workflowRecordPath: '',
    startedAt: new Date().toISOString()
  };
  await writeJsonAtomic(manifestPath, manifest);

  try {
    const metadata = await ensureProjectMetadata(plan.projectRoot);
    manifest.projectKey = metadata.value.projectKey;
    manifest.projectMetadataCreated = metadata.created;
    for (const action of plan.actions.filter((item) => item.state === 'create-junction')) {
      await fs.mkdir(path.dirname(action.targetPath), { recursive: true });
      await fs.symlink(action.sourcePath, action.targetPath, 'junction');
      manifest.createdJunctions.push(action);
      await writeJsonAtomic(manifestPath, manifest);
    }
    manifest.workflowRecordPath = path.join(plan.projectRoot, '.skill-packer', 'workflows', `${plan.workflowId}.json`);
    await writeJsonAtomic(manifest.workflowRecordPath, {
      schemaVersion: 1,
      projectKey: manifest.projectKey,
      workflowId: plan.workflowId,
      workflowName: plan.workflowName,
      entrySkillName: plan.entrySkillName,
      tools: plan.tools,
      appliedAt: new Date().toISOString(),
      skills: plan.actions.map((action) => ({
        name: action.skillName,
        folderName: action.folderName,
        versionHash: action.versionHash,
        sourcePath: action.sourcePath,
        targetPath: action.targetPath
      }))
    });
    manifest.status = 'completed';
    manifest.completedAt = new Date().toISOString();
    await writeJsonAtomic(manifestPath, manifest);
    return { manifest, manifestPath };
  } catch (error) {
    for (const action of [...manifest.createdJunctions].reverse()) {
      await fs.rm(action.targetPath, { recursive: false, force: true }).catch(() => {});
    }
    manifest.status = 'rolled-back-after-error';
    manifest.error = error.message || String(error);
    await writeJsonAtomic(manifestPath, manifest).catch(() => {});
    throw error;
  }
}

async function rollbackProjectApply(manifestPath) {
  const full = path.resolve(String(manifestPath || ''));
  const manifest = JSON.parse(await fs.readFile(full, 'utf8'));
  const allowedRoot = path.join(path.resolve(manifest.projectRoot), '.skill-packer', 'workflow-applies');
  if (!isInside(allowedRoot, full)) throw new Error('只允许回滚项目内的业务流 manifest');
  if (!['completed', 'rolled-back-after-error'].includes(manifest.status)) {
    throw new Error(`当前记录状态不可回滚：${manifest.status}`);
  }

  for (const action of [...(manifest.createdJunctions || [])].reverse()) {
    if (!isInside(manifest.projectRoot, action.targetPath)) throw new Error('回滚目标路径越界');
    try {
      const stat = await fs.lstat(action.targetPath);
      if (!stat.isSymbolicLink()) throw new Error(`目标已不是 Junction，拒绝删除：${action.targetPath}`);
      const [actualSource, actualTarget] = await Promise.all([
        fs.realpath(action.sourcePath),
        fs.realpath(action.targetPath)
      ]);
      if (path.resolve(actualSource) !== path.resolve(actualTarget)) {
        throw new Error(`目标已改指向其他位置，拒绝删除：${action.targetPath}`);
      }
      await fs.rm(action.targetPath, { recursive: false, force: false });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (manifest.workflowRecordPath && isInside(manifest.projectRoot, manifest.workflowRecordPath)) {
    await fs.rm(manifest.workflowRecordPath, { force: true });
  }
  manifest.status = 'rolled-back';
  manifest.rolledBackAt = new Date().toISOString();
  await writeJsonAtomic(full, manifest);
  return manifest;
}

module.exports = {
  PROJECT_TOOLS,
  applyProjectPlan,
  buildProjectPlan,
  inspectTarget,
  normalizeTools,
  planSignature,
  rollbackProjectApply,
  safeFolderName
};
