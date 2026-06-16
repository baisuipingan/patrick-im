# Patrick IM

Patrick IM 是一个轻量级网页即时通讯项目，面向小团队、朋友之间或临时房间聊天场景。前端使用 React + Vite，后端使用 Rust + Axum，支持 WebSocket 实时消息、点对点信令、聊天记录持久化，以及本地磁盘文件传输。

## 功能特性

- 房间制聊天：通过房间 ID 加入同一个实时会话。
- WebSocket 实时通信：在线成员、文本消息、WebRTC 信令都走后端房间 hub。
- 直连优先、Relay 兜底：前端可优先尝试点对点传输，必要时使用服务器本地文件存储中继。
- 聊天记录持久化：MySQL 保存可见消息、线程清理和中继文件元数据。
- 单二进制部署：前端构建产物会输出到 `backend/server/web-dist`，Rust 编译时内嵌进服务端。
- Makefile 运维入口：开发、构建、Docker 打包、部署、日志查看都集中在 `make` 命令里。

## 技术栈

- 前端：React 19、Vite、TypeScript、Tailwind CSS、Vitest
- 后端：Rust 1.95、Axum、Tower HTTP、Tokio、SQLx、object_store
- 存储：MySQL、本地磁盘文件存储
- 部署：Docker Compose、OpenResty/Nginx 反向代理

## 项目结构

```text
frontend/web                  React + Vite 前端
frontend/web/shared           前后端共享协议类型
backend/server                Rust Axum 后端
backend/server/web-dist       前端生产构建产物，Rust 编译时内嵌
backend/server/build          发布二进制输出目录
backend/server/migrations     SQLx 数据库迁移
ops/docker-compose.server.yml 运行时容器定义
ops/openresty                 OpenResty/Nginx 示例配置
Makefile                      开发、构建和部署统一入口
```

## 环境要求

- Rust toolchain：项目使用 `rust-toolchain.toml` 固定到 `1.95.0`
- Node.js + Corepack
- pnpm：由 `frontend/web/package.json` 的 `packageManager` 指定
- MySQL
- 本地磁盘目录用于文件存储
- Docker：用于部署服务容器时需要
- 可选：`cargo-zigbuild`，推荐在 macOS 上交叉编译 Linux x86_64 二进制时使用

可以先检查本机工具链：

```bash
make env-check
```

## 本地开发

准备后端环境变量：

```bash
cp backend/server/.env.local.example backend/server/.env.local
```

`make backend-dev` 会优先读取 `backend/server/.env.local`，如果不存在才读取 `backend/server/.env`。

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
| `PATRICK_IM_LOG` | Rust tracing 过滤器，例如 `info,tower_http=info,axum=info` |
| `PATRICK_IM_PUBLIC_BASE_URL` | 站点公网地址，用于生成公开 URL 和推断 cookie 安全策略 |
| `PATRICK_IM_SECURE_COOKIES` | 是否给 session cookie 加 `Secure`；生产 HTTPS 建议 `true` |
| `PATRICK_IM_MYSQL_URL` | MySQL 连接串 |
| `PATRICK_IM_FILE_STORE_PATH` | 本地文件存储目录 |
| `PATRICK_IM_SESSION_SECRET` | session 签名密钥，生产必须换成足够长的随机字符串 |
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
| `make env-check` | 检查 node/corepack/cargo/docker |
| `make frontend-dev` | 启动 Vite 前端开发服务 |
| `make backend-dev` | 启动 Rust Axum 后端开发服务 |
| `make frontend-build` | 构建前端到 `backend/server/web-dist` |
| `make release` | 按当前宿主机架构构建 release 二进制 |
| `make release-x86` | 构建 `x86_64-unknown-linux-gnu` release 二进制 |
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

生产部署推荐改为本机完成构建和镜像发布，服务器只拉取公共镜像并重启容器。Dockerfile 只复制本机已经编译好的 `backend/server/build/patrick-im-server`，不会在 Docker 镜像里编译前端或 Rust。

发布默认 `latest` 镜像：

```bash
make publish-x86
```

`make publish-x86` 会依次完成：

1. 检查并加载 Node、pnpm、Cargo 工具链。
2. 安装前端依赖并构建 Vite 产物。
3. 输出前端产物到 `backend/server/web-dist`。
4. 交叉编译 `x86_64-unknown-linux-gnu` release 二进制。
5. 复制二进制到 `backend/server/build/patrick-im-server`。
6. 用本地二进制构建 `linux/amd64` runtime 镜像。
7. 给镜像打上远端 tag 并 push。

如果 macOS 上已经安装 `cargo-zigbuild`，`make release-x86` 会优先使用它交叉编译，通常比直接 `cargo build --target x86_64-unknown-linux-gnu` 更稳。

### 新服务器一键安装

新服务器推荐直接使用一键安装脚本，不需要在服务器拉源码或本地构建。脚本只检查 Docker Engine 和 Docker Compose plugin 是否存在，不会替你安装 Docker；检查通过后会生成 `/opt/patrick-im/.env`，创建 MySQL 和文件存储目录，然后拉起服务：

```bash
curl -fsSL https://gitee.com/cai-happy/patrick-im/raw/main/ops/install.sh | sudo bash
```

也可以把公网地址一起传入：

```bash
curl -fsSL https://gitee.com/cai-happy/patrick-im/raw/main/ops/install.sh | sudo env PATRICK_IM_PUBLIC_BASE_URL=https://im.example.com bash
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

后端启动时会自动确保 MySQL database 存在，然后按 `backend/server/migrations` 内嵌的 SQLx migrations 逐层升级。已有迁移不会重复执行。

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

如果服务器是 x86_64 Linux，请保持默认 `DOCKER_PLATFORM=linux/amd64`。如果以后要发布到 ARM 服务器，可以显式调整平台和 Rust target 后再构建。


## 日志

后端使用 `tracing_subscriber` pretty/text 日志，时间固定为东八区，格式为：

```text
yyyy-MM-dd hh:mm:ss
```

查看容器日志：

```bash
make logs
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

上传接口现在直接由后端接收分片并写入本地文件目录，因此反代只需要转发到后端即可。

## 开发约定

- 前端和后端目录分离，协议类型在 `frontend/web/shared` 和 `backend/server/src/protocol.rs` 保持同步。
- 前端生产构建先输出到 `backend/server/web-dist`，后端再把静态资源内嵌进单二进制。
- Docker 镜像只负责运行时打包，不在镜像构建阶段编译前端或 Rust。
- 远端部署不在服务器构建源码，统一由本机交叉编译、打镜像并推送到镜像仓库，服务器只拉取镜像重启。

## 开源许可

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
