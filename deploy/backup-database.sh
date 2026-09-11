#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="${SKILL_ATLAS_STATE_ROOT:-${PROJECT_ROOT}}"
BACKUP_ROOT="${SKILL_ATLAS_BACKUP_ROOT:-/workspace/backups/skill-atlas}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

set -a
source "${STATE_ROOT}/.env"
set +a

mkdir -p "${BACKUP_ROOT}"
umask 077
pg_dump --format=custom --file="${BACKUP_ROOT}/skill-atlas-${STAMP}.dump" "${DATABASE_URL}"
echo "数据库已备份：${BACKUP_ROOT}/skill-atlas-${STAMP}.dump"
