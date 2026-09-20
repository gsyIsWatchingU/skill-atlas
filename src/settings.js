'use strict';

/**
 * 桌面应用的本地设置：自定义扫描根 + 自定义简介 + 中文简介 + AI 整理配置。
 *
 * 存放位置与会话历史一致：`app.getPath('userData')/settings.json`。
 * 绝不写入仓库、绝不写入 %APPDATA% 之外的位置（§7 凭据与隐私边界）。
 *
 * 简介三层文案（渲染优先级从高到低）：
 *   1. customDescriptionsZh[id] —— 用户手动维护 / 自动翻译出的「中文简介」
 *   2. customDescriptions[id]    —— 用户手动覆盖的「自定义简介」（任意语言）
 *   3. skill.description         —— SKILL.md frontmatter 里的原始 description
 *
 * 中文简介是一个**独立字段**：不回写 SKILL.md，不与自定义简介互相覆盖，
 * 用户可以两者都留，也可以只留其中一个。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CUSTOM_DESCRIPTION_LENGTH = 300;
const MAX_ZH_DESCRIPTION_LENGTH = 300;
const MAX_BODY_CHARS_LIMIT = 4000;
const DEFAULT_MAX_BODY_CHARS = 800;

/** 从一个 `{id: text}` 字典里挑出合法的字符串条目 */
function normalizeDescriptionMap(source, maxLength) {
  const out = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const [id, description] of Object.entries(source)) {
    if (typeof description !== 'string') continue;
    const normalized = description.trim().slice(0, maxLength);
    if (id && normalized) out[id] = normalized;
  }
  return out;
}

/**
 * AI 整理配置。
 *
 * `enabled` 是数据出网的总闸：**默认关闭**，且即使打开，每次发送前还要再看一次预览。
 * `apiKey` 明文落在本机 settings.json —— 与云端会话令牌同一级别的处理方式，
 * 不额外引入系统密钥链（会引入原生依赖）。界面上必须如实说明这一点。
 */
function normalizeAiConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const maxBodyChars = Number(source.maxBodyChars);
  return {
    enabled: source.enabled === true,
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '',
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    includeBody: source.includeBody === true,
    maxBodyChars: Number.isFinite(maxBodyChars)
      ? Math.min(MAX_BODY_CHARS_LIMIT, Math.max(100, Math.floor(maxBodyChars)))
      : DEFAULT_MAX_BODY_CHARS
  };
}

/** 给渲染层看的配置：API Key 只回掩码，不回原文 */
function withMaskedAiConfig(settings) {
  const ai = normalizeAiConfig(settings && settings.ai);
  const key = ai.apiKey;
  return { ...ai, apiKey: '', apiKeySet: Boolean(key), apiKeyMask: maskSecret(key) };
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function normalizeSettings(value = {}) {
  const customDescriptions = normalizeDescriptionMap(
    value.customDescriptions,
    MAX_CUSTOM_DESCRIPTION_LENGTH
  );
  const customDescriptionsZh = normalizeDescriptionMap(
    value.customDescriptionsZh,
    MAX_ZH_DESCRIPTION_LENGTH
  );

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

  return {
    customRoots,
    customDescriptions,
    customDescriptionsZh,
    ai: normalizeAiConfig(value.ai)
  };
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
 * 给扫描结果补上三层文案。
 * 展示优先级：中文简介 > 自定义简介 > 原始 description。
 */
function attachCustomDescriptions(skills, settings = {}) {
  const customDescriptions = (settings && settings.customDescriptions) || {};
  const customDescriptionsZh = (settings && settings.customDescriptionsZh) || {};
  return skills.map((skill) => {
    const customDescription = customDescriptions[skill.id] || '';
    const descriptionZh = customDescriptionsZh[skill.id] || '';
    const fallback = skill.description || '暂无描述';
    const displayDescription = descriptionZh || customDescription || fallback;
    return {
      ...skill,
      customDescription,
      descriptionZh,
      displayDescription
    };
  });
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

function updateCustomDescriptionZh(settings, id, descriptionZh) {
  if (typeof id !== 'string' || !id) throw new Error('Skill ID 无效');
  const normalizedSettings = normalizeSettings(settings);
  const normalized = typeof descriptionZh === 'string'
    ? descriptionZh.trim().slice(0, MAX_ZH_DESCRIPTION_LENGTH)
    : '';
  if (normalized) normalizedSettings.customDescriptionsZh[id] = normalized;
  else delete normalizedSettings.customDescriptionsZh[id];
  return { settings: normalizedSettings, descriptionZh: normalized };
}

/**
 * 更新 AI 整理配置。
 * `apiKey` 传掩码（含 •）表示「沿用已保存的那个」，传空串表示清空，传其它值表示替换。
 */
function updateAiConfig(settings, patch = {}) {
  const normalized = normalizeSettings(settings);
  const current = normalized.ai;
  const next = { ...current };

  if ('enabled' in patch) next.enabled = patch.enabled === true;
  if ('baseUrl' in patch) next.baseUrl = typeof patch.baseUrl === 'string' ? patch.baseUrl.trim() : '';
  if ('model' in patch) next.model = typeof patch.model === 'string' ? patch.model.trim() : '';
  if ('includeBody' in patch) next.includeBody = patch.includeBody === true;
  if ('maxBodyChars' in patch) next.maxBodyChars = Number(patch.maxBodyChars);
  if ('apiKey' in patch) {
    const key = String(patch.apiKey || '').trim();
    if (key && key.includes('•')) next.apiKey = current.apiKey; // 掩码回传 = 不改
    else next.apiKey = key;
  }

  normalized.ai = normalizeAiConfig(next);
  return { settings: normalized, ai: normalized.ai };
}

/** 是否具备出网条件：端点与模型名必填，API Key 可空（本地模型不需要） */
function isAiReady(ai) {
  const config = normalizeAiConfig(ai);
  return Boolean(config.baseUrl && config.model);
}

function aiMissingFields(ai) {
  const config = normalizeAiConfig(ai);
  const missing = [];
  if (!config.baseUrl) missing.push('接口地址');
  if (!config.model) missing.push('模型名');
  return missing;
}

module.exports = {
  DEFAULT_MAX_BODY_CHARS,
  MAX_BODY_CHARS_LIMIT,
  MAX_CUSTOM_DESCRIPTION_LENGTH,
  MAX_ZH_DESCRIPTION_LENGTH,
  aiMissingFields,
  attachCustomDescriptions,
  isAiReady,
  maskSecret,
  normalizeAiConfig,
  normalizeSettings,
  readSettings,
  updateAiConfig,
  updateCustomDescription,
  updateCustomDescriptionZh,
  withMaskedAiConfig,
  writeSettings
};
