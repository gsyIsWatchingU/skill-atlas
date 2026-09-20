'use strict';

/**
 * 统一技能库：把散落在各 IDE 用户技能目录里的个人 Skill，汇聚到一个中央目录，
 * 再在每个 IDE 目录里建 junction（目录链接）指回去 —— 一份物理文件，所有 IDE 都能识别。
 *
 * 「算计划」和「动文件」分开：
 *   - buildUnifyPlan 纯函数，只读扫描结果，不碰盘，可重入、可测试；
 *   - applyUnify / rollbackUnify 才真正移动文件、建 junction，并写 manifest 供回滚。
 *
 * 只处理个人技能（ownership === 'personal'）：
 *   豆包内置 .skills、Codex 插件缓存、.system 都是只读系统技能，不动。
 *
 * 去重与冲突策略：
 *   - 同名内容相同 = 真重复：中央已有的那份优先当正本（不白搬），其它 IDE 里的重复副本就地换成 junction。
 *   - 同名内容不同 = 真冲突：取修改时间最新的当正本；中央里的旧版先备份再替换；其它 IDE 的分叉旧版保留（skip-local），不静默删。
 *   - 移动/建链全部落 manifest，rollback 反向还原。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const CENTRAL_ROOT_ID = 'shared-agents';
const LINK_TARGET_ROOT_IDS = ['codex-user', 'workbuddy-user', 'doubao-user'];
const BACKUP_DIRNAME = '.unify-backup';

/** childPath 是否落在 parentPath 之内（大小写不敏感） */
function isUnder(childPath, parentPath) {
  const rel = path.relative(parentPath, childPath);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 构建统一计划（纯函数）。
 */
function buildUnifyPlan(scanResult, options = {}) {
  const centralRootId = options.centralRootId || CENTRAL_ROOT_ID;
  const roots = scanResult.roots || [];
  const centralRoot = roots.find((root) => root.id === centralRootId);
  if (!centralRoot) throw new Error(`找不到中央根：${centralRootId}`);
  const centralDir = centralRoot.path;

  const targetRoots = LINK_TARGET_ROOT_IDS
    .map((id) => roots.find((root) => root.id === id))
    .filter(Boolean);

  const personal = (scanResult.skills || []).filter((skill) => skill.ownership !== 'system');

  const byName = new Map();
  for (const skill of personal) {
    if (!byName.has(skill.name)) byName.set(skill.name, []);
    byName.get(skill.name).push(skill);
  }

  const items = [];
  for (const [name, group] of byName.entries()) {
    const hashes = new Set(group.map((skill) => skill.versionHash));
    const conflict = hashes.size > 1;

    // 按平台分组：rootId -> skill
    const byRoot = new Map(group.map((skill) => [skill.rootId, skill]));
    const centralMember = group.find((skill) => isUnder(
      skill.realDirectoryPath || skill.directoryPath,
      centralDir
    ));

    // 选正本：修改时间最新；但若中央已有一份，且与最新版本内容相同，优先选中央那份（不白搬）。
    const newest = [...group].sort((a, b) => {
      const ta = new Date(a.modifiedAt || 0).getTime();
      const tb = new Date(b.modifiedAt || 0).getTime();
      if (tb !== ta) return tb - ta;
      return String(a.platform).localeCompare(String(b.platform));
    })[0];

    let canonical = newest;
    let centralAction;
    if (centralMember && !conflict) {
      canonical = centralMember;
      centralAction = 'keep';
    } else if (centralMember && conflict && centralMember.versionHash === newest.versionHash) {
      canonical = centralMember;
      centralAction = 'keep';
    } else if (centralMember) {
      // 中央是旧版分叉：保留最新正本，中央旧版在 apply 时备份替换。
      canonical = newest;
      centralAction = 'move-to-central';
    } else {
      canonical = newest;
      centralAction = 'move-to-central';
    }

    const canonicalPath = canonical.realDirectoryPath || canonical.directoryPath;
    const centralPath = path.join(centralDir, name);

    const links = targetRoots
      .filter((root) => root.path !== centralDir)
      .map((root) => {
        const member = byRoot.get(root.id);
        const linkPath = path.join(root.path, name);
        let action;
        if (root.id === canonical.rootId) {
          action = 'replace-with-junction'; // 正本从这里搬走，原位换链接指回中央
        } else if (!member) {
          action = 'create-junction'; // 这里没有，建链接
        } else if (member.versionHash === canonical.versionHash) {
          action = 'replace-duplicate'; // 内容相同的重复副本：删掉本地真实目录，换成链接
        } else {
          action = 'skip-local'; // 内容分叉：保留本地，不静默删
        }
        return {
          rootId: root.id,
          platform: root.platform,
          linkPath,
          target: centralPath,
          action
        };
      });

    const superseded = group
      .filter((skill) => skill !== canonical)
      .map((skill) => ({
        name,
        rootId: skill.rootId,
        platform: skill.platform,
        sourcePath: skill.realDirectoryPath || skill.directoryPath,
        modifiedAt: skill.modifiedAt,
        reason: skill.versionHash === canonical.versionHash
          ? '与正本内容相同的重复副本'
          : '同名但内容不同，保留更新的版本'
      }));

    items.push({
      name,
      conflict,
      canonical: {
        rootId: canonical.rootId,
        platform: canonical.platform,
        sourcePath: canonicalPath,
        modifiedAt: canonical.modifiedAt
      },
      centralAction,
      centralPath,
      links,
      superseded
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));

  const count = (pred) => items.reduce((n, item) => n + item.links.filter(pred).length, 0);
  const summary = {
    names: items.length,
    moves: items.filter((item) => item.centralAction === 'move-to-central').length,
    keepInCentral: items.filter((item) => item.centralAction === 'keep').length,
    conflicts: items.filter((item) => item.conflict).length,
    createJunctions: count((l) => l.action === 'create-junction'),
    replaceWithJunction: count((l) => l.action === 'replace-with-junction'),
    replaceDuplicates: count((l) => l.action === 'replace-duplicate'),
    skipLocal: count((l) => l.action === 'skip-local')
  };

  return {
    centralDir,
    targetRoots: targetRoots.map((r) => ({ id: r.id, platform: r.platform, path: r.path })),
    items,
    summary
  };
}

async function dirExists(dirPath) {
  try {
    const stat = await fs.lstat(dirPath);
    return stat.isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** 建 junction（Windows 目录链接，普通权限即可）。 */
async function makeJunction(linkPath, target) {
  await fs.symlink(target, linkPath, 'junction');
}

/**
 * 执行统一。返回 { manifest, manifestPath }。仅在 --apply 调用。
 */
async function applyUnify(plan) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(plan.centralDir, BACKUP_DIRNAME, timestamp);
  await fs.mkdir(backupRoot, { recursive: true });

  const manifest = {
    version: 1,
    timestamp,
    centralDir: plan.centralDir,
    backupRoot,
    moved: [],
    junctioned: [],
    removedDuplicates: [],
    backedUp: []
  };

  for (const item of plan.items) {
    // 1) 正本进中央
    if (item.centralAction === 'move-to-central') {
      if (await dirExists(item.centralPath)) {
        const backupPath = path.join(backupRoot, 'central-conflict', item.name);
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.rename(item.centralPath, backupPath);
        manifest.backedUp.push({ from: item.centralPath, to: backupPath });
      }
      await fs.mkdir(path.dirname(item.centralPath), { recursive: true });
      await fs.rename(item.canonical.sourcePath, item.centralPath);
      manifest.moved.push({ from: item.canonical.sourcePath, to: item.centralPath });
    }

    // 2) 各 IDE 目录建/替换 junction
    for (const link of item.links) {
      if (link.action === 'create-junction') {
        if (await dirExists(link.linkPath)) continue;
        await makeJunction(link.linkPath, link.target);
        manifest.junctioned.push({ linkPath: link.linkPath, target: link.target });
      } else if (link.action === 'replace-with-junction') {
        // 正本已搬走，原位建链接；若竞态下仍存在且非链接，保留不覆盖
        if (!(await dirExists(link.linkPath))) {
          await makeJunction(link.linkPath, link.target);
          manifest.junctioned.push({ linkPath: link.linkPath, target: link.target });
        }
      } else if (link.action === 'replace-duplicate') {
        // 内容与中央相同的重复副本：挪进备份（不直接删），原位换成链接；回滚可还原。
        const stat = await fs.lstat(link.linkPath).catch(() => null);
        if (stat && stat.isDirectory() && !stat.isSymbolicLink()) {
          const backupPath = path.join(backupRoot, 'removed-duplicates', link.rootId, item.name);
          await fs.mkdir(path.dirname(backupPath), { recursive: true });
          await fs.rename(link.linkPath, backupPath);
          manifest.removedDuplicates.push({ from: link.linkPath, to: backupPath });
          await makeJunction(link.linkPath, link.target);
          manifest.junctioned.push({ linkPath: link.linkPath, target: link.target });
        }
      }
      // skip-local：保留本地分叉旧版，不动。
    }
  }

  const manifestPath = path.join(backupRoot, 'manifest.json');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath };
}

/** 按 manifest 回滚。 */
async function rollbackUnify(manifest) {
  // 先删建的 junction
  for (const entry of [...(manifest.junctioned || [])].reverse()) {
    try {
      await fs.lstat(entry.linkPath);
      await fs.rm(entry.linkPath, { recursive: false, force: false });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // 先把搬进中央的正本搬回原位（腾出中央路径），再把中央旧版备份搬回。
  for (const entry of [...(manifest.moved || [])].reverse()) {
    await fs.rename(entry.to, entry.from);
  }
  for (const entry of [...(manifest.backedUp || [])].reverse()) {
    await fs.rename(entry.to, entry.from);
  }
  // 被替换成链接的重复副本，从备份搬回原位。
  for (const entry of [...(manifest.removedDuplicates || [])].reverse()) {
    await fs.rename(entry.to, entry.from);
  }
  await fs.rm(manifest.backupRoot, { recursive: true, force: true }).catch(() => {});
}

module.exports = {
  BACKUP_DIRNAME,
  CENTRAL_ROOT_ID,
  LINK_TARGET_ROOT_IDS,
  applyUnify,
  buildUnifyPlan,
  rollbackUnify
};
