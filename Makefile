SHELL := /bin/bash
.SHELLFLAGS := --noprofile --norc -eu -o pipefail -c
.DEFAULT_GOAL := help

FRONTEND_DIR := frontend/web
BACKEND_DIR := backend/server
BACKEND_ENV_FILE := $(BACKEND_DIR)/.env
BACKEND_LOCAL_ENV_FILE := $(BACKEND_DIR)/.env.local
BUILD_DIR := $(BACKEND_DIR)/build
WEB_DIST_DIR := $(BACKEND_DIR)/web-dist
PACKAGE_NAME := patrick-im-server
BIN_NAME := patrick-im-server
SERVICE_NAME := patrick-im-server
COMPOSE_FILE := ops/docker-compose.server.yml
DOCKER_COMPOSE := docker compose -f $(COMPOSE_FILE)
HOST_RUST_TARGET := $(shell bash --noprofile --norc -c 'source $$HOME/.cargo/env >/dev/null 2>&1 || true; rustc -vV 2>/dev/null | sed -n "s/^host: //p"' || true)
PNPM_INSTALL_FLAGS := install --frozen-lockfile --prefer-offline

.PHONY: help env-check frontend-dev backend-dev frontend-build release release-host release-x86 docker-build docker-up deploy deploy-x86 status logs clean

define load_toolchains
source $$HOME/.cargo/env >/dev/null 2>&1 || true; \
export NVM_DIR="$$HOME/.nvm"; \
if [[ -s "$$NVM_DIR/nvm.sh" ]]; then source "$$NVM_DIR/nvm.sh" >/dev/null 2>&1; fi; \
if ! command -v node >/dev/null 2>&1 && compgen -G "$$NVM_DIR/versions/node/*/bin" >/dev/null; then \
  export PATH="$$(ls -d "$$NVM_DIR"/versions/node/*/bin | sort -V | tail -n 1):$$PATH"; \
fi
endef

define require_command
if ! command -v $(1) >/dev/null 2>&1; then \
  echo "missing required command: $(1)" >&2; \
  exit 1; \
fi
endef

help:
	@printf '%s\n' \
	  'make env-check     # 检查 node/corepack/cargo/docker' \
	  'make frontend-dev  # 启动前端 Vite 开发服务' \
	  'make backend-dev   # 启动 Rust 后端开发服务' \
	  'make frontend-build # 构建前端到 backend/server/web-dist' \
	  'make release       # 按当前宿主机架构构建 release 二进制' \
	  'make release-x86   # 构建 x86_64 Linux release 二进制' \
	  'make docker-build  # 用现有二进制重建 runtime 镜像' \
	  'make docker-up     # 重启容器' \
	  'make deploy        # release + docker-build + docker-up' \
	  'make deploy-x86    # release-x86 + docker-build + docker-up' \
	  'make status        # 查看容器状态' \
	  'make logs          # 查看服务日志'

env-check:
	@$(load_toolchains); \
	$(call require_command,node); \
	$(call require_command,corepack); \
	$(call require_command,cargo); \
	$(call require_command,docker); \
	printf 'node=%s\n' "$$(node -v)"; \
	printf 'corepack=%s\n' "$$(corepack --version)"; \
	printf 'pnpm=%s\n' "$$(corepack pnpm --version)"; \
	printf 'cargo=%s\n' "$$(cargo -V)"; \
	printf 'rustc=%s\n' "$$(rustc -V)"; \
	printf 'docker=%s\n' "$$(docker -v)"; \
	printf 'docker compose=%s\n' "$$(docker compose version | head -n 1)"

frontend-dev:
	@$(load_toolchains); \
	$(call require_command,pnpm); \
	cd $(FRONTEND_DIR); \
	pnpm run dev

backend-dev:
	@$(load_toolchains); \
	$(call require_command,cargo); \
	ENV_FILE="$(BACKEND_LOCAL_ENV_FILE)"; \
	if [[ ! -f "$$ENV_FILE" ]]; then \
	  ENV_FILE="$(BACKEND_ENV_FILE)"; \
	fi; \
	if [[ ! -f "$$ENV_FILE" ]]; then \
	  echo "missing env file: $(BACKEND_LOCAL_ENV_FILE) or $(BACKEND_ENV_FILE)" >&2; \
	  echo "create $(BACKEND_LOCAL_ENV_FILE) from $(BACKEND_DIR)/.env.local.example for local development" >&2; \
	  exit 1; \
	fi; \
	set -a; \
	source "$$ENV_FILE"; \
	set +a; \
	cargo run -p $(PACKAGE_NAME) --bin $(BIN_NAME)

frontend-build: env-check
	@mkdir -p $(BUILD_DIR) $(WEB_DIST_DIR)
	@touch $(BUILD_DIR)/.gitkeep $(WEB_DIST_DIR)/.gitkeep
	@find $(WEB_DIST_DIR) -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
	@$(load_toolchains); \
	cd $(FRONTEND_DIR); \
	corepack pnpm $(PNPM_INSTALL_FLAGS); \
	corepack pnpm run build

release:
	@if [[ -z "$(HOST_RUST_TARGET)" ]]; then \
	  echo 'failed to detect host rust target' >&2; \
	  exit 1; \
	fi
	@$(MAKE) build-release TARGET=$(HOST_RUST_TARGET)

release-host: release

release-x86:
	@$(MAKE) build-release TARGET=x86_64-unknown-linux-gnu

build-release: frontend-build
	@mkdir -p $(BUILD_DIR)
	@$(load_toolchains); \
	$(call require_command,rustup); \
	rustup target add $(TARGET) >/dev/null 2>&1 || true; \
	cargo build --release --target $(TARGET) -p $(BIN_NAME); \
	install -m 755 target/$(TARGET)/release/$(BIN_NAME) $(BUILD_DIR)/$(BIN_NAME)

docker-build:
	@$(DOCKER_COMPOSE) build --pull $(SERVICE_NAME)

docker-up:
	@$(DOCKER_COMPOSE) up -d --force-recreate --remove-orphans $(SERVICE_NAME)
	@$(MAKE) status

deploy: release docker-build docker-up

deploy-x86: release-x86 docker-build docker-up

status:
	@docker ps --filter name=^/$(SERVICE_NAME)$$ --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

logs:
	@$(DOCKER_COMPOSE) logs -f --tail=200 $(SERVICE_NAME)

clean:
	@mkdir -p $(BUILD_DIR) $(WEB_DIST_DIR)
	@touch $(BUILD_DIR)/.gitkeep $(WEB_DIST_DIR)/.gitkeep
	@find $(WEB_DIST_DIR) -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
	@rm -f $(BUILD_DIR)/$(BIN_NAME)
