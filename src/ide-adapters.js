'use strict';

/**
 * IDE / Agent Skill 目录注册表。
 *
 * 扫描器只认识 root 描述，不在核心流程里硬编码具体产品；统一引擎只处理
 * `unifyTarget=true` 且本机真实存在的个人目录。系统目录只扫描、永不写入。
 */
const IDE_ADAPTERS = Object.freeze([
  {
    id: 'codex',
    displayName: 'Codex',
    roots: [
      {
        id: 'codex-user', platform: 'codex', scope: 'user',
        label: 'Codex 个人 / 下载 Skill',
        displayPath: '%USERPROFILE%\\.codex\\skills',
        segments: ['.codex', 'skills'],
        unifyTarget: true,
        linkVerified: true
      },
      {
        id: 'codex-plugins', platform: 'codex', scope: 'plugin', system: true,
        label: 'Codex 插件 Skill',
        displayPath: '%USERPROFILE%\\.codex\\plugins\\cache',
        segments: ['.codex', 'plugins', 'cache'],
        unifyTarget: false
      }
    ]
  },
  {
    id: 'shared',
    displayName: '跨 Agent 共享',
    roots: [
      {
        id: 'shared-agents', platform: 'shared', scope: 'user',
        label: '跨 Agent 共享 Skill（统一正本）',
        displayPath: '%USERPROFILE%\\.agents\\skills',
        segments: ['.agents', 'skills'],
        unifyRole: 'central',
        unifyTarget: false,
        linkVerified: true
      }
    ]
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    roots: [
      {
        id: 'claude-user', platform: 'claude', scope: 'user',
        label: 'Claude Code 个人 / 下载 Skill',
        displayPath: '%USERPROFILE%\\.claude\\skills',
        segments: ['.claude', 'skills'],
        unifyTarget: true,
        linkVerified: true
      }
    ]
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    roots: [
      {
        id: 'cursor-user', platform: 'cursor', scope: 'user',
        label: 'Cursor 个人 / 下载 Skill',
        displayPath: '%USERPROFILE%\\.cursor\\skills',
        segments: ['.cursor', 'skills'],
        // Cursor 也会直接读取 ~/.agents/skills；已有 ~/.cursor/skills 时仍保留原位链接，
        // 但目录不存在时不会为它额外造一份冗余入口。
        unifyTarget: true,
        directSharedDiscovery: true,
        linkVerified: true
      }
    ]
  },
  {
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    roots: [
      {
        id: 'workbuddy-user', platform: 'workbuddy', scope: 'user',
        label: 'WorkBuddy 个人 / 下载 Skill',
        displayPath: '%USERPROFILE%\\.workbuddy\\skills',
        segments: ['.workbuddy', 'skills'],
        unifyTarget: true,
        linkVerified: true
      }
    ]
  },
  {
    id: 'doubao',
    displayName: '豆包',
    roots: [
      {
        id: 'doubao-system', platform: 'doubao', scope: 'system', system: true,
        label: '豆包内置 Skill',
        base: 'localAppData',
        displayPath: '%LOCALAPPDATA%\\Doubao\\User Data\\Default\\.doubao\\agent_mode\\workspace\\.skills',
        segments: ['Doubao', 'User Data', 'Default', '.doubao', 'agent_mode', 'workspace', '.skills'],
        unifyTarget: false
      },
      {
        id: 'doubao-user', platform: 'doubao', scope: 'user',
        label: '豆包个人 / 下载 Skill',
        base: 'localAppData',
        displayPath: '%LOCALAPPDATA%\\Doubao\\User Data\\Default\\.doubao\\agent_mode\\workspace\\.user_skills',
        segments: ['Doubao', 'User Data', 'Default', '.doubao', 'agent_mode', 'workspace', '.user_skills'],
        unifyTarget: true,
        linkVerified: true
      }
    ]
  },
  {
    id: 'trae',
    displayName: 'Trae',
    roots: [
      {
        id: 'trae-cn-user', platform: 'trae', scope: 'user',
        label: 'Trae 中文版个人 / 下载 Skill',
        displayPath: '%USERPROFILE%\\.trae-cn\\skills',
        segments: ['.trae-cn', 'skills'],
        unifyTarget: true,
        linkVerified: false
      },
      {
        id: 'trae-user', platform: 'trae', scope: 'user',
        label: 'Trae 国际版个人 / 下载 Skill',
        displayPath: '%USERPROFILE%\\.trae\\skills',
        segments: ['.trae', 'skills'],
        unifyTarget: true,
        linkVerified: false
      },
      {
        id: 'trae-cli-user', platform: 'trae', scope: 'user',
        label: 'Trae CLI 个人 / 下载 Skill',
        displayPath: '%USERPROFILE%\\.traecli\\skills',
        segments: ['.traecli', 'skills'],
        unifyTarget: true,
        linkVerified: false
      }
    ]
  }
]);

const DEFAULT_ROOTS = Object.freeze(IDE_ADAPTERS.flatMap((adapter) => (
  adapter.roots.map((root) => Object.freeze({
    ...root,
    adapterId: adapter.id,
    adapterName: adapter.displayName,
    // 未经本机/官方确认能识别条目级链接的目录只扫描，不参与自动迁移。
    unifyEligible: root.unifyRole === 'central' || (root.unifyTarget === true && root.linkVerified === true)
  }))
)));

const CENTRAL_ROOT_ID = DEFAULT_ROOTS.find((root) => root.unifyRole === 'central').id;

function getAdapter(adapterId) {
  return IDE_ADAPTERS.find((adapter) => adapter.id === adapterId) || null;
}

module.exports = {
  CENTRAL_ROOT_ID,
  DEFAULT_ROOTS,
  IDE_ADAPTERS,
  getAdapter
};
