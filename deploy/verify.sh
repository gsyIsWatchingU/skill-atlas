#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="${SKILL_ATLAS_STATE_ROOT:-${PROJECT_ROOT}}"
BASE_URL="${1:-http://127.0.0.1:8787}"
NODE_BIN="${NODE_BIN:-/workspace/.tools/node-v20.19.5/bin/node}"

set -a
source "${STATE_ROOT}/.env"
set +a

curl -fsS "${BASE_URL}/api/health" |
  "${NODE_BIN}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok||!j.database||j.auth!=='sso'||!j.ssoConfigured)process.exit(1)})"
curl -fsS "${BASE_URL}/" >/dev/null
curl -fsS "${BASE_URL}/api/skills?scope=community" |
  "${NODE_BIN}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!Array.isArray(j.skills))process.exit(1)})"

echo "Skill Dock 验证通过：${BASE_URL}"
