# Patrick IM

Patrick IM 是一个轻量级网页即时通讯项目，面向小团队、朋友之间或临时房间聊天场景。前端使用 React + Vite，后端已经重构为 Go + Gin + GORM，使用 SQLite 保存聊天记录和 relay 文件元数据，文件内容落在本地磁盘。

旧 Rust/Axum/MySQL 后端已归档到 `backend/_legacy/rust/server`，当前主构建和部署路径只使用 `backend/server` 下的 Go 后端。

## 功能特性

- 房间制聊天：通过房间 ID 加入同一个实时会话。
- WebSocket 实时通信：在线成员、文本消息、WebRTC 信令都走后端房间 hub。
- 直连优先、Relay 兜底：前端优先尝试点对点传输，必要时使用服务器本地文件存储中继。
- 聊天记录持久化：SQLite 保存可见消息、私聊线程、线程清理和中继文件元数据。
- 单容器部署：后端二进制、前端构建产物、SQLite 数据和文件存储都在一个服务容器内完成。
- Makefile 运维入口：开发、测试、构建、Docker 打包、部署、日志查看都集中在 `make` 命令里。

## 技术栈

- 前端：React 19、Vite、TypeScript、Tailwind CSS、Vitest
- 后端：Go、Gin、GORM、Gorilla WebSocket、标准库 `slog`
- 存储：SQLite、本地磁盘文件存储
- 部署：Docker Compose、OpenResty/Nginx 反向代理

## 项目结构

```text
frontend/web                    React + Vite 前端
frontend/web/shared             前后端共享协议类型
backend/server                  Go Gin 后端
backend/server/web-dist         前端生产构建产物
backend/server/build            发布二进制输出目录
backend/_legacy/rust/server     旧 Rust 后端归档，仅作业务核对
ops/docker-compose.yml          一键安装/生产 compose
ops/docker-compose.server.yml   本机自测/1Panel 网络 compose
ops/openresty                   OpenResty/Nginx 示例配置
Makefile                        开发、测试、构建和部署统一入口
```

## 环境要求

- Go
- Node.js + Corepack
- pnpm：由 `frontend/web/package.json` 的 `packageManager` 指定
- Docker：用于部署服务容器时需要

可以先检查本机工具链：

```bash
make env-check
```

## 本地开发

准备后端环境变量：

```bash
cp backend/server/.env.local.example backend/server/.env.local
```

启动后端：

```bash
make backend-dev
```

启动前端：

```bash
make frontend-dev
```

默认开发地址：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:5800`

Vite 会把 `/api` 和 WebSocket 请求代理到 `http://127.0.0.1:5800`。

## 环境变量

后端示例文件：

- 本地开发：`backend/server/.env.local.example`
- 生产部署：`backend/server/.env.example`

核心变量：

| 变量 | 说明 |
| --- | --- |
| `PATRICK_IM_BIND` | 后端监听地址，默认示例为 `0.0.0.0:5800` |
| `PATRICK_IM_LOG` | Go slog 日志级别占位，默认 `info` |
| `PATRICK_IM_PUBLIC_BASE_URL` | 站点公网地址，用于推断 cookie 安全策略 |
| `PATRICK_IM_SECURE_COOKIES` | 是否给 session cookie 加 `Secure`；生产 HTTPS 建议 `true` |
| `PATRICK_IM_SQLITE_PATH` | SQLite 数据库路径 |
| `PATRICK_IM_FILE_STORE_PATH` | 本地文件存储目录 |
| `PATRICK_IM_WEB_DIST_PATH` | 前端构建产物目录 |
| `PATRICK_IM_SESSION_SECRET` | session/upload token 签名密钥，生产必须换成足够长的随机字符串 |
| `PATRICK_IM_RECENT_MESSAGE_LIMIT` | 进入房间时加载的最近消息数量 |
| `PATRICK_IM_STUN_URLS` | 前端 WebRTC 使用的 STUN 地址，逗号分隔 |
| `PATRICK_IM_TURN_URLS` | TURN 地址，逗号分隔 |
| `PATRICK_IM_TURN_USERNAME` | TURN 用户名 |
| `PATRICK_IM_TURN_CREDENTIAL` | TURN 密码 |

## 常用命令

```bash
make help
```

常用目标：

| 命令 | 说明 |
| --- | --- |
| `make env-check` | 检查 node/corepack/go/docker |
| `make frontend-dev` | 启动 Vite 前端开发服务 |
| `make backend-dev` | 启动 Go Gin 后端开发服务 |
| `make test` | 运行 Go 后端测试 |
| `make frontend-build` | 构建前端到 `backend/server/web-dist` |
| `make release` | 按当前宿主机架构构建 release 二进制 |
| `make release-x86` | 构建 `linux/amd64` release 二进制 |
| `make docker-build` | 用现成二进制构建 runtime 镜像 |
| `make docker-build-x86` | `release-x86 + docker-build`，构建 `linux/amd64` 镜像 |
| `make docker-push-aliyun` | 推送镜像到默认镜像仓库 |
| `make publish-x86` | 本机交叉编译 x86、打镜像并推送 |
| `make docker-up` | 重启服务容器 |
| `make deploy` | `deploy-x86` 的别名 |
| `make deploy-x86` | 本机 `release-x86 + docker-build + docker-up` |
| `make status` | 查看容器状态 |
| `make logs` | 跟随服务日志 |
| `make clean` | 清理本地构建产物 |

## 构建与部署

生产部署推荐本机完成前端构建、Go 二进制交叉编译、镜像构建和镜像发布。Dockerfile 只复制本机已经编译好的 `backend/server/build/patrick-im-server` 和 `backend/server/web-dist`。

发布默认 `latest` 镜像：

```bash
make publish-x86
```

`make publish-x86` 会依次完成：

1. 检查 Node、pnpm、Go、Docker 工具链。
2. 安装前端依赖并构建 Vite 产物。
3. 输出前端产物到 `backend/server/web-dist`。
4. 运行 Go 后端测试。
5. 交叉编译 `linux/amd64` Go 二进制。
6. 复制二进制到 `backend/server/build/patrick-im-server`。
7. 用本地二进制和前端 dist 构建 `linux/amd64` runtime 镜像。
8. 给镜像打远端 tag 并 push。

### 新服务器一键安装

新服务器推荐直接使用一键安装脚本，不需要在服务器拉源码或本地构建。脚本只检查 Docker Engine 和 Docker Compose plugin 是否存在，不会替你安装 Docker；检查通过后会生成 `/opt/patrick-im/.env`，创建 SQLite 和文件存储目录，然后拉起服务：

```bash
curl -fsSL https://raw.githubusercontent.com/baisuipingan/patrick-im/main/ops/install.sh | sudo bash
```

也可以把公网地址一起传入：

```bash
curl -fsSL https://raw.githubusercontent.com/baisuipingan/patrick-im/main/ops/install.sh | sudo env PATRICK_IM_PUBLIC_BASE_URL=https://im.example.com bash
```

默认安装目录：

```text
/opt/patrick-im
```

服务更新：

```bash
cd /opt/patrick-im
docker compose pull
docker compose up -d --remove-orphans
```

SQLite 数据库和 relay 文件默认都在 `/opt/patrick-im/data` 下，迁移和备份时保留这个目录即可。

### 手动 Compose 更新

如果服务器上已经有自己的 compose/env 布局，也可以只拉新镜像并重启：

```bash
docker compose -f ops/docker-compose.server.yml pull patrick-im-server
docker compose -f ops/docker-compose.server.yml up -d --force-recreate --remove-orphans patrick-im-server
```

本机自测容器仍然可以使用：

```bash
make release-x86
make docker-build
make docker-up
```

## Nginx/OpenResty 反代

站点入口需要代理到后端：

```nginx
location / {
    proxy_pass http://127.0.0.1:5800;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

后端健康检查：

```bash
curl http://127.0.0.1:5800/api/healthz
```

## 同步 GitHub 和 Gitee

项目同时维护 GitHub 和 Gitee 镜像时，不要手动双推安装链接相关改动。GitHub 版 README 和安装脚本默认使用 GitHub raw 地址；同步到 Gitee 时使用：

```bash
make sync-remotes
```

这个命令会先推送当前 `main` 到 GitHub，然后在临时 worktree 中把 README 和 `ops/install.sh` 里的安装地址替换成 Gitee raw 地址，再推送到 Gitee，不会污染本地 `main` 分支。
