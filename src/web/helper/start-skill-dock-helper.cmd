@echo off
setlocal

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

set "SKILL_DOCK_HELPER_DIR=%LOCALAPPDATA%\SkillDockHelper"
if not exist "%SKILL_DOCK_HELPER_DIR%" mkdir "%SKILL_DOCK_HELPER_DIR%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://gsy-gpu.tail660bdf.ts.net:8443/helper/skill-dock-helper.js?v=0.1.0' -OutFile (Join-Path $env:LOCALAPPDATA 'SkillDockHelper\skill-dock-helper.js')"
if errorlevel 1 (
  echo Failed to download Skill Dock Helper.
  pause
  exit /b 1
)

set "SKILL_DOCK_URL=https://gsy-gpu.tail660bdf.ts.net:8443/"
node "%SKILL_DOCK_HELPER_DIR%\skill-dock-helper.js"
if errorlevel 1 pause
