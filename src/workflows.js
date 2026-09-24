'use strict';

/**
 * 工作流包：只保存 Skill 引用与版本，不复制任何子 Skill 内容。
 *
 * 生成后的入口本身也是一个 Skill。用户只需调用一次入口，Agent 会按这里的
 * 组合关系加载各子 Skill；ABCD 与 CDEF 因此可以安全复用同一份 C / D。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const STORE_VERSION = 1;
const MAX_WORKFLOWS = 100;
const MAX_STEPS = 32;
const MAX_NAME_LENGTH = 80;
const MAX_PURPOSE_LENGTH = 500;
const MAX_INSTRUCTION_LENGTH = 300;
const RELATIONS = new Set(['then', 'parallel', 'optional']);
const GENERATED_BY = 'skill-packer/workflow';

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function slugify(value) {
  const source = String(value || '');
  const slug = source
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (slug) return slug;
  const digest = createHash('sha256').update(source || 'workflow').digest('hex').slice(0, 10);
  return `flow-${digest}`;
}

function normalizeStep(value, index) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const skillId = cleanText(source.skillId, 1000);
  const skillName = cleanText(source.skillName, 160);
  const folderName = cleanText(source.folderName, 160);
  const versionHash = cleanText(source.versionHash, 128);
  if (!skillId || !skillName) throw new Error(`第 ${index + 1} 步缺少有效 Skill`);
  return {
    id: cleanText(source.id, 80) || `step-${randomUUID().slice(0, 8)}`,
    skillId,
    skillName,
    folderName: folderName || skillName,
    versionHash,
    relation: index === 0 ? 'then' : (RELATIONS.has(source.relation) ? source.relation : 'then'),
    instruction: cleanText(source.instruction, MAX_INSTRUCTION_LENGTH)
  };
}

function normalizeWorkflow(value, existing = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const name = cleanText(source.name, MAX_NAME_LENGTH);
  const purpose = cleanText(source.purpose, MAX_PURPOSE_LENGTH);
  if (!name) throw new Error('请填写业务流名称');
  const rawSteps = Array.isArray(source.steps) ? source.steps : [];
  if (!rawSteps.length) throw new Error('业务流至少需要一个 Skill');
  if (rawSteps.length > MAX_STEPS) throw new Error(`单个业务流最多 ${MAX_STEPS} 个步骤`);

  const now = new Date().toISOString();
  return {
    schemaVersion: STORE_VERSION,
    id: existing ? existing.id : `wf-${slugify(name)}-${randomUUID().slice(0, 8)}`,
    name,
    purpose,
    entrySkillName: existing ? existing.entrySkillName : `workflow-${slugify(name)}`,
    steps: rawSteps.map(normalizeStep),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    generatedAt: existing ? existing.generatedAt || '' : ''
  };
}

function normalizeStoredWorkflow(value) {
  try {
    const source = value && typeof value === 'object' ? value : {};
    const name = cleanText(source.name, MAX_NAME_LENGTH);
    const steps = Array.isArray(source.steps) ? source.steps.slice(0, MAX_STEPS).map(normalizeStep) : [];
    if (!source.id || !name || !steps.length) return null;
    return {
      schemaVersion: STORE_VERSION,
      id: cleanText(source.id, 160),
      name,
      purpose: cleanText(source.purpose, MAX_PURPOSE_LENGTH),
      entrySkillName: cleanText(source.entrySkillName, 160) || `workflow-${slugify(name)}`,
      steps,
      createdAt: cleanText(source.createdAt, 80),
      updatedAt: cleanText(source.updatedAt, 80),
      generatedAt: cleanText(source.generatedAt, 80)
    };
  } catch {
    return null;
  }
}

async function readWorkflowStore(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const workflows = Array.isArray(parsed.workflows)
      ? parsed.workflows.map(normalizeStoredWorkflow).filter(Boolean).slice(0, MAX_WORKFLOWS)
      : [];
    return { schemaVersion: STORE_VERSION, workflows };
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: STORE_VERSION, workflows: [] };
    if (error instanceof SyntaxError) {
      await fs.rename(filePath, `${filePath}.broken-${Date.now()}`).catch(() => {});
      return { schemaVersion: STORE_VERSION, workflows: [] };
    }
    throw error;
  }
}

async function writeWorkflowStore(filePath, store) {
  const normalized = {
    schemaVersion: STORE_VERSION,
    workflows: (store.workflows || []).map(normalizeStoredWorkflow).filter(Boolean).slice(0, MAX_WORKFLOWS)
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
  return normalized;
}

async function saveWorkflow(filePath, input) {
  const store = await readWorkflowStore(filePath);
  const index = store.workflows.findIndex((workflow) => workflow.id === input.id);
  const existing = index >= 0 ? store.workflows[index] : null;
  if (!existing && store.workflows.length >= MAX_WORKFLOWS) {
    throw new Error(`最多保存 ${MAX_WORKFLOWS} 个业务流`);
  }
  const workflow = normalizeWorkflow(input, existing);
  const collision = store.workflows.find((item) => (
    item.id !== workflow.id && item.entrySkillName === workflow.entrySkillName
  ));
  if (collision) throw new Error(`调用入口 ${workflow.entrySkillName} 已被业务流「${collision.name}」使用`);
  if (index >= 0) store.workflows[index] = workflow;
  else store.workflows.unshift(workflow);
  await writeWorkflowStore(filePath, store);
  return workflow;
}

function resolveWorkflowSteps(workflow, skills) {
  const byId = new Map((skills || []).map((skill) => [skill.id, skill]));
  const byName = new Map();
  for (const skill of skills || []) {
    for (const key of [skill.folderName, skill.name]) {
      const normalized = String(key || '').toLocaleLowerCase('en-US');
      if (normalized && !byName.has(normalized)) byName.set(normalized, skill);
    }
  }
  return workflow.steps.map((step, index) => {
    const skill = byId.get(step.skillId)
      || byName.get(String(step.folderName || step.skillName).toLocaleLowerCase('en-US'));
    if (!skill) throw new Error(`第 ${index + 1} 步的 Skill「${step.skillName}」当前未安装`);
    if (step.versionHash && step.versionHash !== skill.versionHash) {
      throw new Error(`第 ${index + 1} 步的 Skill「${step.skillName}」版本已变化，请重新保存业务流后再生成入口`);
    }
    return { ...step, current: skill };
  });
}

function relationLabel(relation, index) {
  if (index === 0) return '起点';
  if (relation === 'parallel') return '与上一步并行';
  if (relation === 'optional') return '按需执行';
  return '接着执行';
}

function buildWorkflowSkill(workflow, resolvedSteps) {
  const componentNames = resolvedSteps.map((step) => `$${step.current.name}`).join(' → ');
  const description = cleanText(
    `业务流「${workflow.name}」的单一调用入口。自动组合 ${resolvedSteps.length} 个 Skill：${resolvedSteps.map((step) => step.current.name).join('、')}。`,
    300
  );
  const lines = [
    '---',
    `name: ${workflow.entrySkillName}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# ${workflow.name}`,
    '',
    workflow.purpose || '按定义组合多个 Skill 完成一条业务流。',
    '',
    '## 调用方式',
    '',
    `用户只需调用 \`$${workflow.entrySkillName}\`。你必须自动加载并遵循下面列出的子 Skill，不能要求用户再逐个选择。`,
    '',
    '## 组合原则',
    '',
    '- 本入口只负责编排，不复制、改写或内嵌任何子 Skill 的实现逻辑。',
    '- 每一步开始前读取对应子 Skill 的完整说明，并以子 Skill 的约束为准。',
    '- 多个业务流引用同一个子 Skill 时，始终复用该 Skill，不创建业务流私有副本。',
    '- 若子 Skill 缺失或版本不一致，停止在该步并明确报告，不得静默替代。',
    '',
    '## 流程',
    ''
  ];
  resolvedSteps.forEach((step, index) => {
    const suffix = step.instruction ? `；本流程补充：${step.instruction}` : '';
    lines.push(`${index + 1}. **${relationLabel(step.relation, index)}**：调用 \`$${step.current.name}\`${suffix}`);
  });
  lines.push('', '## 组合预览', '', componentNames, '');

  const manifest = {
    schemaVersion: STORE_VERSION,
    generatedBy: GENERATED_BY,
    workflowId: workflow.id,
    name: workflow.name,
    purpose: workflow.purpose,
    entrySkillName: workflow.entrySkillName,
    generatedAt: new Date().toISOString(),
    steps: resolvedSteps.map((step, index) => ({
      position: index + 1,
      skillName: step.current.name,
      folderName: step.current.folderName || step.folderName,
      versionHash: step.current.versionHash || step.versionHash,
      relation: index === 0 ? 'then' : step.relation,
      instruction: step.instruction
    }))
  };
  return { skillMd: `${lines.join('\n')}\n`, manifest };
}

function assertChildPath(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('业务流入口路径越界');
  }
  return resolvedChild;
}

async function generateWorkflowSkill({ filePath, workflowId, centralRootPath, skills }) {
  const store = await readWorkflowStore(filePath);
  const index = store.workflows.findIndex((workflow) => workflow.id === workflowId);
  if (index < 0) throw new Error('业务流不存在或已被删除');
  const workflow = store.workflows[index];
  const resolvedSteps = resolveWorkflowSteps(workflow, skills);
  const entryPath = assertChildPath(centralRootPath, path.join(centralRootPath, workflow.entrySkillName));
  const markerPath = path.join(entryPath, 'workflow.json');

  try {
    const existing = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (existing.generatedBy !== GENERATED_BY || existing.workflowId !== workflow.id) {
      throw new Error(`目录 ${workflow.entrySkillName} 已存在，且不是当前业务流生成的入口`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      const entries = await fs.readdir(entryPath);
      if (entries.length) throw new Error(`目录 ${workflow.entrySkillName} 已存在，不能覆盖普通 Skill`);
    } catch (readError) {
      if (readError.code !== 'ENOENT') throw readError;
    }
  }

  const output = buildWorkflowSkill(workflow, resolvedSteps);
  await fs.mkdir(entryPath, { recursive: true });
  const skillTemp = path.join(entryPath, `SKILL.md.${process.pid}.tmp`);
  const manifestTemp = path.join(entryPath, `workflow.json.${process.pid}.tmp`);
  await fs.writeFile(skillTemp, output.skillMd, 'utf8');
  await fs.writeFile(manifestTemp, `${JSON.stringify(output.manifest, null, 2)}\n`, 'utf8');
  await fs.rename(skillTemp, path.join(entryPath, 'SKILL.md'));
  await fs.rename(manifestTemp, markerPath);

  workflow.generatedAt = output.manifest.generatedAt;
  store.workflows[index] = workflow;
  await writeWorkflowStore(filePath, store);
  return { workflow, entryPath, manifest: output.manifest };
}

async function deleteWorkflow(filePath, workflowId, centralRootPath = '') {
  const store = await readWorkflowStore(filePath);
  const workflow = store.workflows.find((item) => item.id === workflowId);
  if (!workflow) return false;

  if (centralRootPath) {
    const entryPath = assertChildPath(centralRootPath, path.join(centralRootPath, workflow.entrySkillName));
    try {
      const marker = JSON.parse(await fs.readFile(path.join(entryPath, 'workflow.json'), 'utf8'));
      if (marker.generatedBy === GENERATED_BY && marker.workflowId === workflow.id) {
        await fs.rm(entryPath, { recursive: true, force: false });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  store.workflows = store.workflows.filter((item) => item.id !== workflowId);
  await writeWorkflowStore(filePath, store);
  return true;
}

function exportWorkflowPackage(workflow) {
  if (!workflow) throw new Error('业务流不存在');
  return {
    format: 'skill-packer/workflow-package',
    schemaVersion: STORE_VERSION,
    exportedAt: new Date().toISOString(),
    workflow: {
      name: workflow.name,
      purpose: workflow.purpose,
      entrySkillName: workflow.entrySkillName,
      steps: workflow.steps.map((step, index) => ({
        position: index + 1,
        skillName: step.skillName,
        folderName: step.folderName,
        versionHash: step.versionHash,
        relation: index === 0 ? 'then' : step.relation,
        instruction: step.instruction
      }))
    }
  };
}

function validateWorkflowPackage(input) {
  if (!input || input.format !== 'skill-packer/workflow-package' || input.schemaVersion !== STORE_VERSION) {
    throw new Error('不是受支持的 Skill Packer 业务流包');
  }
  const source = input.workflow && typeof input.workflow === 'object' && !Array.isArray(input.workflow)
    ? input.workflow
    : {};
  const name = cleanText(source.name, MAX_NAME_LENGTH);
  const purpose = cleanText(source.purpose, MAX_PURPOSE_LENGTH);
  const entrySkillName = cleanText(source.entrySkillName, 64);
  const rawSteps = Array.isArray(source.steps) ? source.steps : [];
  if (!name) throw new Error('业务流包缺少名称');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entrySkillName)) throw new Error('业务流入口名称无效');
  if (!rawSteps.length || rawSteps.length > MAX_STEPS) throw new Error(`业务流包步骤数必须为 1-${MAX_STEPS}`);
  const steps = rawSteps.map((step, index) => {
    const skillName = cleanText(step && step.skillName, 160);
    const folderName = cleanText(step && step.folderName, 160);
    const versionHash = cleanText(step && step.versionHash, 64).toLocaleLowerCase('en-US');
    if (!skillName || !folderName || path.basename(folderName) !== folderName || /[\\/]/.test(folderName)) {
      throw new Error(`第 ${index + 1} 步的 Skill 信息无效`);
    }
    if (!/^[0-9a-f]{64}$/.test(versionHash)) throw new Error(`第 ${index + 1} 步缺少有效版本`);
    return {
      position: index + 1,
      skillName,
      folderName,
      versionHash,
      relation: index === 0 ? 'then' : (RELATIONS.has(step.relation) ? step.relation : 'then'),
      instruction: cleanText(step.instruction, MAX_INSTRUCTION_LENGTH)
    };
  });
  return {
    format: 'skill-packer/workflow-package',
    schemaVersion: STORE_VERSION,
    workflow: { name, purpose, entrySkillName, steps }
  };
}

function workflowPackageHash(input) {
  return createHash('sha256').update(JSON.stringify(validateWorkflowPackage(input))).digest('hex');
}

async function importWorkflowPackage(filePath, input, skills, options = {}) {
  const validated = validateWorkflowPackage(input);
  const workflow = validated.workflow;
  const packageSteps = workflow.steps;

  const byName = new Map();
  for (const skill of skills || []) {
    for (const key of [skill.folderName, skill.name]) {
      const normalized = String(key || '').toLocaleLowerCase('en-US');
      if (normalized && !byName.has(normalized)) byName.set(normalized, skill);
    }
  }
  const missing = [];
  const mismatched = [];
  const steps = packageSteps.map((step) => {
    const key = String(step.folderName || step.skillName || '').toLocaleLowerCase('en-US');
    const skill = byName.get(key);
    if (!skill) {
      missing.push(step.skillName || step.folderName || '未知 Skill');
      return null;
    }
    if (step.versionHash && step.versionHash !== skill.versionHash) {
      mismatched.push(step.skillName || skill.name);
      return null;
    }
    return {
      skillId: skill.id,
      skillName: skill.name,
      folderName: skill.folderName || skill.name,
      versionHash: skill.versionHash || step.versionHash || '',
      relation: step.relation,
      instruction: step.instruction
    };
  });
  if (missing.length) throw new Error(`缺少依赖 Skill：${missing.join('、')}`);
  if (mismatched.length) throw new Error(`以下 Skill 版本不匹配：${mismatched.join('、')}`);
  let existingId = '';
  if (options.replaceByName === true) {
    const store = await readWorkflowStore(filePath);
    const normalizedName = workflow.name.toLocaleLowerCase('zh-CN');
    const existing = store.workflows.find((item) => (
      item.entrySkillName === workflow.entrySkillName || item.name.toLocaleLowerCase('zh-CN') === normalizedName
    ));
    existingId = existing ? existing.id : '';
  }
  return saveWorkflow(filePath, {
    id: existingId || undefined,
    name: workflow.name,
    purpose: workflow.purpose,
    steps
  });
}

module.exports = {
  GENERATED_BY,
  RELATIONS,
  buildWorkflowSkill,
  deleteWorkflow,
  generateWorkflowSkill,
  exportWorkflowPackage,
  importWorkflowPackage,
  validateWorkflowPackage,
  workflowPackageHash,
  normalizeWorkflow,
  readWorkflowStore,
  resolveWorkflowSteps,
  saveWorkflow,
  slugify,
  writeWorkflowStore
};
