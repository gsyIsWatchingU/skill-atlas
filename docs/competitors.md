# 竞品调研

> 调研时间 2026-09-14（用户侧）与 2026-09-15（本轮补充），两份合并。
> 完整竞品清单与重叠矩阵见本文；对定位的影响见 `docs/solution.md` §0。

## 0 两份调研的合并说明

用户侧调研（2026-09-14）覆盖了桌面 GUI 与项目隔离类竞品，本轮补充了三个
**被两侧单独调研都漏掉的对象**。两份都必须看，否则结论会偏。

| 来源 | 找到了 | 漏了 |
|---|---|---|
| 用户侧（09-14） | Vercel Skills、Skills Manager、讯飞/腾讯 SkillHub、Agent Skill Hub、omrikais/skill-manager、skills-mgr、skill-cli、thesash/skill-hub、Tessl | `skill-cleaner`、TeamAI CLI、IDE/平台原生能力 |
| 本轮（09-15） | `skill-cleaner`、TeamAI CLI、TRAE/WorkBuddy/CodeBuddy 原生 | 上述全部桌面 GUI 与项目隔离类竞品 |

**一处命名纠正**：用户侧调研把 "teamcli" 归为"没有唯一对应项目"，按最接近的
Tessl 处理。实际上 **TeamAI CLI（`Tencent/teamai-cli`）就是它**——腾讯 2026-09-07
开源，MIT，约 3k stars，支持 11 个 agent。这条单独见 §2。

## 1 竞品全景

| 竞品 | 核心能力 | 主要缺口 | 威胁 | 来源 |
|---|---|---|---|---|
| [Vercel Skills](https://github.com/vercel-labs/skills) | 31.6k stars；75+ agent、项目/全局安装、软链接、临时使用、Packs、市场 | 更像通用安装器，没有完整的项目配置集与 AI 治理 | 极高，生态入口 | 用户侧 |
| [Skills Manager](https://github.com/xingkongliang/skills-manager) | 4.7k stars；桌面 GUI、中央仓库、Preset、项目 Workspace、Windows、Git 多端同步 | Preset 是一次性部署，不是可持续同步的工作流包；无语义合并与真实调用统计 | **最高，最直接竞品** | 用户侧 |
| [讯飞 SkillHub](https://github.com/iflytek/skillhub) | 5.1k stars；开源私有化、版本、RBAC、审计、团队命名空间、CLI | 偏企业 Registry，不解决个人电脑上的项目隔离 | 高 | 用户侧 |
| [腾讯 SkillHub](https://github.com/Tencent/skillhub) | 中国市场、搜索推荐、安全认证、TRACE 评测、企业私有库；自称收录 13 万+ | 核心仍是市场、评测与分发 | 高，国内流量入口 | 用户侧 |
| [Agent Skill Hub](https://doc.agentskillhub.dev/guide/cli.html) | Web + CLI、Skillset、分享、版本锁定、GitHub 导入、**Windows Junction**、Doctor | Skillset 是安装集合，没有智能项目匹配与工作流验证 | 高，工作流包分发 | 用户侧 |
| [omrikais/skill-manager](https://github.com/omrikais/skill-manager) | 中央仓库、软链接、**项目 Manifest、Profiles**、依赖、历史、MCP、Packs、统计 | 仅 macOS/Linux；7 stars；TUI；"使用次数"记录的是自动激活而非真实调用 | 中，功能高度重合 | 用户侧 |
| [yusing/skills-mgr](https://github.com/yusing/skills-mgr) | 按语言、依赖、工具链为项目动态筛选 Skill | 无 Web、无团队分享、无 AI 分析；2 stars | 中，隔离思路先进 | 用户侧 |
| [skill-cli](https://github.com/VictorTomaili/skill-cli) | 中央仓库、项目 allow/deny、按需加载、Windows | 通过改写全局 `AGENTS.md` 接入，缺工作流包与云端协作 | 低 | 用户侧 |
| [thesash/skill-hub](https://github.com/thesash/skill-hub) | 中央仓库、跨 agent 软链接、Presets、项目关联 | 0 stars、偏 macOS，卸载未测试 | 低 | 用户侧 |
| [Tessl](https://docs.tessl.io/reference) | Registry、团队 Workspace、**版本化 Tile**、Skill/规则/文档打包、质量评测与 Evals | 强项是研发与发布生命周期，不是本地全量扫描与项目切换 | 高，工作流质量平台 | 用户侧 |
| [**skill-cleaner**](https://github.com/steipete/agent-scripts/tree/main/skills/skill-cleaner) | 预算审计、重复检测、闲置筛查、根目录审计、描述精简；算法对齐 Codex 官方源码 | 只出报告，不落盘、不隔离、不切包、不回滚 | **高，直接占据审计层** | 本轮 |
| [**TeamAI CLI**](https://github.com/Tencent/teamai-cli) | git 仓库为真相源、init/push/pull、SessionStart 钩子自动同步、11 个 agent、MR 评审、角色标签分发 | 是"多人一套"，不是"一人多套"；无本地 diff 预览与回滚 | 高，团队同步层 | 本轮 |
| **IDE / 平台原生**（TRAE、WorkBuddy、CodeBuddy） | TRAE 有全局/项目技能、启用禁用开关、`skill-config.json`；WorkBuddy 企业版有管理后台与 Skills 市场 | 单平台内，不跨工具 | **高，平台在补，会吞掉单平台能力** | 本轮 |

## 2 三个必须单独看的对象

### skill-cleaner —— 审计层已被占，且比我们更精确

`steipete/agent-scripts/skills/skill-cleaner`，Peter Steinberger 开源，免费。
`SKILL.md` 仅 56 行，调用的 Node 脚本近千行。五件事：预算审计、重复检测、
闲置筛查、根目录审计、描述精简。

关键点：预算核算**对齐 Codex 官方源码**——读本地模型缓存取上下文窗口
（GPT-5.5 默认 272k），UTF8 字节 / 4 向上取整，2% 为基数，优先级
系统 > 内置 > 插件 > 仓库自定义，并模拟预算不足时的截断字符与被省略数量。
输出策略是 `Suggest first; edit only when the user asks.`——
和我们的"只给建议"完全一致。

**结论：审计不能作为核心卖点。** 它是入口，不是价值主张。
且我们的预算口径必须与它对齐，否则用户在两个工具间对不上数，反而损害信任。

### TeamAI CLI —— 方向与我们相反，不可对标

腾讯开源，MIT，npm `teamai-cli`，约 3k stars。一个共享 git 仓库当真相源，
注册 SessionStart 钩子自动 `pull`，`push` 走合并请求评审。
管 skills / rules / docs / hooks / env / MCP / agents，落进
`.claude/skills/`、`.codex/skills/`、`.cursor/skills/` 等原生目录。
v0.24 新增声明式团队环境安装与 `~/.teamai/projects` 每项目目录。

**它是"多人 × 一套"（让全队跑一样的技能）；我们是"一人 × 多套"（同一人，
项目 A 与项目 B 各用各的）。** 正交，不是竞争。
但这说明：**不能用"团队协同"讲差异化，那是它的主场。**

### 平台原生 —— 单平台内的事平台会自己做

TRAE 已有全局/项目技能、启用禁用开关（写 `.trae/skill-config.json`）、
支持加载 `.agents/skills/`。腾讯云 WorkBuddy 企业版有管理后台、
Skills 市场直连 SkillHub、"项目"里共享 Skills 与 MCP。

**含义：只在某一个 IDE 内做项目级启停，等于等平台补上就死。
我们的价值必须落在跨工具这一层。**

## 3 重叠矩阵（合并后修正）

| Skill Packer 计划的能力 | 被谁覆盖 | 状态 |
|---|---|---|
| 发现与安装 | Vercel Skills、各 SkillHub、skills.sh | 完全饱和 |
| 中央仓库 + 软链接 | Skills Manager、omrikais/skill-manager、thesash/skill-hub、Agent Skill Hub | **已被覆盖** |
| 项目 Manifest / Profiles | omrikais/skill-manager（项目 Manifest + Profiles） | **已被覆盖** |
| Windows Junction 落盘 | Agent Skill Hub（已做 Windows Junction） | **已被覆盖** |
| 依赖声明 | omrikais/skill-manager（依赖）、Tessl（版本化 Tile） | **已被覆盖** |
| 预算体检 | `skill-cleaner`，算法更精确 | **被超越** |
| 重复 / 语义重叠检测 | `skill-cleaner`（跨 4 层 + 语义） | **被超越** |
| 闲置 / 僵尸技能筛查 | `skill-cleaner`（基于历史日志） | **被覆盖** |
| 版本锁定与质量评测 | Tessl（版本化 Tile + Evals） | **已被覆盖** |
| 团队同步与评审 | TeamAI CLI | **已被覆盖，且方向不同** |
| 单 IDE 内项目启停 | TRAE 原生 | **已被覆盖** |
| **已安装 / 已激活 / 真实调用 三类统计** | 无人区分（omrikais 明确记的是自动激活） | **空位** |
| **AI 生成可执行整理方案 + Diff（不只检测）** | `skill-cleaner` 只给候选清单 | **空位** |
| **落盘前 diff 预览 + 一键回滚** | 无 | **空位** |
| **工作流级复现（一套环境，非安装集合）** | Agent Skill Hub 的 Skillset 是安装集合 | **空位** |
| **跨工具统一视图 + 零安装入口** | 均为桌面/GUI 或单平台 | **空位** |

## 4 剩余空位（比两侧单独判断的都窄）

用户侧判断"相对空白的是：本地全量治理 + 项目级隔离 + 可复现工作流包 +
AI 整理 + 真实使用分析"。合并后需要收窄，其中"项目级隔离"与"AI 整理"
**已有强竞品**，只剩执行层面的空位。

经得起检验的空位只剩五条：

1. **区分已安装 / 已激活 / 真实调用三类统计**——无人做，且这是 AI 整理
   能否给出可信建议的前提。
2. **AI 生成可执行的整理方案与 Diff**，而不只是检测出重复项。
   `skill-cleaner` 停在候选清单。
3. **落盘前 diff 预览 + 一键回滚**，把变更做成事务。
4. **工作流级复现**：接收方拿到的是"完成某件事的一整套环境"，
   不是"一个待安装的 Skill 名单"。
5. **跨工具统一治理 + 渐进式本地能力入口**：单一入口覆盖"零安装快速体检 →
   命令行自动化 → 装一次后持续管理"三段，而不是让用户在一开始就二选一。
   注意这条**不能再写成"只有我们是网页"**——2026-09-18 起 Skill Packer 自己
   也是桌面 GUI（C 通道载体，见 solution.md §2.1），所以差异化不在形态，
   而在**同一个内核同时供给三种形态**：`/scan/`（零安装）、`bin/skill-packer.js`
   （CI/自动化）、桌面版（持续治理、M2 起承担 Diff 与回滚）。
   平台原（TRAE、WorkBuddy 企业版）正在补单平台内的技能管理，
   但它们**不会跨工具**，这条路仍然是空的。

## 5 定位（采纳用户侧表述）

> **Skill Packer 是面向项目的 Agent 工作流环境管理器。**

不与 skills.sh、腾讯或讯飞正面竞争 Skill 数量。把它们当**上游源**，
Skill Packer 专注：

**导入 → 整理 → 组合 → 隔离 → 激活 → 分享 → 复现**

首要对标对象：**Skills Manager 的体验、omrikais/skill-manager 的能力、
skills-mgr 的项目隔离、Tessl 的质量评测**。
外加本轮补充的两条：口径对齐 `skill-cleaner`，以及规避 TeamAI CLI 的主场。

**交付形态（2026-09-18 定）**：桌面应用优先作为安装路径，网页与 CLI 作为零安装入口。
形状上与 Skills Manager（桌面 GUI + 中央仓库）重叠——这不可避免，且必须承认：
差异化不靠"我不是 GUI"，而靠**闭环**（审计 → 决策 → 落盘 → 回滚，后三段独占）
与**跨工具**（单平台内的技能管理会被 TRAE / WorkBuddy 原生吞掉）。

## 6 待办

- [ ] 预算算法对齐 Codex 官方口径（2%、UTF8/4 向上取整、优先级排序）
- [ ] `usage_events` 改为三类事件：installed / activated / invoked
- [ ] 首屏文案从"治理"改为"闭环"
- [ ] 评估直接引用或集成 `skill-cleaner`，而非重复实现
- [ ] 确认 Agent Skill Hub 的 Junction 与 omrikais 的 Profiles 是否已有回滚
