#!/usr/bin/env node
// 桌面应用启动器。
//
// 存在的唯一理由：抹平两个启动期环境坑，这些坑会让「应用起不来」看起来像代码 bug。
//
// 坑 1（致命）：环境里若存在 ELECTRON_RUN_AS_NODE=1，Electron 会退化成纯 Node 进程，
//   不初始化 Chromium、不注入 electron 模块，于是 main.js 里
//   `const { app } = require('electron')` 解构出 undefined，报
//   "Cannot read properties of undefined (reading 'commandLine')"。
//   这不是代码问题，是环境变量问题 —— 官方 FAQ 之外的另一种成因。
//
// 坑 2：无桌面会话 / 远程会话下 GPU 进程起不来，Chromium 直接 FATAL
//   "GPU process isn't usable. Goodbye."，表现为启动即闪退。
//
// 用法：npm run desktop        正常启动
//      node scripts/desktop.js --headless   无桌面会话环境（自动加软件渲染开关）
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = path.resolve(__dirname, '..');

function resolveElectronBinary() {
  // 优先用 npm 包自带的 dist，避免 PATH 上找不到 electron
  const shimPath = path.join(APP_ROOT, 'node_modules', 'electron', 'path.txt');
  const distDir = path.join(APP_ROOT, 'node_modules', 'electron', 'dist');
  if (fs.existsSync(shimPath)) {
    const relative = fs.readFileSync(shimPath, 'utf-8').trim();
    const candidate = path.join(distDir, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  const fallback = path.join(distDir, process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

// ELECTRON_RUN_AS_NODE 必须剔除：它把 Electron 降级成 Node，是本地启动失败的根因
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const forwarded = args.filter((arg) => arg !== '--headless');

// 无桌面会话时 Chromium 的 GPU 进程会 FATAL，这几个开关强制走软件渲染
const softwareRendering = ['--no-sandbox', '--disable-gpu', '--in-process-gpu', '--disable-software-rasterizer'];

const binary = resolveElectronBinary();
if (!binary) {
  console.error('找不到 Electron 二进制。先执行：npm install');
  process.exit(1);
}

if (env.ELECTRON_RUN_AS_NODE) {
  console.warn('提示：已剔除环境变量 ELECTRON_RUN_AS_NODE（它会让 Electron 退化成纯 Node）。');
}

const child = spawn(binary, [APP_ROOT, ...(headless ? softwareRendering : []), ...forwarded], {
  stdio: 'inherit',
  env
});

child.on('exit', (code) => process.exit(code === null ? 0 : code));
child.on('error', (error) => {
  console.error('启动 Electron 失败：' + error.message);
  process.exit(1);
});
