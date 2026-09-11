#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="${1:?缺少发布包目录}"
STATE_ROOT="${2:?缺少项目状态目录}"
COMMIT_SHA="${3:?缺少部署提交}"
EXPECTED_ROOT="${SKILL_ATLAS_DEPLOY_TARGET:-/workspace/projects/skill-atlas}"
NODE_DIR="${NODE_DIR:-/workspace/.tools/node-v20.19.5/bin}"
SUPERVISOR_CONFIG="${SUPERVISOR_CONFIG:-/workspace/etc/supervisord.conf}"

SOURCE_DIR="$(cd "${SOURCE_DIR}" && pwd -P)"
STATE_ROOT="$(cd "${STATE_ROOT}" && pwd -P)"

if [[ "${STATE_ROOT}" != "${EXPECTED_ROOT}" ]]; then
  echo "拒绝更新非预期目录：${STATE_ROOT}" >&2
  exit 1
fi
if [[ ! "${COMMIT_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "部署提交格式无效" >&2
  exit 1
fi
if [[ ! -x "${NODE_DIR}/node" || ! -x "${NODE_DIR}/npm" ]]; then
  echo "Node.js 运行时不可用：${NODE_DIR}" >&2
  exit 1
fi
if [[ ! -f "${STATE_ROOT}/.env" ]]; then
  echo "缺少服务器环境文件：${STATE_ROOT}/.env" >&2
  exit 1
fi

MANIFEST="${SOURCE_DIR}/.deploy-manifest"
if [[ ! -f "${MANIFEST}" ]]; then
  echo "发布包缺少 .deploy-manifest" >&2
  exit 1
fi

validate_path() {
  local relative_path="$1"
  if [[ -z "${relative_path}" || "${relative_path}" == /* || "${relative_path}" == *".."* || "${relative_path}" == *\\* ]]; then
    echo "发布清单包含非法路径：${relative_path}" >&2
    exit 1
  fi
  case "${relative_path}" in
    data|data/*|logs|logs/*|run|run/*|work|work/*|outputs|outputs/*|releases|releases/*|current|current/*|.deploy-tmp|.deploy-tmp/*|node_modules|node_modules/*|*/node_modules|*/node_modules/*)
      echo "发布清单包含受保护路径：${relative_path}" >&2
      exit 1
      ;;
  esac
  case "${relative_path}" in
    .env|.env.*|*/.env|*/.env.*)
      if [[ "${relative_path}" != *.example ]]; then
        echo "发布清单包含环境变量文件：${relative_path}" >&2
        exit 1
      fi
      ;;
  esac
}

while IFS= read -r relative_path; do
  validate_path "${relative_path}"
done < "${MANIFEST}"

if find "${SOURCE_DIR}" -type l -print -quit | grep -q .; then
  echo "发布包包含符号链接，拒绝部署" >&2
  exit 1
fi

RELEASES_ROOT="${STATE_ROOT}/releases"
RELEASE_DIR="${RELEASES_ROOT}/${COMMIT_SHA}"
INCOMING_DIR="${RELEASES_ROOT}/.incoming-${COMMIT_SHA}"
CURRENT_LINK="${STATE_ROOT}/current"
NEXT_LINK="${STATE_ROOT}/current.next"
RUN_ROOT="${STATE_ROOT}/run"
OLD_TARGET=""
SWITCHED=0

mkdir -p "${RELEASES_ROOT}" "${RUN_ROOT}" "${STATE_ROOT}/logs"

if [[ ! -d "${RELEASE_DIR}" ]]; then
  [[ "${INCOMING_DIR}" == "${RELEASES_ROOT}/.incoming-${COMMIT_SHA}" ]]
  rm -rf -- "${INCOMING_DIR}"
  mkdir -p "${INCOMING_DIR}"
  trap 'rm -rf -- "${INCOMING_DIR}"' EXIT
  tar -C "${SOURCE_DIR}" --verbatim-files-from -cf - -T "${MANIFEST}" | tar -C "${INCOMING_DIR}" -xf -
  install -m 0644 "${MANIFEST}" "${INCOMING_DIR}/.deploy-manifest"
  chmod +x "${INCOMING_DIR}"/deploy/*.sh
  PATH="${NODE_DIR}:${PATH}" "${NODE_DIR}/npm" ci --omit=dev --prefix "${INCOMING_DIR}"
  mv -- "${INCOMING_DIR}" "${RELEASE_DIR}"
  trap - EXIT
fi

if [[ -L "${CURRENT_LINK}" ]]; then
  OLD_TARGET="$(readlink "${CURRENT_LINK}")"
  if [[ ! "${OLD_TARGET}" =~ ^releases/[0-9a-f]{40}$ ]]; then
    echo "当前版本链接异常：${OLD_TARGET}" >&2
    exit 1
  fi
elif [[ -e "${CURRENT_LINK}" ]]; then
  echo "current 不是符号链接，拒绝覆盖" >&2
  exit 1
fi

rollback() {
  local exit_code=$?
  trap - ERR
  if [[ "${SWITCHED}" == "1" ]]; then
    if [[ -n "${OLD_TARGET}" ]]; then
      ln -sfn "${OLD_TARGET}" "${STATE_ROOT}/current.rollback"
      mv -Tf "${STATE_ROOT}/current.rollback" "${CURRENT_LINK}"
      supervisorctl -c "${SUPERVISOR_CONFIG}" restart skill-atlas >/dev/null || true
      echo "部署失败，已回退到 ${OLD_TARGET}" >&2
    else
      rm -f -- "${CURRENT_LINK}"
      echo "首次部署失败，已移除 current 链接" >&2
    fi
  fi
  exit "${exit_code}"
}
trap rollback ERR

ln -sfn "releases/${COMMIT_SHA}" "${NEXT_LINK}"
mv -Tf "${NEXT_LINK}" "${CURRENT_LINK}"
SWITCHED=1

supervisorctl -c "${SUPERVISOR_CONFIG}" restart skill-atlas
SKILL_ATLAS_STATE_ROOT="${STATE_ROOT}" bash "${CURRENT_LINK}/deploy/verify-public.sh"
printf '%s\n' "${COMMIT_SHA}" > "${RUN_ROOT}/deployed-commit"
trap - ERR

echo "已部署并验证版本：${COMMIT_SHA}"
