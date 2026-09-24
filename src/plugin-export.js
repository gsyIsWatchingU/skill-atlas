'use strict';

/**
 * 把业务流导出为 Codex 原生 Plugin 目录。
 * Plugin 内保存入口与依赖 Skill 的版本快照，接收方无需安装 Skill Packer。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const scanner = require('./scanner');
const { buildWorkflowSkill, resolveWorkflowSteps } = require('./workflows');

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safePluginName(value) {
  const name = String(value || '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error('Plugin 名称必须是 64 字符内的小写字母、数字和连字符');
  }
  return name;
}

async function collectSkillSnapshot(directoryPath, expectedVersionHash) {
  const result = { files: [], sizeBytes: 0, skippedSensitive: 0 };
  await scanner.collectDirectoryFiles(
    directoryPath,
    '',
    0,
    result,
    scanner.createLinkState([directoryPath], true)
  );
  if (!result.files.some((file) => file.path.toLocaleLowerCase('en-US') === 'skill.md')) {
    throw new Error(`Skill 目录缺少 SKILL.md：${directoryPath}`);
  }
  const versionHash = scanner.computeVersionHash(result.files);
  if (expectedVersionHash && expectedVersionHash !== versionHash) {
    throw new Error(`Skill 在导出期间发生变化：${path.basename(directoryPath)}`);
  }
  return { ...result, versionHash };
}

async function writeSnapshot(targetRoot, files) {
  for (const file of files) {
    const target = path.resolve(targetRoot, file.path);
    if (!isInside(targetRoot, target)) throw new Error(`Skill 文件路径越界：${file.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
}

function pluginManifest(workflow) {
  const description = String(workflow.purpose || `业务流「${workflow.name}」`).trim().slice(0, 200);
  return {
    name: safePluginName(workflow.entrySkillName),
    version: '1.0.0',
    description,
    author: { name: 'Skill Packer 用户' },
    license: 'MIT',
    keywords: ['workflow', 'skills', 'skill-packer'],
    skills: './skills/',
    interface: {
      displayName: String(workflow.name).slice(0, 80),
      shortDescription: description.slice(0, 120),
      longDescription: description,
      developerName: 'Skill Packer 用户',
      category: 'Productivity',
      capabilities: ['Write'],
      defaultPrompt: [`使用 $${workflow.entrySkillName} 执行业务流。`],
      brandColor: '#9FB8A5'
    }
  };
}

async function exportWorkflowPlugin({ workflow, skills, targetParent }) {
  if (!workflow) throw new Error('业务流不存在');
  const pluginName = safePluginName(workflow.entrySkillName);
  const parent = path.resolve(String(targetParent || ''));
  const parentStat = await fs.stat(parent).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) throw new Error('导出目录不存在或不可读');
  const destination = path.join(parent, pluginName);
  if (await fs.lstat(destination).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) {
    throw new Error(`导出目录已存在：${destination}`);
  }

  const resolvedSteps = resolveWorkflowSteps(workflow, skills);
  const temporary = path.join(parent, `.${pluginName}-${randomUUID()}.tmp`);
  const exportedSkills = [];
  try {
    await fs.mkdir(path.join(temporary, '.codex-plugin'), { recursive: true });
    await fs.mkdir(path.join(temporary, 'skills'), { recursive: true });
    await fs.writeFile(
      path.join(temporary, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify(pluginManifest(workflow), null, 2)}\n`,
      'utf8'
    );

    const entryRoot = path.join(temporary, 'skills', pluginName);
    await fs.mkdir(entryRoot, { recursive: true });
    const entry = buildWorkflowSkill(workflow, resolvedSteps);
    await fs.writeFile(path.join(entryRoot, 'SKILL.md'), entry.skillMd, 'utf8');
    await fs.writeFile(
      path.join(entryRoot, 'workflow.json'),
      `${JSON.stringify(entry.manifest, null, 2)}\n`,
      'utf8'
    );

    const seenFolders = new Set([pluginName.toLocaleLowerCase('en-US')]);
    for (const step of resolvedSteps) {
      const folderName = String(step.current.folderName || step.current.name || '').trim();
      const normalized = folderName.toLocaleLowerCase('en-US');
      if (!folderName || path.basename(folderName) !== folderName || /[\\/]/.test(folderName)) {
        throw new Error(`依赖 Skill 目录名无效：${folderName || '空值'}`);
      }
      if (seenFolders.has(normalized)) {
        if (normalized === pluginName.toLocaleLowerCase('en-US')) {
          throw new Error(`依赖 Skill 与入口目录重名：${folderName}`);
        }
        continue;
      }
      seenFolders.add(normalized);
      const snapshot = await collectSkillSnapshot(step.current.directoryPath, step.versionHash);
      await writeSnapshot(path.join(temporary, 'skills', folderName), snapshot.files);
      exportedSkills.push({
        name: step.current.name,
        folderName,
        versionHash: snapshot.versionHash,
        fileCount: snapshot.files.length
      });
    }

    await fs.writeFile(path.join(temporary, 'workflow-package.json'), `${JSON.stringify({
      schemaVersion: 1,
      generatedBy: 'skill-packer/workflow-plugin',
      workflowId: workflow.id,
      workflowName: workflow.name,
      entrySkillName: pluginName,
      exportedAt: new Date().toISOString(),
      skills: exportedSkills
    }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, destination);
    return { destination, pluginName, skillCount: exportedSkills.length + 1 };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  collectSkillSnapshot,
  exportWorkflowPlugin,
  pluginManifest,
  safePluginName
};
