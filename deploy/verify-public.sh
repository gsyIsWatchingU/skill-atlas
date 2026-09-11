#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${SKILL_ATLAS_STATE_ROOT:-}" ]]; then
  STATE_ROOT="${SKILL_ATLAS_STATE_ROOT}"
elif [[ "${PROJECT_ROOT}" == */current ]]; then
  STATE_ROOT="${PROJECT_ROOT%/current}"
else
  STATE_ROOT="${PROJECT_ROOT}"
fi
SUPERVISOR_CONFIG="${SUPERVISOR_CONFIG:-/workspace/etc/supervisord.conf}"
NODE_BIN="${NODE_BIN:-/workspace/.tools/node-v20.19.5/bin/node}"
LOCAL_URL="http://127.0.0.1:8787"

set -a
source "${STATE_ROOT}/.env"
set +a

retry() {
  local attempt
  for attempt in $(seq 1 15); do
    if "$@"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

verify_url() {
  local base_url="$1"
  curl -fsS --max-time 20 "${base_url}/api/health" |
    "${NODE_BIN}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok||!j.database||!j.protected)process.exit(1)})"
  curl -fsS --max-time 20 "${base_url}/" >/dev/null
  curl -fsS --max-time 20 -H "Authorization: Bearer ${SKILL_ATLAS_TOKEN}" "${base_url}/api/skills" |
    "${NODE_BIN}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!Array.isArray(j.skills))process.exit(1)})"
}

supervisorctl -c "${SUPERVISOR_CONFIG}" status skill-atlas | grep -q RUNNING
supervisorctl -c "${SUPERVISOR_CONFIG}" status cloudflared-skill-atlas | grep -q RUNNING
supervisorctl -c "${SUPERVISOR_CONFIG}" status github-actions-skill-atlas | grep -q RUNNING
retry verify_url "${LOCAL_URL}"

PUBLIC_URL="$(grep -Eho 'https://[a-z0-9-]+\.trycloudflare\.com' \
  "${STATE_ROOT}/logs/cloudflared.out.log" \
  "${STATE_ROOT}/logs/cloudflared.err.log" 2>/dev/null | tail -1)"
if [[ -z "${PUBLIC_URL}" ]]; then
  echo "未找到 Skill Atlas 公网地址" >&2
  exit 1
fi

retry verify_url "${PUBLIC_URL}"
echo "本机与公网验证通过：${PUBLIC_URL}"
