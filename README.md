# Skill Atlas

集中查看 Codex、Trae 和共享 Agent Skills 的 Windows 桌面应用。

## 功能

- 自动扫描 Codex、Trae、Trae CLI 与 `.agents/skills`。
- 从本机 Codex 会话日志统计 Skill 使用次数、近 30 天趋势和最后使用时间。
- 按平台、范围、重名和元数据完整度筛选。
- 通过标签区分 `Codex 自带` 与 `个人 / 下载` Skill。
- 搜索名称、描述、来源和路径。
- 为当前已识别的 Skill 提供应用内中文简介，不修改原始 `SKILL.md`。
- 扫描状态显示中文简介覆盖数量，便于确认当前运行版本与匹配结果。
- 为任意 Skill 添加本地持久化的自定义中文简介，并优先用于展示、搜索和导出。
- 查看完整指令、打开文件、定位目录、复制路径。
- 添加自定义项目目录并导出 JSON 清单。

## 开发运行

```powershell
npm install
npm run dev
```

开发模式下，界面文件变化会自动刷新，主进程文件变化会自动重启。使用 `npm start` 可普通启动，不监听文件变化。

## 构建

```powershell
npm run pack
```

生成的 Windows 便携版位于 `outputs/`。
