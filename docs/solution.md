# Skill Packer 方案总览

> 本文是产品重构的唯一依据。与代码冲突时以本文为准，改动本文需同步更新 `README.md`。

## 0 一句话

**Skill Packer：为每个项目启用刚刚好的 Skills，并将整套 Agent 工作流一键打包分享。**

它不是 Skill 仓库，而是 **Agent 环境管理器**。仓库只是底座。

### 不做的事

- 不做 Skill 编辑器和 IDE。
- 不做封闭生态：工作流包导出的产物必须能被不使用 Skill Packer 的人原生安装。
- 不替用户执行删除或合并。只给建议，最终由用户确认。
- 不上传对话内容、不采集 Skill 的使用语境。只上传调用次数。

### 市场位置

完整竞品名单、重叠矩阵与来源见 [`docs/competitors.md`](competitors.md)，此处只记结论。

**早期判断"没有人在做治理层"已被证伪，需收窄。** 现状：

- 分发层饱和（Vercel Skills、腾讯/讯飞 SkillHub、skills.sh、SkillsMP 等）。
- **中央仓库 + 软链接 + 项目 Manifest/Profiles + Windows Junction 已有强竞品**
  （Skills Manager 4.7k stars、omrikais/skill-manager、Agent Skill Hub）。
- **审计层已被 `skill-cleaner` 占据且更精确**（算法对齐 Codex 官方源码，
  覆盖预算、重复、闲置、根目录、描述精简）。
- 团队同步层被腾讯 TeamAI CLI 占据（方向相反：多人一套 vs 我们的一人多套）。
- 单平台内的项目启停，TRAE / WorkBuddy 等平台正在原生补齐。

**经得起检验的空位只剩五条**（详见 competitors.md §4）：

1. 区分 **已安装 / 已激活 / 真实调用** 三类统计——无人做，且是 AI 整理可信度的前提。
2. **AI 生成可执行的整理方案与 Diff**，而不只是检测出重复项。
3. **落盘前 diff 预览 + 一键回滚**，把变更做成事务。
4. **工作流级复现**（一整套环境，而非待安装的 Skill 名单）。
5. **跨工具统一视图 + 零安装入口**（现有竞品全是桌面 GUI 或单平台）。

因此定位改为：

> **Skill Packer 是面向项目的 Agent 工作流环境管理器。**
> 不与任何 Skill 市场正面竞争数量，把它们当上游源，专注
> **导入 → 整理 → 组合 → 隔离 → 激活 → 分享 → 复现**。

**护城河不是功能多，是闭环。** 审计（别人有）→ 决策 → 落盘 → 回滚，
只有后三段是我们独占的，而这三段会产生沉淀：用户的启用集与包一旦存在这里，
迁移成本就产生了。

**三条纪律**：不要把"体检"当核心卖点（开源工具已更强）；
不要讲"团队协同"（TeamAI CLI 主场）；
必须跨工具（单平台能力会被原生吞掉）。

## 1 三层对象模型

| 层 | 定义 | 载体 | 变化频率 |
|---|---|---|---|
| Skill | 最小能力单元 | `SKILL.md` 目录 | 低 |
| 工作流包 | 用途固定、版本锁定的 Skill 组合 | `workflow_packages` + `package_items` | 中 |
| 项目环境 | 某个项目实际启用的包/技能集合 | 项目下 `.agents/skills` | 高 |

关键约束：工作流包引用的是 `(skill_id, version_hash)`，不是 `skill_id`。这样包才可复现——
Skill 内容变了，旧包仍然指向旧版本。

## 2 三条能力通道（架构核心）

所有本地能力必须归入以下三条通道之一，**信任边界不得混用**（具体载体可以演进）。

| 通道 | 载体 | 能做什么 | 不能做什么 | 用户要装什么 |
|---|---|---|---|---|
| **A 只读（网页）** | 网页 + File System Access API | 读用户点选的目录、本地分析、就地出报告 | 遍历未授权目录、写文件、联网上传 | 不用装 |
| **B 只读（命令行）** | 单文件 Node 脚本 / npm 包 | 全量扫描、dry-run 预演、可进 CI | 改本机 Skill 配置 | 不用装（需 Node） |
| **C 本地可信宿主** | Electron 桌面应用（首选）<br>或 浏览器扩展 + Native Messaging | 读受管目录；**后续**建/删符号链接、写 `config.toml`、落盘与回滚 | 被网页直接调用 | 装宿主（桌面版 / 扩展 + 宿主） |

三条原则：

1. **A 与 B 永不申请写入权限。** 它们的权限叙事是"你自己跑、自己看"。A 完全被动（浏览器授权哪个目录就读哪个），
   B 是被用户显式执行的脚本。
2. **只有 C 可以修改受管目录**，且每次写入前必须 Diff 预览、明确确认，并支持回滚。
   当前版本（M1）的 C **只启用了读取能力**：能扫、能分析，但不建链接、不改配置、不删文件。
3. **信任边界不可混用**——A/B 不得暗中获得写入能力，C 也不得把"被网页调用"当作正常路径。
   但**载体可以演进**：C 从"扩展 + Native Messaging"扩展为"本地可信宿主"，
   是因为桌面应用在 Windows 上是普通用户唯一能走通的安装路径。

### 2.1 为什么 C 的载体是桌面应用

上一版把 C 钉死成"扩展 + Native Messaging"，理由是"要替换掉不安全的本地 HTTP 服务"。
这个理由依然成立，但它推导不出"必须是浏览器扩展"——只推导出**宿主必须由用户主动安装、且网页够不着**。

于是：

- 桌面应用同样满足"用户主动安装 + 网页够不着"，而且**额外消掉了两件事**：
  不需要本地 HTTP + hash 配对（§11 缺陷 #2），也不需要浏览器扩展权限叙事。
- 桌面应用可以直接落地"服务化"能力：常驻、开机自启、右键菜单、Diff 窗口、回滚快照。
  这些在浏览器扩展里都做不了或做得很难看。
- 扩展 + Native Messaging 保留为**备选载体**：无桌面版可用的平台（纯 Linux 无 GUI 环境等），
  或需要"从网页一键唤起本机动作"的场景。

**因此"用 C 去解决用户不敢装 A"仍然是方向错误**：装桌面应用比装只读网页助手重得多。
桌面版的定位不是"降低安装门槛的替代品"，而是**降低持续使用成本**——
装一次之后不用再下脚本、不用再开命令行、不用每次重新选文件夹。

零安装入口依然保留且不弱化：`/scan/`（A 通道，浏览器直接读你点选的目录）
与 `bin/skill-packer.js`（B 通道，面向自动化与 CI）。

### 2.2 Node 侧只有一份扫描实现

`src/scanner/index.js` 是 Node 侧**唯一**的扫描内核，B 通道 CLI（`bin/skill-packer.js`）
与 C 通道宿主（Electron 主进程）都调用它。此前 helper 里那份重复实现已删除。

A 通道（`src/web/app.js` 与 `src/web/scan/scan.js`）物理上无法 require 这个模块
（跑在浏览器里），所以它天然是第二份实现——但两侧的语义由
`test/scanner.test.js` 的契约测试兜住，重点覆盖 §11.1 的四条不可让步约束。

## 3 首页信息架构

主入口固定为五项，现有页面全部下沉为内部能力。

| 入口 | 职责 | 主要通道 |
|---|---|---|
| Skill 库 | 统一仓库：全部 Skill 的收纳、版本、内容与体检 | A / B |
| 工作流包 | 组合、版本锁定、用途说明、导出与分享 | — |
| 项目环境 | 每个项目的启用集：启用/停用/切包、变更预览、回滚 | A + C |
| AI 整理 | 重复、语义重叠、冲突、合并建议、组合建议 | — |
| 社区 | 包的公开分享与一键复现 | A / B |

## 4 数据模型

现有 `skills → skill_versions → skill_files` 保留，新增四个对象。

```text
-- 保留
skill_users(id, email, ...)
skills(id, owner_id, normalized_name, visibility, updated_at)
skill_versions(skill_id, version_hash, created_at)
skill_files(skill_id, version_hash, path, content BYTEA)   -- 需按 §7 收窄

-- 新增
workflow_packages(id, owner_id, name, purpose, visibility, created_at)
package_items(package_id, skill_id, version_hash, position)  -- 锁定版本
project_environments(id, owner_id, project_key, name, local_path, tool, created_at)
environment_packages(environment_id, package_id, pinned_at)
apply_records(id, environment_id, status, plan JSONB, result JSONB, applied_at)
usage_events(id, skill_id, event, at)   -- event: installed | activated | invoked
```

三类事件必须严格区分，不得混用（竞品普遍把 activated 当成使用频率）：

| 事件 | 含义 | 能说明什么 |
|---|---|---|
| `installed` | 进了本地清单 | 只说明装了，不说明有用 |
| `activated` | Agent 加载了完整 SKILL.md | 说明匹配成功，不代表真用了 |
| `invoked` | 任务确实按它执行（显式调用可确定，隐式只能置信估计） | 真实使用 |

两条设计说明：

- `project_environments.project_key` 是**稳定标识**，不能直接用路径。目录一挪环境就断了。
- `apply_records.plan` 存落盘前的完整计划，是回滚的依据，也是"操作前展示变更"的凭据。

## 5 项目环境落盘流程

写入通道的一次完整事务，任何一步失败都要能退回原状。

```text
探测 (A)  →  生成计划  →  展示预览  →  用户确认  →  落盘 (C)  →  记录  →  可回滚
```

计划对象：

```json
{
  "environmentId": "...",
  "projectKey": "...",
  "tool": "codex",
  "actions": [
    { "kind": "link",    "skillId": "...", "versionHash": "...", "to": ".agents/skills/x" },
    { "kind": "unlink",  "skillId": "...", "from": ".agents/skills/y" },
    { "kind": "disable", "skillId": "...", "reason": "全局技能，本项目不需要" }
  ],
  "conflicts": [{ "name": "sites-building", "scopes": ["项目", "用户级"] }],
  "summary": { "add": 3, "remove": 1, "unchanged": 12 }
}
```

落盘手段（按优先顺序）：

1. **符号链接**：语义最正确，保留"唯一真源"。Windows 需开发者模式或管理员权限。
   **必须逐条建链**（`skills/<name>` → 真源目录），不能把 `skills` 整个目录软链到别处：
   Codex 对整段软链不生效（见 §6.1），Claude Code 只在条目级声明支持 symlink。
2. **junction**：无特权要求，Node 将 junction 也报告为 symbolic link，Codex 同样跟随。作为降级方案。
3. **复制**：**禁止**。会让项目里的 Skill 变成副本，破坏单一真源。
4. **硬链接**：禁止。不跨盘、不支持目录。

### 5.1 跨工具"公用"的正确形态

不存在"所有工具都读的公共目录"——每个工具只扫自己的路径（Codex `.agents/skills` /
`.codex/skills`，Claude Code `.claude/skills/`）。所以"一键公用"只能是
**真源一份 + 向各工具目录逐条建链**；只有共同目录、没有各工具入口并不够。

- **移动必须原位补链接**：裸移动（搬走后原位留空）禁止——原路径当场失效，项目环境标识
  与环境记录全部错位。`src/unify.js` 的 `replace-with-junction` 是正确的形态：
  正本搬进中央，**原位立刻建 junction 指回**，路径不失效。
- **集中库是当前统一模式**：真源归置到 `shared-agents` 根，每一步都有备份与 manifest。
- **一对多**：同一次落盘可以对多个工具各建一条链；同一真源被多处链接时，
  Claude Code 只加载一次（§6.1），Codex 侧按各自路径各计一次，统计口径要分开记。

### 5.2 现有实现与本机实测（2026-09-21）

桌面应用与 B 通道 CLI 都已落地：桌面端两次确认，CLI 的 `unify` 默认只打计划，
`--apply` 才动盘，`--rollback <manifest>` 还原；核心实现在 `src/unify.js`。

- 中央根：`shared-agents`（`~/.agents/skills`）。适配器覆盖 Codex、Claude Code、Cursor、
  WorkBuddy、豆包和 Trae；只对本机已存在且链接兼容性已验证的个人根建链，不创建缺失 IDE
  目录。Trae 当前只扫描，不自动迁移。
- 建链方式：`fs.symlink(target, linkPath, 'junction')`，**逐条建在 `<root>/<name>` 上**，
  与 §5 的"禁止整段软链"一致。
- 去重分两层：同名 + 内容指纹（frontmatter 的 `name:` 行归一化，可识别改名副本），
  并查集合并成组；同名但内容不同 = 真冲突，默认整组阻断，用户明确选择正本后才备份替换。
- 回滚：manifest 记录 moved / junctioned / removedDuplicates / backedUp；删链接用
  `fs.rm(linkPath, { recursive: false })`——**非递归，不会穿透到真源**，这点必须保持。

本机只读实测：扫描到系统 / 插件 Skill 184 个、个人 Skill 143 个；统一预览包含 43 组个人
Skill、0 个系统项。开发态与打包产物均完成真实 Electron 页面、IPC 扫描和统一预览验收。

停用全局技能使用原生机制，不删文件：

```toml
# ~/.codex/config.toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

降噪（保留显式调用）改 Skill 自己的元数据，且**只作为建议输出，不自动改用户原件**：

```yaml
# <skill>/agents/openai.yaml
policy:
  allow_implicit_invocation: false
```

## 6 Codex 机制（设计依据）

已核对官方文档，以下事实决定了方案的可行性：

| 机制 | 事实 | 对方案的影响 |
|---|---|---|
| 扫描顺序 | `$CWD/.agents/skills` 逐级向上 → `$REPO_ROOT` → `~/.agents/skills` → `/etc/codex/skills` → 内置 | 项目级隔离成立 |
| 符号链接 | 会跟随链接目标 | §5 的落盘手段成立 |
| 渐进披露 | 初始只加载 name + description + 路径；上限约上下文窗口 2%，未知时 8000 字符 | 隔离有实际收益，且可量化 |
| 超限行为 | 先缩短 description，再多则从列表省略部分 Skill 并警告 | 描述体检是 AI 整理的第一项能力 |
| 同名处理 | **不合并**，两个都出现在选择器里 | 重复检测必须带作用域，不能只按 name 去重 |
| 停用 | `~/.codex/config.toml` 的 `[[skills.config]] enabled=false` | 停用不必删文件 |
| 降噪 | `agents/openai.yaml` 的 `allow_implicit_invocation` | 存在"启用/停用"之间的中间态 |
| 分发单元 | Skills 是创作格式，**Plugins 是分发单元** | 工作流包导出必须产出 Plugin 结构 |

### 6.1 Claude Code 机制（设计依据）

跨工具落盘必须同时满足两侧事实。以下核对自官方文档（2026-09-20），只记影响实现的部分：

| 机制 | 事实 | 对方案的影响 |
|---|---|---|
| 发现路径 | `~/.claude/skills/`、项目 `.claude/skills/`、嵌套 `<subdir>/.claude/skills/`、`--add-dir` 目录、plugin `skills/`、企业托管目录、`~/.claude/skills/synced/` | **`.agents/skills` 对 Claude 不可见**，落盘必须写到 `.claude/skills/` |
| 符号链接 | 条目级支持：`skills/<name>` 可为 symlink，跟随目标读 `SKILL.md`；多处指向同一目标只加载一次 | §5 的逐条建链成立；同一真源多处链接不会重复计数 |
| 整段软链 | 官方只声明条目级；社区实测 Codex 整段软链 `~/.codex/skills` 完全不加载 | 落盘实现禁止整段链接，必须逐条 |
| 嵌套目录 | 启动目录向上到仓库根逐级加载；更下级目录等首次读写该目录文件才加载 | 项目级落盘优先写到仓库根的 `.claude/skills/` |
| 列表预算 | `skillListingBudgetFraction` 默认 0.01（上下文 1%）；单条 description+when_to_use 上限 1536 字符；溢出时**保留全部 name，从调用最少的开始丢 description** | 被丢的不能自动触发，只能手动 `/name`；落盘要给出占用估算 |
| 同名冲突 | enterprise > personal > project > 内置，同名静默替换内置 Skill，无警告 | 落盘前必须查同名，冲突要在计划里显式列出 |
| 停用 | 无等价的 `enabled=false`；可用 `disable-model-invocation`、`user-invocable`、`skillOverrides` 或插件启停 | "停用"在两侧不是同一个动作，环境模型要按工具分支 |
| 云端会话 | Cowork / cloud 会话不读本机 `~/.claude/skills/`，只认账户同步与仓库内提交的 | 落盘结果对云端会话不保证生效，界面需如实说明 |

## 7 权限与信任模型

信任来自机制，不来自声明。以下每条都对应一个具体动作，不做无法验证的承诺。

| 原则 | 落地方式 |
|---|---|
| 最小授权 | 删除 home 级自动扫描，只读用户点选的目标目录 |
| 操作前展示变更 | 任何写入先出计划与 diff，确认后才落盘 |
| 默认不动原件 | 删除/合并/改元数据只给建议；不删用户文件 |
| 上传可见可控 | 上传前出待处理清单，逐项可取消 |
| 脚本默认不外传 | `scripts/` 下的可执行代码默认不上传 |
| 纯本地模式 | 完全不出网，报告就地生成。作为首启默认 |
| 凭据不走 URL | 配对码改为用户手动粘贴，不使用 URL hash |
| 每次写入可确认 | C 通道的每次操作本地弹窗 |
| 可审计 | 提供"我做了什么"本地日志面板，读取路径与出网记录 |
| 可卸载 | 卸载时清理配对令牌与宿主残留，展示"改过哪些文件" |
| 可校验 | CLI 以 npm provenance 分发，用户可验证构建来源 |

### 上传边界的一个真实取舍

"默认只传文档"和"包要可复现"存在张力：不传脚本，别人就无法完整重建这个包。

采用的方案是**分层上传**：

| 内容 | 是否上传内容 | 上传什么 |
|---|---|---|
| `SKILL.md` 与文档类 | 是 | 完整内容 |
| `scripts/` 与资源类 | 否 | 路径 + 大小 + **SHA-256 清单** |

这样云端能做一致性校验、能提示"你缺这个版本"，但不能替用户重建——
这是诚实的取舍，必须在界面上明说，不能让用户以为传上来的是完整包。

## 8 AI 整理的能力边界

| 能力 | 可行性 | 依赖 |
|---|---|---|
| 重复检测 | 直接可做 | Skill 内容 |
| 语义重叠分析 | 直接可做 | name + description + SKILL.md |
| 冲突分析 | 直接可做 | 需带作用域（同名不合并） |
| 合并建议 | 直接可做，仅建议 | Skill 内容 |
| 工作流组合建议 | 直接可做 | 描述 + 共现关系 |
| 描述体检（过长/缺失/触发词后置） | 直接可做 | 描述 |
| **真实使用频率** | **需要本地记录** | 调用事件，API Key 无法提供 |

统计必须区分 **installed / activated / invoked** 三类，不得把激活次数包装成使用频率
（竞品普遍犯这个错，见 `competitors.md` §3）：

| 现象 | 判断 | 建议 |
|---|---|---|
| installed 但从未 activated | 装了从没被选中 | 候选：停用或改 description |
| activated 但很少 invoked | 匹配成功但没真用上 | 候选：收窄描述或关隐式调用 |
| 长期只能靠 `$name` 显式触发 | description 没写清 | 改写描述、前置触发词 |
| invoked 高 | 真正在用 | 纳入团队偏好，建议进工作流包 |

只统计总次数做不出以上任何一条判断。

AI 只输出建议，不执行删除或合并。

#### 交给模型的数据边界（2026-09-20 落地）

模型只能看到编号（`s1`、`s2`…），看不到路径；发什么是可枚举的，不是"按需抓"：

| 内容 | 默认 | 额外勾选 | 理由 |
|---|---|---|---|
| name / description / 平台 / 作用域 / 内容哈希 / 文件数 / 体积 / 修改日期 / 被引用次数 | 发 | — | 判断重复所需的最小集合 |
| 目录路径 | **不发** | 不发 | 带用户名与磁盘布局；描述与正文里的路径还要再脱敏一层 |
| 文件清单、脚本内容 | **不发** | 不发 | §7 分层上传的同一条边界 |
| SKILL.md 正文摘要 | 不发 | 发（默认 800 字） | 语义判断才需要；只发 SKILL.md 本身 |

反方向同样要管：模型的输出**逐条核对**后才显示——编号必须存在、必须同属一个候选组、
必须给出依据。对不上的整条丢弃并如实计数，不把幻觉当事实。

出网条件是三重闸门：设置里的「允许发送」默认关闭 → 发送前展示将要发的载荷 → 点确认才发。
粗筛与预览任何时候都不出网。API Key 明文存本机 settings.json，与云端会话令牌同级处理。

## 9 分享与复现

工作流包的导出产物必须能被不使用 Skill Packer 的人原生安装。

| 通道 | 形式 | 适用 |
|---|---|---|
| Codex Plugin | `skills/` 目录 + 可选 MCP 配置与展示资源 | 正式分发 |
| Git | `git clone` 到项目 `.agents/skills` | 谨慎用户、企业 |
| `$skill-installer` | Codex 内置安装器 | 单个技能试用 |
| npx | `npx skill-packer@<版本> scan` | 命令行用户、CI |

CLI 分发的三条硬要求：

1. 版本号写死，不用 `latest`。
2. 发布带 provenance（GitHub Actions 从公开 commit 构建并签名）。
3. 文档写"下载 → 看一眼 → 运行"三步，**禁止 `irm | iex` 这类管道执行**。

## 10 与现有代码的映射

| 文件 | 现状 | 处置 |
|---|---|---|
| `src/web-server.js` | 1049 行：PostgreSQL 仓储、SSO、skills API、静态服务 | **改造**：新增四个对象的路由；`skill_files` 按 §7 收窄；`/api/cli/info` 与 `/cli/skill-packer.js` 保留 |
| `src/web/app.js` | 1473 行：单页逻辑，围绕"扫描并上传单个 Skill" | **重写**：围绕"工作流包"与"项目环境"重构，保留账号、社区、同步逻辑 |
| `src/web/helper/skill-packer-helper.js` | 430 行：本地 HTTP 服务，`/v1/health`、`/v1/scan`，返回全量文件内容 | **改造或废弃**：安全模型不合格；若保留则收敛为 C 通道宿主，去掉扫描职责 |
| `bin/skill-packer.js` | 427 行：只读扫描 CLI，复用 `scanRoots` | **保留并扩展**：作为 B 通道 |
| `src/web/scan/*` | 只读展示页，File System Access 本地分析 | **保留**：作为 A 通道 |
| `deploy/*` | 发布包走 `git ls-files`，Supervisor + Funnel | **保留**，补 Windows 签名打包 |
| `test/*` | 7 项测试，含新增的公网路由测试 | **保留并扩展** |

可复用的既有能力：`scanRoots` / `parseFrontmatter` / `computeVersionHash` / 版本哈希与上传校验逻辑。

## 11 必须先修的既有缺陷

按严重度排序，全部与方案直接冲突。

| # | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| ~~1~~ | ~~扫描器显式跳过符号链接~~ | `walkForSkills`、`collectDirectoryFiles` | **已于 2026-09-16 修复**：两处 Node 扫描器改为受控跟随链接（见下方 §11.1） |
| ~~2~~ | ~~配对令牌走 URL hash，且放行 `Allow-Private-Network`~~ | `openPairedPage`、CORS 头 | **桌面形态下已消解（2026-09-18）**：主进程与渲染进程直接走 `contextBridge` IPC，不再有本地 HTTP 服务，也没有可被网页拿到的令牌。B 通道 CLI 仍是可选入口，其 `#helper=<token>` 配对仅在本机自动化场景使用 |
| 3 | `/v1/scan` 返回全量文件内容（含脚本） | `createLocalSkill` | 与 §7 上传边界冲突 |
| 4 | home 级目录自动扫描 | `DEFAULT_ROOTS` | 与 §7 最小授权冲突 |
| ~~5~~ | ~~分发依赖 `npm run helper`~~ | 无 Windows 打包 | **已于 2026-09-18 修复**：新增 Electron 桌面应用（`src/main.js` + preload + renderer），`npm run dist` 产出 NSIS 安装包；首页引导改为"下载桌面版"，不再让用户复制 PowerShell 命令 |
| 6 | CSP 无 `unsafe-inline` | `serveStatic` | **新增页面必须外链 CSS/JS**，属约束非缺陷 |

链接相关补充：`dedupeByDirectory` 原先按**逻辑路径**去重，同一个目录同时以
`.agents/inner-link`（链接）与 `.agents/skills-real/inner`（真实路径）被发现时会留下两个实例。
现已改为按 `realDirectoryPath`（扫描期已缓存的 realpath）去重，逻辑路径仍只用于版本哈希（约束 3）。

### 11.1 跟随符号链接的既定策略（2026-09-16 定）

缺陷 #1 修完后，链接处理按以下规则执行，后续 M2 的落盘逻辑依赖这套行为：

| 场景 | 行为 | 记到哪个桶 |
|---|---|---|
| 链接目标在任一扫描根内 | 跟随 | `followed` |
| 链接目标在所有扫描根之外 | **跟随**（不拒绝） | `outsideRoot`，并在报告里逐条列出真实目标 |
| 链接目标不存在 | 跳过，不计入版本哈希 | `broken` |
| 目标目录在本次遍历中已读过 | 跳过（防环、防重复入哈希） | `cycle` |
| 目标读不到（多为权限） | 跳过 | `denied` |
| `--no-follow-links` | 不跟随 | `notFollowed` |

四条不可让步的约束：

1. **默认跟随。** 隔离的形态就是"链接进项目目录"，默认不跟随等于功能自残。
2. **不拒绝跳出扫描根的链接。** 隔离必然跳出项目目录（中央仓库在项目之外），
   硬拒绝会让整套隔离失效；代价用透明度补——每个外部目标的真实路径都进报告。
3. **哈希与上传一律用逻辑路径**，不用 realpath 路径——同一个 Skill 从不同链接位置
   被发现时必须得到同一个版本哈希。
4. **同一个链接在一次扫描里只记一次。** 入口遍历与文件收集都会碰到它，重复计数会让
   报告失去可信度。

浏览器侧（`src/web/scan/scan.js`、`src/web/app.js`）走 File System Access，
该 API 不暴露符号链接信息，**无法跟随**。Node 与浏览器两条路径的结果可能不一致，
这一点必须在各自界面上说清楚，不能笼统地声称"已扫描"。

## 12 路线图

每期给出可验收的交付物，不做无法验证的里程碑。

### M1 扫描与体检 — 已完成

交付：
- **C 通道：Electron 桌面应用**（`src/main.js` + `src/preload.js` + `src/renderer/`），
  `contextIsolation` + `sandbox` + 无 `nodeIntegration`，全部本机能力经白名单 IPC。
- `bin/skill-packer.js`（B 通道 CLI）、`/scan/` 展示页（A 通道）、`/api/cli/info` 与 `/cli/skill-packer.js`。
- **共享扫描内核** `src/scanner/index.js`，CLI 与桌面宿主共用，并用 `test/scanner.test.js` 兜住 §11.1 语义。

验收：CLI 在无 Node 依赖的普通机器上可跑（仅需 Node）；报告含预算、重复、描述体检；展示页零安装可用；测试覆盖。
桌面版可读取 11 个默认根，并区分系统 / 插件与个人 / 下载来源。

待补：安装包接入真实签名与自动更新；CLI 发布到 npm 并带 provenance。

### M2 统一技能库 — 已完成

交付：IDE 适配器注册表、只读计划、系统项隔离、内容去重、冲突选择、逐 Skill Junction、
执行前重扫校验、增量 manifest 与回滚。

验收：110 项发布范围测试通过；开发态与打包产物的 Electron smoke 均能渲染真实扫描结果并生成统一预览。

待继续：项目级启用 / 停用、按项目预算选择、幂等 apply 记录。

### M3 工作流包

交付：包的创建与编辑、版本锁定、导出 Codex Plugin 结构、导入。

验收：导出的 Plugin 能被不使用 Skill Packer 的 Codex 原生安装；Skill 内容更新后旧包仍指向旧版本。

### M4 AI 整理

交付：重复、语义重叠、冲突、合并建议、组合建议、描述体检；`usage_events` 采集与统计。

验收：每条建议都能给出依据（哪两个 Skill、在哪个作用域、为什么）；不自动执行任何删除或合并。

前置：需要 `usage_events` 有足够数据积累。

**2026-09-20 进度：部分落地。** 已交付：本地候选粗筛（同名 / 同内容哈希 / 语义相似三类）、
载荷构造与脱敏、用户自带 OpenAI 兼容端点端上直连、模型输出逐条核对、建议界面与导出。
未做：描述体检、工作流组合建议、`usage_events` 采集——组合建议依赖共现数据，
在 `usage_events` 落地前做出来也只是猜。

### M5 社区与复现

交付：包的公开分享、一键复现到本地项目、包依赖与缺失提示。

验收：陌生用户能从一个包链接复现出等价的项目环境，且过程中能看到每个 Skill 的来源与版本。

## 13 待拍板的决策

方案里唯一还无法单方面决定的部分。

| # | 决策点 | 选项 | 我的倾向 |
|---|---|---|---|
| 1 | `project_key` 从哪来 | git remote + 相对路径 / 路径哈希 / 用户手填 | git remote 优先，退化到路径哈希 |
| 2 | 项目级启用如何表达 | 项目内链接 / IDE 配置 / 二者结合 | 优先项目内链接，IDE 特例由适配器处理 |
| 3 | 云端是否存二进制 | 继续存 BYTEA / 只存文本与哈希清单 | 只存文本与哈希清单（§7） |
