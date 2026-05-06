SHELL := /bin/bash
.SHELLFLAGS := --noprofile --norc -eu -o pipefail -c
.DEFAULT_GOAL := help

FRONTEND_DIR := frontend/web
BACKEND_DIR := backend/server
BUILD_DIR := $(BACKEND_DIR)/build
WEB_DIST_DIR := $(BACKEND_DIR)/web-dist
BIN_NAME := patrick-im-server
SERVICE_NAME := patrick-im-server
COMPOSE_FILE := ops/docker-compose.server.yml
DOCKER_COMPOSE := docker compose -f $(COMPOSE_FILE)
HOST_RUST_TARGET := $(shell bash --noprofile --norc -c 'source $$HOME/.cargo/env >/dev/null 2>&1 || true; rustc -vV 2>/dev/null | sed -n "s/^host: //p"' || true)

.PHONY: help env-check frontend-build release release-host release-x86 docker-build docker-up deploy deploy-x86 status logs clean

define load_toolchains
source $$HOME/.cargo/env >/dev/null 2>&1 || true; \
export NVM_DIR="$$HOME/.nvm"; \
if [[ -s "$$NVM_DIR/nvm.sh" ]]; then source "$$NVM_DIR/nvm.sh"; fi; \
nvm use --lts >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
endef

define require_command
if ! command -v $(1) >/dev/null 2>&1; then \
  echo "missing required command: $(1)" >&2; \
  exit 1; \
fi
endef

help:
	@printf '%s\n' \
	  'make env-check     # 检查 node/npm/cargo/docker' \
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
	$(call require_command,npm); \
	$(call require_command,cargo); \
	$(call require_command,docker); \
	printf 'node=%s\n' "$$(node -v)"; \
	printf 'npm=%s\n' "$$(npm -v)"; \
	printf 'cargo=%s\n' "$$(cargo -V)"; \
	printf 'rustc=%s\n' "$$(rustc -V)"; \
	printf 'docker=%s\n' "$$(docker -v)"; \
	printf 'docker compose=%s\n' "$$(docker compose version | head -n 1)"

frontend-build: env-check
	@mkdir -p $(BUILD_DIR) $(WEB_DIST_DIR)
	@touch $(BUILD_DIR)/.gitkeep $(WEB_DIST_DIR)/.gitkeep
	@find $(WEB_DIST_DIR) -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
	@$(load_toolchains); \
	cd $(FRONTEND_DIR); \
	npm ci; \
	npm run build

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
