# Web 端停用

- 仅保留桌面端和 CLI；网页、浏览器扫描与本地助手已移除。
- 云同步后端为 `src/cloud-api.js`，保留登录、上传、下载、社区和原数据库。
- 原网页地址返回 HTTP 410；桌面云同步继续使用原有 Tailscale 地址。
- GPU 的 `cloudflared-skill-atlas` 和 `github-actions-skill-atlas` 已停止，并关闭自动启动、自动重启。
- GitHub Actions 仅检查代码和发布 Windows 安装包，不再部署 Web。
- 后端启动：`npm run cloud:api`；GPU 使用 `scripts/start-cloud-api.sh` 加载原环境配置。
- 验证：`npm test`；公网首页应为 410，`/api/health` 应为 200。

服务器保留旧发布、数据库和配置备份，不自动恢复旧 Web 服务。
