# Skill Atlas

集中查看 Codex、Trae 和共享 Agent Skills 的 Windows 桌面应用。

## 功能

- 自动扫描 Codex、Trae、Trae CLI 与 `.agents/skills`。
- 按平台、范围、重名和元数据完整度筛选。
- 搜索名称、描述、来源和路径。
- 为任意 Skill 添加本地持久化的自定义中文简介，并优先用于展示、搜索和导出。
- 查看完整指令、打开文件、定位目录、复制路径。
- 添加自定义项目目录并导出 JSON 清单。

## 开发运行

```powershell
npm install
npm start
```

## 构建

```powershell
npm run pack
```

生成的 Windows 便携版位于 `outputs/`。
