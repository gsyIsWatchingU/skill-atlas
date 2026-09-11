#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="${SKILL_ATLAS_STATE_ROOT:-${PROJECT_ROOT}}"
ENV_FILE="${STATE_ROOT}/.env"
NODE_BIN="${NODE_BIN:-/workspace/.tools/node-v20.19.5/bin/node}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "缺少 ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -x "${NODE_BIN}" ]]; then
  echo "Node.js 不可用：${NODE_BIN}" >&2
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

cd "${PROJECT_ROOT}"
exec "${NODE_BIN}" src/web-server.js
