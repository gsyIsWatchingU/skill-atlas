# Skill Packer

面向项目的 Agent 工作流环境管理器：为每个项目启用刚刚好的 Skills，并把整套 Agent 工作流一键打包分享。

三层对象（Skill / 工作流包 / 项目环境）、三条能力通道、数据模型、落盘流程与路线图，
见 [`docs/solution.md`](docs/solution.md)。市场位置与竞品判断见 [`docs/competitors.md`](docs/competitors.md)。
本文件描述的是当前已实现的能力。

## 三种入口，按"要装多少东西"递增

| 入口 | 形态 | 适合谁 | 需要装什么 |
|---|---|---|---|
| **桌面应用** | Electron（C 通道） | 日常使用：扫描、区分来源、统一个人 Skill | 安装包 |
| **展示页 `/scan/`** | 网页 + File System Access | 先看看结果，不想装任何东西 | 不用装 |
| **命令行 `bin/skill-packer.js`** | 单文件 Node 脚本（B 通道） | 自动化、CI、要链接清单 | 不用装（需 Node） |

三种形态**共用同一份扫描内核** `src/scanner/index.js`（网页端因浏览器沙箱无法复用，语义由契约测试对齐）。

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

安装包命名 `Skill-Packer-Setup-<version>.exe`，同时提供 `GET /download/desktop` 供网页端直接下载。

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

### 公网展示页 `/scan/`

公网访客不会为了看一眼结果去开终端，所以展示页按"零动作 → 零安装 → 要动作"分三层：

1. **先看结果**：页面直接渲染一份真实扫描的输出样例，不要求访客做任何事。
2. **零安装自测**：用 File System Access API 让访客在自己的浏览器里选目录，
   分析全程在本地完成，报告就地渲染，一个字节都不出网、不写入任何文件。
   支持选项目目录（只读该项目下的 `.agents/skills` 与 `.codex/skills`）或直接选 Skill 目录。
3. **命令行方式**：给出"下载 → 自己看 → 再运行"三步命令（不是管道执行），
   并展示版本、体积、SHA-256，附 `certutil` 自查方法，源码可直接在页面上展开读完。

配套的服务端接口：

- `GET /cli/skill-packer.js`：以 `text/plain` 单文件形式发布命令行脚本，`no-store`，附 `nosniff`。
- `GET /api/cli/info`：返回版本、体积与 SHA-256，版本号从脚本自身读取，避免两处维护。
- `GET /download/desktop`：流式回传最新桌面安装包（从 `outputs/` 取 mtime 最新且含 `Setup` 的 `.exe`）。
- `GET /api/desktop/info`：返回安装包文件名、体积与 SHA-256（流式计算，不整份读进内存）。

脚本通过 `git ls-files` 进入发布包，无需改动部署清单。

## 命令行扫描（自动化与 CI）

~~~powershell
npm run scan                                   # 扫描各 IDE 的 11 个默认根
node bin/skill-packer.js scan .                  # 只扫描指定项目的 .agents/skills 与 .codex/skills
node bin/skill-packer.js scan . --json out.json  # 同时输出机器可读报告
node bin/skill-packer.js scan . --include-scripts
node bin/skill-packer.js scan . --no-follow-links  # 不跟随符号链接与 junction
node bin/skill-packer.js catalog                 # 按类型统计 + 按业务流列出 Skill（分类快照 docs/skill-taxonomy.json）
node bin/skill-packer.js catalog --workflow wf-xhs
                                                 # 只看某条业务流引用的 Skill 组合
node bin/skill-packer.js catalog --json out.json # 同时输出机器可读分类清单
~~~

报告包含五类信息：

- **扫描根状态**：每个目录是否存在、发现多少个 Skill、跟随了多少个链接。
- **上传预演**：默认只把 `.md` 一类文档文件计入"将来可上传"的集合，`scripts/` 下的可执行代码默认排除，并分别给出文件数与体积。
- **初始列表预算**：累计名称与描述字符数，和 Codex 初始技能列表的 8000 字符上限对比。超过后 Codex 会先缩短描述，再多则省略部分 Skill。
- **链接记录**：默认跟随符号链接与 junction——"把 Skill 链接进项目目录"是 Skill Packer 做项目级隔离的方式。
  指向扫描根目录之外的目标会逐个列出真实路径；失效链接、链接成环与无权限目标各自告警。
  同一链接在一次扫描里只计一次。完整清单见 JSON 报告的 `links` 字段。
- **需要注意**：同名 Skill（Codex 不合并同名项）、缺少 description、描述过长、含脚本文件。

`catalog` 子命令把扫描结果与 `docs/skill-taxonomy.json` 分类快照对齐：按 13 个类型给出统计，
并按 10 条业务流列出"引用哪些 Skill、哪些已安装"。它是"按业务流引用一组 Skill"的命令行入口，
分类数据与交互图谱（`docs/skill-taxonomy.html`）同源，详见 [`docs/taxonomy.md`](docs/taxonomy.md)。

### 关于"使用统计"的口径

桌面版会读本机 Codex 会话日志，给出每个 Skill 的**被引用次数**。

**口径是 `referenced`，不是 `invoked`。** 对全部 475 个真实会话日志抽样后确认：
Codex 不把"技能被调用"记成工具调用，日志里引用 `SKILL.md` 的调用几乎全是 agent 在读/写
`SKILL.md` 文件本身。所以这是弱代理指标，界面上如实标注为"被引用"，不能当使用频率看。
真正可靠的 invoked 数据仍要等 IDE 显式上报；统一与回滚记录不等于调用记录。

浏览器侧的两条扫描路径（首页授权目录、`/scan/` 展示页）走 File System Access API，
该 API 看不到链接，因此**浏览器化简的结果可能与本机命令行不一致**。需要链接信息时用桌面版或命令行。

为什么值得做这些：它把"我要读你电脑"的叙事换成"你自己跑、自己看、没人替你做决定"，
并且报告本身就是最好的隐私说明。

## 架构

~~~text
Algorithm Lab 统一账号 API（保留 SSO + PKCE 兼容）
      ↓
桌面应用（C 通道；统一技能库可写） / 浏览器目录授权（A 通道） / CLI（B 通道） → Skill Packer Web
      ↓
GPU PostgreSQL
skill_users → skills → skill_versions → skill_files(BYTEA)
~~~

共享扫描内核：`src/scanner/index.js`（无 Electron、无 HTTP、无 cwd 依赖，纯函数式）。
桌面主进程与 CLI 都 require 它；契约测试 `test/scanner.test.js` 兜住 `docs/solution.md §11.1`
的四条不可让步约束（默认跟随链接 / 不拒绝跳出根 / 哈希用逻辑路径 / 同一链接只记一次）。

## 本地开发

需要可访问的 PostgreSQL：

~~~powershell
npm install
$env:DATABASE_URL = "postgresql://skill_atlas:密码@127.0.0.1:5432/skill_atlas"
$env:SSO_AUTH_BASE_URL = "https://统一账号中心域名"
$env:PUBLIC_URL = "http://127.0.0.1:8787"
$env:SKILL_ATLAS_TOKEN = "仅用于认领旧仓库的令牌"
npm run dev
~~~

访问 **http://127.0.0.1:8787**。

本地助手（B 通道 CLI）默认连接公网 Skill Packer；启动后会自动打开已配对页面。
这条路径面向自动化与 CI，**首页不再引导普通用户走它**：

~~~powershell
npm run helper
~~~

调试本地网页时可指定地址：

~~~powershell
$env:SKILL_DOCK_URL = "http://127.0.0.1:8787"
npm run helper
~~~

助手只读六个内置目录，配对令牌保存在当前 Windows 用户目录中；关闭助手窗口即可停止。

## GPU 部署

项目部署到 **/workspace/projects/skill-atlas**，数据库使用 GPU 上已有的 PostgreSQL。

~~~bash
bash deploy/init-gpu-database.sh
npm ci --omit=dev
bash deploy/start.sh
~~~

正式运行由 Supervisor 管理应用，Tailscale Funnel 提供固定 HTTPS 地址：

- 账号中心：`https://gsy-gpu.tail660bdf.ts.net`
- Skill Packer：`https://gsy-gpu.tail660bdf.ts.net:8443`

`tailscaled` 的状态目录位于 `/workspace/.tailscale`，由服务器主 Supervisor 配置统一守护。

统一账号中心需登记：

- 客户端：`skill-packer`
- 回调：`${PUBLIC_URL}/auth/sso/callback`

## 自动部署

推送到 `main` 后，GitHub Actions 并行做两件事：

1. **构建并发布桌面安装包**：在 `windows-latest` 上跑 `npm ci` + `electron-builder --win nsis`，
   版本号自动挂上 CI run 号（如 `2.3.0-beta.42`），产物挂到
   [Releases](https://github.com/gsyIsWatchingU/skill-packer/releases)。
2. **部署 Web 到 GPU**：在公共 Runner 上测试并生成发布包，再由标签为 `skill-atlas-gpu` 的 GPU 自托管
   Runner 下载发布包并完成：

1. 安装生产依赖并切换版本。
2. 重启 `skill-atlas` Supervisor 进程。
3. 验证 PostgreSQL、本机接口、HTTPS 首页和公开社区接口。
4. 将已验证提交写入 `/workspace/projects/skill-atlas/run/deployed-commit`。

发布过程保留服务器上的 `.env`、数据库、日志和历史版本；新版本验证失败时自动回退。

查看部署状态：

~~~bash
supervisorctl -c /workspace/etc/supervisord.conf status skill-atlas cloudflared-skill-atlas github-actions-skill-atlas
cat /workspace/projects/skill-atlas/run/deployed-commit
bash /workspace/projects/skill-atlas/current/deploy/verify-public.sh
~~~

## 验证

~~~powershell
npm test
npm run desktop:smoke   # 桌面端扫描路径自检（不弹窗）
node --check src/main.js
node --check src/preload.js
node --check src/settings.js
node --check src/usage-scanner.js
node --check src/scanner/index.js
node --check src/web-server.js
node --check src/web/app.js
node --check src/web/helper/skill-packer-helper.js
node --check src/web/scan/scan.js
node --check src/renderer/app.js
node --check bin/skill-packer.js
~~~

~~~bash
bash deploy/verify.sh
~~~
