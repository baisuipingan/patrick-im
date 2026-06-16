#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="patrick-im"
INSTALL_DIR="${PATRICK_IM_INSTALL_DIR:-/opt/patrick-im}"
COMPOSE_URL="${PATRICK_IM_COMPOSE_URL:-https://gitee.com/cai-happy/patrick-im/raw/main/ops/docker-compose.yml}"
IMAGE="${PATRICK_IM_IMAGE:-crpi-6yrxqnyn3y05zbgq.cn-qingdao.personal.cr.aliyuncs.com/patrickcmh/patrick-im:latest}"
PUBLIC_BASE_URL="${PATRICK_IM_PUBLIC_BASE_URL:-http://127.0.0.1:5800}"
HOST_BIND="${PATRICK_IM_HOST_BIND:-0.0.0.0:5800}"
MYSQL_DATABASE="${PATRICK_IM_MYSQL_DATABASE:-patrick_im}"
MYSQL_USER="${PATRICK_IM_MYSQL_USER:-patrick_im}"
REGISTRY_HOST="crpi-6yrxqnyn3y05zbgq.cn-qingdao.personal.cr.aliyuncs.com"
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "${SCRIPT_PATH}" && -f "${SCRIPT_PATH}" && "$(basename -- "${SCRIPT_PATH}")" != "bash" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${SCRIPT_PATH}")" >/dev/null 2>&1 && pwd -P || true)"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
  printf "${GREEN}%s${NC}\n" "$*"
}

warn() {
  printf "${YELLOW}%s${NC}\n" "$*"
}

fail() {
  printf "${RED}%s${NC}\n" "$*" >&2
  exit 1
}

random_hex() {
  local bytes="${1:-32}"
  od -An -N "${bytes}" -tx1 /dev/urandom | tr -d ' \n'
}

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Please run as root, for example: sudo bash ops/install.sh"
  fi
}

check_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  fail "Docker Engine and Docker Compose plugin are required. Please install them first, then rerun this script."
}

download_compose() {
  mkdir -p "${INSTALL_DIR}/data/mysql" "${INSTALL_DIR}/data/files"
  if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/docker-compose.yml" ]]; then
    cp "${SCRIPT_DIR}/docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
  else
    curl -fsSL "${COMPOSE_URL}" -o "${INSTALL_DIR}/docker-compose.yml"
  fi
}

write_env() {
  if [[ -f "${INSTALL_DIR}/.env" ]]; then
    warn "Existing ${INSTALL_DIR}/.env found, keeping it."
    return
  fi

  local mysql_password="${PATRICK_IM_MYSQL_PASSWORD:-$(random_hex 18)}"
  local mysql_root_password="${PATRICK_IM_MYSQL_ROOT_PASSWORD:-$(random_hex 24)}"
  local session_secret="${PATRICK_IM_SESSION_SECRET:-$(random_hex 32)}"

  cat > "${INSTALL_DIR}/.env" <<EOF
PATRICK_IM_IMAGE=${IMAGE}
PATRICK_IM_HOST_BIND=${HOST_BIND}
PATRICK_IM_BIND=0.0.0.0:5800
PATRICK_IM_LOG=info,tower_http=info,axum=info
PATRICK_IM_PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
PATRICK_IM_SECURE_COOKIES=false
PATRICK_IM_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
PATRICK_IM_TURN_URLS=
PATRICK_IM_TURN_USERNAME=
PATRICK_IM_TURN_CREDENTIAL=
PATRICK_IM_MYSQL_DATABASE=${MYSQL_DATABASE}
PATRICK_IM_MYSQL_USER=${MYSQL_USER}
PATRICK_IM_MYSQL_PASSWORD=${mysql_password}
PATRICK_IM_MYSQL_ROOT_PASSWORD=${mysql_root_password}
PATRICK_IM_MYSQL_URL=mysql://${MYSQL_USER}:${mysql_password}@mysql:3306/${MYSQL_DATABASE}
PATRICK_IM_FILE_STORE_PATH=/app/data/files
PATRICK_IM_SESSION_SECRET=${session_secret}
PATRICK_IM_RECENT_MESSAGE_LIMIT=60
EOF
  chmod 600 "${INSTALL_DIR}/.env"
}

docker_login_if_requested() {
  if [[ -n "${ALIYUN_USERNAME:-}" && -n "${ALIYUN_PASSWORD:-}" ]]; then
    log "Logging in to Aliyun Container Registry..."
    printf '%s' "${ALIYUN_PASSWORD}" | docker login --username="${ALIYUN_USERNAME}" --password-stdin "${REGISTRY_HOST}"
  else
    warn "Skipping docker login. If image pull fails, run: docker login --username=<your-aliyun-username> ${REGISTRY_HOST}"
  fi
}

start_stack() {
  cd "${INSTALL_DIR}"
  docker compose pull
  docker compose up -d --remove-orphans
  docker compose ps
}

need_root
check_docker
download_compose
write_env
docker_login_if_requested
start_stack

log "${APP_NAME} installed at ${INSTALL_DIR}"
log "Env file: ${INSTALL_DIR}/.env"
log "Logs: docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f patrick-im-server"
