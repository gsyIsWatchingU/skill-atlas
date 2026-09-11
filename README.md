# Skill Dock

纯在线 Agent Skill 仓库，用于扫描、存储、比较和跨设备安装 Skill。

## 功能

- 浏览器授权后扫描 **.codex/skills**、**.agents/skills** 等目录。
- Chrome / Edge 可把云端 Skill 直接写入用户授权的目录。
- PostgreSQL 存储 Skill、版本和每个文件的二进制内容。
- 通过 SHA-256 判断本机缺失、已同步和版本不同。
- 默认禁止上传系统自带 Skill，并过滤环境变量、密钥和凭证文件。
- 通过本站邮箱密码表单接入统一账号，注册需邮箱验证码，私有 Skill 按账号隔离。
- Skill 可在私有与社区两种可见性之间切换；社区 Skill 支持公开浏览和下载。

浏览器不能静默遍历电脑。每个目录都必须由用户主动选择；公网环境必须使用 HTTPS。

## 架构

~~~text
Algorithm Lab 统一账号 API（保留 SSO + PKCE 兼容）
      ↓
浏览器目录授权 → Skill Dock Web
      ↓
GPU PostgreSQL
skill_users → skills → skill_versions → skill_files(BYTEA)
~~~

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

## GPU 部署

项目部署到 **/workspace/projects/skill-atlas**，数据库使用 GPU 上已有的 PostgreSQL。

~~~bash
bash deploy/init-gpu-database.sh
npm ci --omit=dev
bash deploy/start.sh
~~~

正式运行由 Supervisor 管理应用，Tailscale Funnel 提供固定 HTTPS 地址：

- 账号中心：`https://gsy-gpu.tail660bdf.ts.net`
- Skill Dock：`https://gsy-gpu.tail660bdf.ts.net:8443`

`tailscaled` 的状态目录位于 `/workspace/.tailscale`，由服务器主 Supervisor 配置统一守护。

统一账号中心需登记：

- 客户端：`skill-dock`
- 回调：`${PUBLIC_URL}/auth/sso/callback`

## 自动部署

推送到 `main` 后，GitHub Actions 会先在公共 Runner 上测试并生成发布包，再由标签为 `skill-atlas-gpu` 的 GPU 自托管 Runner 下载发布包并完成：

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
node --check src/web-server.js
node --check src/web/app.js
~~~

~~~bash
bash deploy/verify.sh
~~~
