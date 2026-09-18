'use strict';

/**
 * 桌面应用的本地设置：自定义扫描根 + 自定义中文简介。
 *
 * 存放位置与会话历史一致：`app.getPath('userData')/settings.json`。
 * 绝不写入仓库、绝不写入 %APPDATA% 之外的位置（§7 凭据与隐私边界）。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CUSTOM_DESCRIPTION_LENGTH = 300;

function normalizeSettings(value = {}) {
  const customDescriptions = {};
  const sourceDescriptions = value.customDescriptions;

  if (sourceDescriptions && typeof sourceDescriptions === 'object' && !Array.isArray(sourceDescriptions)) {
    for (const [id, description] of Object.entries(sourceDescriptions)) {
      if (typeof description !== 'string') continue;
      const normalized = description.trim().slice(0, MAX_CUSTOM_DESCRIPTION_LENGTH);
      if (id && normalized) customDescriptions[id] = normalized;
    }
  }

  const customRoots = Array.isArray(value.customRoots)
    ? value.customRoots
      .filter((root) => root && typeof root.id === 'string' && typeof root.absolutePath === 'string')
      .map((root) => ({
        id: root.id,
        label: String(root.label || path.basename(root.absolutePath) || root.id),
        displayPath: root.absolutePath,
        absolutePath: root.absolutePath,
        platform: 'shared',
        scope: 'custom'
      }))
    : [];

  return { customRoots, customDescriptions };
}

async function readSettings(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeSettings({});
    // 配置损坏时不要静默重建：留一份备份，避免用户的自定义简介被无声抹掉
    if (error instanceof SyntaxError) {
      await fs.rename(filePath, `${filePath}.broken-${Date.now()}`).catch(() => {});
      return normalizeSettings({});
    }
    throw error;
  }
}

async function writeSettings(filePath, settings) {
  const normalized = normalizeSettings(settings);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // 原子写：先写临时文件再改名，避免崩溃时留下半截 JSON
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
  return normalized;
}

/**
 * 给扫描结果补上「自定义中文简介」与「内置中文简介」两层文案。
 * 展示优先级由渲染层决定：自定义 > 内置中文 > 原始 description。
 */
function attachCustomDescriptions(skills, settings = {}) {
  const customDescriptions = (settings && settings.customDescriptions) || {};
  return skills.map((skill) => ({
    ...skill,
    customDescription: customDescriptions[skill.id] || '',
    displayDescription: customDescriptions[skill.id] || skill.description || '暂无描述'
  }));
}

function updateCustomDescription(settings, id, description) {
  if (typeof id !== 'string' || !id) throw new Error('Skill ID 无效');
  const normalizedSettings = normalizeSettings(settings);
  const normalizedDescription = typeof description === 'string'
    ? description.trim().slice(0, MAX_CUSTOM_DESCRIPTION_LENGTH)
    : '';
  if (normalizedDescription) normalizedSettings.customDescriptions[id] = normalizedDescription;
  else delete normalizedSettings.customDescriptions[id];
  return { settings: normalizedSettings, description: normalizedDescription };
}

module.exports = {
  MAX_CUSTOM_DESCRIPTION_LENGTH,
  attachCustomDescriptions,
  normalizeSettings,
  readSettings,
  updateCustomDescription,
  writeSettings
};
