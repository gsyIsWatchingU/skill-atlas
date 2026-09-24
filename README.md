# Skill Packer

面向项目的 Agent 工作流环境管理器：为每个项目启用刚刚好的 Skills，并把整套 Agent 工作流一键打包分享。

三层对象（Skill / 工作流包 / 项目环境）、能力通道、数据模型、落盘流程与路线图，
见 [`docs/solution.md`](docs/solution.md)。市场位置与竞品判断见 [`docs/competitors.md`](docs/competitors.md)。
本文件描述的是当前已实现的能力。Web 端已停用，桌面云同步保留，见 [停用说明](docs/web-retirement.md)。

## 两种入口，按"要装多少东西"递增

| 入口 | 形态 | 适合谁 | 需要装什么 |
|---|---|---|---|
| **桌面应用** | Electron（C 通道） | 日常使用：扫描、区分来源、统一个人 Skill | 安装包 |
| **命令行 `bin/skill-packer.js`** | 单文件 Node 脚本（B 通道） | 自动化、CI、要链接清单 | 不用装（需 Node） |

两种形态**共用同一份扫描内核** `src/scanner/index.js`（纯 Node，无 Electron、无 HTTP 依赖）。

## 桌面应用（推荐）

不需要下载脚本、不需要开命令行、不需要每次重新选文件夹。

~~~powershell
npm install
npm run desktop            # 启动桌面应用
npm run desktop:headless   # 无桌面会话（远程/CI）用：自动走软件渲染
npm run desktop:smoke      # 不弹窗自检：跑一遍真实扫描流水线，退出码表达结果
npm run dist               # 产出 Windows 安装包到 outputs/
~~~

`desktop:smoke` 会真实加载 Electron 页面与 preload，完成本机扫描，再进入「统一技能库」
生成只读预览；它校验 Skill 卡片、扫描根、来源标签和操作清单，不会执行迁移。

安装包命名 `Skill-Packer-Setup-<version>.exe`。

**从 GitHub Releases 下载**：每次推到 `main`，CI 会在 Windows Runner 上自动出一份 NSIS 安装包并挂到
[Releases](https://github.com/gsyIsWatchingU/skill-packer/releases)，版本号形如 `2.3.0-beta.<run 号>`，
属于 prerelease。打开 Releases 页选最新一条，下载 `Skill-Packer-Setup-*.exe` 即可。

**启动必须经 `npm run desktop`，不要直接 `electron .`。** 启动器
`scripts/desktop.js` 抹平两个会让"应用起不来"看起来像代码 bug 的环境坑：

- **`ELECTRON_RUN_AS_NODE=1`**（某些终端环境会预设）会让 Electron 退化成纯 Node 进程，
  不初始化 Chromium、不注入 `electron` 模块，于是 `require('electron')` 解构出 `undefined`，
  报 `Cannot read properties of undefined (reading 'commandLine')`。启动器会剔除该变量。
  自检：`electron.exe -e "console.log(process.type)"` 应输出 `browser`，输出 `undefined` 就是被降级了。
- **无桌面会话下 GPU 进程 FATAL**（`GPU process isn't usable`）表现为闪退，
  `--headless` 会加上 `--no-sandbox --disable-gpu --in-process-gpu`。

注：打包产物**不受** `node_modules/electron` 遮蔽问题影响 —— electron-builder 会重命名主 exe，
且 asar 内不含 `node_modules/electron`。该问题只存在于开发态，已由启动器解决。

默认扫描 11 个根，覆盖 Codex、Claude Code、Cursor、WorkBuddy、豆包和 Trae。
系统内置 / 插件与个人 / 下载 Skill 分开标记；缺失根如实报 `missing`，不臆造目录。

### 统一技能库

「统一技能库」把个人 Skill 正本归入 `%USERPROFILE%\.agents\skills`，再在本机已存在的 IDE
技能目录逐项创建 Junction。系统内置与插件 Skill 永远只读。

- 第一次点击只生成计划，第二次确认才写盘；执行前会重新扫描，过期计划拒绝执行。
- 同名同内容和仅改名副本会去重；同名不同内容默认阻断，必须明确选择正本。
- 每一步写入 `.unify-backup/<时间>/manifest.json`；完成或中断后都可回滚。
- 不修改 IDE 配置，不创建未安装 IDE 的目录，不把整个 `skills` 目录做链接。
- Trae 当前只扫描；条目级链接兼容性验证通过前，不自动迁移其目录。

### 业务流组装

桌面端「业务流」把多个 Skill 组合成一个可直接调用的入口 Skill。业务流只保存 Skill 引用、
版本哈希、顺序关系与补充指令，不复制子 Skill 内容：`ABCD` 与 `CDEF` 可以复用同一份 `C / D`。

- 支持接着执行、与上一步并行、按需执行三种组合关系。
- 点击「生成单一调用入口」后，在中央目录生成 `$workflow-名称`。
- 用户只调用这一个入口，Agent 自动加载各子 Skill，无需逐个选择。
- 子 Skill 版本变化时拒绝静默覆盖，需要重新保存业务流后再生成。
- 删除业务流只删除它生成的入口，不删除任何子 Skill。
- 可选择项目与 Codex / Claude Code / Cursor，先预览再逐项建立 Junction。
- 项目内同名普通目录默认阻断；每次启用写 manifest，并可回滚本次创建的链接。
- 可导出 / 导入 `.skill-workflow.json`；包内不含本机路径和 Skill 正文，导入时校验依赖与版本。
- 可导出 Codex 原生 Plugin 目录，包含 `.codex-plugin/plugin.json`、入口与依赖 Skill 固定版本快照。
- 登录后可把业务流保存到云端并在其他设备拉取；云端按账号隔离并保留版本记录。

安全基线：`contextIsolation` + `sandbox` + 无 `nodeIntegration`，
本机能力只经 preload 白名单 IPC 暴露；不启本地 HTTP 服务。
除「云同步」与「AI 整理」这两个用户显式开启的动作外，不联网上传任何内容。

### AI 整理（默认关闭）

桌面端「AI 整理」页做三件事：本地粗筛疑似重复的候选 → 把**最小元数据**交给大模型 →
拿回「该留哪一份」的建议。模型只输出建议，不碰你的文件。

- **粗筛不出网**：同名、内容哈希相同、描述高度重合三类候选全在本机算完（Jaccard 相似度，阈值 0.6）。
- **发什么可枚举**：名称、描述、平台、作用域、内容哈希、文件数、体积、修改日期、被引用次数。
  **不发**目录路径（带用户名）、不发脚本内容；SKILL.md 正文摘要要额外勾选才发。
  模型只看到 `s1` / `s2` 这样的编号。
- **三步闸门**：设置里「允许发送」默认关闭 → 发送前展开完整载荷让你看 → 点确认才发。
- **模型会编造，所以逐条核对**：编号不存在、跨组比较、没给依据的建议整条丢弃，界面如实显示忽略了几条。
- **端点自己填**：OpenAI 兼容地址 + 模型名（DeepSeek / Moonshot / 本地 vLLM / Ollama 均可），
  API Key 明文存本机 `settings.json`，与云端会话令牌同级处理，不进 Git。

### 云同步

桌面端「云同步」直连已部署的 Skill Packer 云同步 API（`src/cloud-client.js`），
登录后即可上传本机 Skill、浏览社区与自己的 Skill、下载到本机。数据走 GPU PostgreSQL。
上传与下载都由用户显式触发，其余时间不联网。

## 命令行扫描（自动化与 CI）

~~~powershell
npm run scan                                   # 扫描各 IDE 的 11 个默认根
node bin/skill-packer.js scan .                  # 只扫描指定项目的 .agents/skills 与 .codex/skills
node bin/skill-packer.js scan . --json out.json  # 同时输出机器可读报告
node bin/skill-packer.js scan . --include-scripts
node bin/skill-packer.js scan . --no-follow-links  # 不跟随符号链接与 junction~~~

报告包含五类信息：

- **扫描根状态**：每个目录是否存在、发现多少个 Skill、跟随了多少个链接。
- **上传预演**：默认只把 `.md` 一类文档文件计入"将来可上传"的集合，`scripts/` 下的可执行代码默认排除，并分别给出文件数与体积。
- **初始列表预算**：累计名称与描述字符数，和 Codex 初始技能列表的 8000 字符上限对比。超过后 Codex 会先缩短描述，再多则省略部分 Skill。
- **链接记录**：默认跟随符号链接与 junction——"把 Skill 链接进项目目录"是 Skill Packer 做项目级隔离的方式。
  指向扫描根目录之外的目标会逐个列出真实路径；失效链接、链接成环与无权限目标各自告警。
  同一链接在一次扫描里只计一次。完整清单见 JSON 报告的 `links` 字段。
- **需要注意**：同名 Skill（Codex 不合并同名项）、缺少 description、描述过长、含脚本文件。

### 关于"使用统计"的口径

桌面版会读本机 Codex 会话日志，给出每个 Skill 的**被引用次数**。

**口径是 `referenced`，不是 `invoked`。** 对全部 475 个真实会话日志抽样后确认：
Codex 不把"技能被调用"记成工具调用，日志里引用 `SKILL.md` 的调用几乎全是 agent 在读/写
`SKILL.md` 文件本身。所以这是弱代理指标，界面上如实标注为"被引用"，不能当使用频率看。
真正可靠的 invoked 数据仍要等 IDE 显式上报；统一与回滚记录不等于调用记录。

为什么值得做这些：它把"我要读你电脑"的叙事换成"你自己跑、自己看、没人替你做决定"，
并且报告本身就是最好的隐私说明。

## 架构

~~~text
桌面应用（C 通道；统一技能库可写） / CLI（B 通道，只读） → 本机 Skill 目录
      ↓ 云同步（用户显式触发，直连云同步 API）
GPU PostgreSQL
skill_users → skills → skill_versions → skill_files(BYTEA)
~~~

共享扫描内核：`src/scanner/index.js`（无 Electron、无 HTTP、无 cwd 依赖，纯函数式）。
桌面主进程与 CLI 都 require 它；契约测试 `test/scanner.test.js` 兜住 `docs/solution.md §11.1`
的四条不可让步约束（默认跟随链接 / 不拒绝跳出根 / 哈希用逻辑路径 / 同一链接只记一次）。

## 本地开发

~~~powershell
npm install
npm run desktop      # 启动桌面应用（开发态）
npm run desktop:smoke  # 不弹窗自检
~~~

CLI 本地试跑：

~~~powershell
node bin/skill-packer.js scan
~~~

## 自动部署

推送到 `main` 后，GitHub Actions 在 `windows-latest` 上自动构建并发布 Windows 安装包：
`npm ci` + `electron-builder --win nsis`，版本号自动挂上 CI run 号（如 `2.3.0-beta.42`），
产物挂到 [Releases](https://github.com/gsyIsWatchingU/skill-packer/releases)。

## 验证

~~~powershell
npm test
npm run desktop:smoke   # 桌面端扫描路径自检（不弹窗）
node --check src/main.js
node --check src/preload.js
node --check src/settings.js
node --check src/usage-scanner.js
node --check src/scanner/index.js
node --check src/renderer/app.js
node --check bin/skill-packer.js
~~~
