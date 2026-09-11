#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="${SKILL_ATLAS_STATE_ROOT:-${PROJECT_ROOT}}"
ENV_FILE="${STATE_ROOT}/.env"
DB_NAME="skill_atlas"
DB_USER="skill_atlas"
SSO_AUTH_BASE_URL="${SSO_AUTH_BASE_URL:?请先设置统一账号中心地址}"
PUBLIC_URL="${PUBLIC_URL:?请先设置 Skill Dock 固定公网地址}"

if [[ -e "${ENV_FILE}" ]]; then
  echo "已存在 .env，拒绝覆盖。" >&2
  exit 1
fi

DB_PASSWORD="$(openssl rand -hex 24)"
APP_TOKEN="$(openssl rand -hex 32)"

if [[ "$(psql -U postgres -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'")" == "1" ]]; then
  echo "数据库角色已存在，拒绝修改未知凭证。" >&2
  exit 1
fi

if [[ "$(psql -U postgres -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" == "1" ]]; then
  echo "数据库已存在，拒绝覆盖未知数据。" >&2
  exit 1
fi

psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'"
createdb -U postgres -O "${DB_USER}" "${DB_NAME}"

umask 077
printf '%s\n' \
  'NODE_ENV=production' \
  'HOST=0.0.0.0' \
  'PORT=8787' \
  "DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}" \
  "SKILL_ATLAS_TOKEN=${APP_TOKEN}" \
  "SSO_AUTH_BASE_URL=${SSO_AUTH_BASE_URL}" \
  "PUBLIC_URL=${PUBLIC_URL}" \
  > "${ENV_FILE}"

echo "数据库与旧仓库认领令牌已创建，凭证仅保存在服务器 .env。"
