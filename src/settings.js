const MAX_CUSTOM_DESCRIPTION_LENGTH = 300;
const { getChineseDescription } = require('./chinese-descriptions');

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

  return {
    customRoots: Array.isArray(value.customRoots) ? value.customRoots : [],
    customDescriptions
  };
}

function attachCustomDescriptions(result, customDescriptions = {}) {
  return {
    ...result,
    skills: result.skills.map((skill) => ({
      ...skill,
      customDescription: customDescriptions[skill.id] || '',
      localizedDescription: getChineseDescription(skill.name)
    }))
  };
}

function updateCustomDescription(settings, id, description) {
  if (typeof id !== 'string' || !id) throw new Error('Skill ID 无效');

  const normalizedSettings = normalizeSettings(settings);
  const normalizedDescription = typeof description === 'string'
    ? description.trim().slice(0, MAX_CUSTOM_DESCRIPTION_LENGTH)
    : '';

  if (normalizedDescription) {
    normalizedSettings.customDescriptions[id] = normalizedDescription;
  } else {
    delete normalizedSettings.customDescriptions[id];
  }

  return { settings: normalizedSettings, description: normalizedDescription };
}

module.exports = {
  MAX_CUSTOM_DESCRIPTION_LENGTH,
  attachCustomDescriptions,
  normalizeSettings,
  updateCustomDescription
};
