#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="/workspace/backups/skill-atlas"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

set -a
source "${PROJECT_ROOT}/.env"
set +a

mkdir -p "${BACKUP_ROOT}"
umask 077
pg_dump --format=custom --file="${BACKUP_ROOT}/skill-atlas-${STAMP}.dump" "${DATABASE_URL}"
echo "数据库已备份：${BACKUP_ROOT}/skill-atlas-${STAMP}.dump"
