// 本机 Skill 去重：按规范化名称分组，每组只保留文件最全的一个，其余移出清单。
// 纯函数模块：浏览器挂 window.SkillDedup，Node 测试可直接 require。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkillDedup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalizeName(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').trim();
  }

  function findDuplicateGroups(skills) {
    const groups = new Map();
    for (const skill of skills || []) {
      const key = normalizeName(skill.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(skill);
    }
    const result = [];
    for (const entry of groups) {
      const list = entry[1];
      if (list.length > 1) result.push({ key: entry[0], name: list[0].name, skills: list });
    }
    return result;
  }

  // 返回 { keptSkills, removedCount, groups }
  function dedupeDuplicateSkills(skills) {
    const groups = findDuplicateGroups(skills);
    const keep = new Set();
    let removedCount = 0;
    for (const group of groups) {
      group.skills.sort(function (a, b) {
        return (b.fileCount - a.fileCount) || (b.sizeBytes - a.sizeBytes);
      });
      keep.add(group.skills[0]);
      removedCount += group.skills.length - 1;
    }
    const keptSkills = (skills || []).filter(function (skill) {
      return keep.has(skill) || !groups.some(function (group) {
        return group.skills.includes(skill);
      });
    });
    return { keptSkills: keptSkills, removedCount: removedCount, groups: groups };
  }

  return {
    dedupeDuplicateSkills: dedupeDuplicateSkills,
    findDuplicateGroups: findDuplicateGroups
  };
});
