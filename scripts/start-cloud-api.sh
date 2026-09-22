#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="${SKILL_ATLAS_STATE_ROOT:-${PROJECT_ROOT}}"
NODE_BIN="${NODE_BIN:-/workspace/.tools/node-v20.19.5/bin/node}"

test -f "${STATE_ROOT}/.env"
test -x "${NODE_BIN}"
set -a
source "${STATE_ROOT}/.env"
set +a
cd "${PROJECT_ROOT}"
exec "${NODE_BIN}" src/cloud-api.js
