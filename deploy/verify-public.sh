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

# 诊断输出走 stderr，便于部署脚本捕获；不打印 .env 内容，只回显判定字段。
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# 记录本次尝试的实际失败字段，而不是只报「失败」。
# 排查过一次「验证重试耗尽」但看不到原因的问题，加这个是为了区分：
# 连接被拒（服务没起来）/ 数据库不通 / auth 不对 / ssoConfigured 为假。
diagnose_health() {
  local base_url="$1" body
  body="$(curl -fsS --max-time 20 "${base_url}/api/health" 2>&1)" || {
    log "  health_request_failed url=${base_url} err=$(printf '%s' "${body}" | tr '\n' ' ' | cut -c1-200)"
    return 1
  }
  printf '%s' "${body}" | "${NODE_BIN}" -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const j=JSON.parse(s);
    process.stderr.write('  health_fields ok='+j.ok+' database='+j.database+' auth='+j.auth+' ssoConfigured='+j.ssoConfigured+'\n');
  }catch(e){process.stderr.write('  health_parse_failed raw='+s.slice(0,200)+'\n');}
});" || true
  printf '%s' "${body}" | "${NODE_BIN}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok||!j.database||j.auth!=='sso'||!j.ssoConfigured)process.exit(1)})"
}

retry() {
  local attempt
  for attempt in $(seq 1 15); do
    if "$@"; then
      return 0
    fi
    log "  retry_attempt=${attempt}/15"
    sleep 2
  done
  return 1
}

verify_url() {
  local base_url="$1"
  diagnose_health "${base_url}"
  curl -fsS --max-time 20 "${base_url}/" >/dev/null || { log "  homepage_failed url=${base_url}"; return 1; }
  local skills_body
  skills_body="$(curl -fsS --max-time 20 "${base_url}/api/skills?scope=community" 2>&1)" || {
    log "  skills_request_failed url=${base_url} err=$(printf '%s' "${skills_body}" | tr '\n' ' ' | cut -c1-200)"
    return 1
  }
  printf '%s' "${skills_body}" | "${NODE_BIN}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!Array.isArray(j.skills))process.exit(1)})"
}

log "verify_begin local=${LOCAL_URL}"
supervisorctl -c "${SUPERVISOR_CONFIG}" status skill-atlas | grep -q RUNNING || { log "supervisor_check_failed: skill-atlas 未 RUNNING"; exit 1; }
supervisorctl -c "${SUPERVISOR_CONFIG}" status tailscaled | grep -q RUNNING || { log "supervisor_check_failed: tailscaled 未 RUNNING"; exit 1; }
supervisorctl -c "${SUPERVISOR_CONFIG}" status github-actions-skill-atlas | grep -q RUNNING || { log "supervisor_check_failed: runner 未 RUNNING"; exit 1; }
retry verify_url "${LOCAL_URL}" || { log "verify_local_failed url=${LOCAL_URL}"; exit 1; }
log "verify_local_ok"

PUBLIC_URL="${PUBLIC_URL:?缺少固定公网地址}"

log "verify_begin public=${PUBLIC_URL}"
retry verify_url "${PUBLIC_URL}" || { log "verify_public_failed url=${PUBLIC_URL}"; exit 1; }
log "verify_public_ok"
echo "本机与公网验证通过：${PUBLIC_URL}"
