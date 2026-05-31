# Patrick IM

Patrick IM 是一个轻量级网页即时通讯项目，面向小团队、朋友之间或临时房间聊天场景。前端使用 React + Vite，后端使用 Rust + Axum，支持 WebSocket 实时消息、点对点信令、聊天记录持久化，以及基于 RustFS/S3 的中继文件传输。

## 功能特性

- 房间制聊天：通过房间 ID 加入同一个实时会话。
- WebSocket 实时通信：在线成员、文本消息、WebRTC 信令都走后端房间 hub。
- 直连优先、Relay 兜底：前端可优先尝试点对点传输，必要时使用 RustFS/S3 中继文件。
- 聊天记录持久化：MySQL 保存可见消息、线程清理和中继文件元数据。
- 单二进制部署：前端构建产物会输出到 `backend/server/web-dist`，Rust 编译时内嵌进服务端。
- Makefile 运维入口：开发、构建、Docker 打包、部署、日志查看都集中在 `make` 命令里。

## 技术栈

- 前端：React 19、Vite、TypeScript、Tailwind CSS、Vitest
- 后端：Rust 1.95、Axum、Tower HTTP、Tokio、SQLx、AWS S3 SDK
- 存储：MySQL、RustFS/S3-compatible object storage
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
- RustFS 或兼容 S3 的对象存储
- Docker：仅部署或本地启动 RustFS 容器时需要

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

启动本地 RustFS：

```bash
make rustfs-dev
```

RustFS 默认地址：

- API：`http://127.0.0.1:9000`
- Console：`http://127.0.0.1:9001`
- 默认账号：`rustfsadmin`
- 默认密码：`rustfsadmin`

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
| `PATRICK_IM_RUSTFS_ENDPOINT` | 服务端访问 RustFS/S3 的内网地址 |
| `PATRICK_IM_RUSTFS_PUBLIC_ENDPOINT` | 浏览器直传/直下 RustFS 时使用的公网入口 |
| `PATRICK_IM_RUSTFS_BUCKET` | 中继文件 bucket |
| `PATRICK_IM_RUSTFS_ACCESS_KEY` | RustFS/S3 access key |
| `PATRICK_IM_RUSTFS_SECRET_KEY` | RustFS/S3 secret key |
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
| `make rustfs-dev` | 启动本地测试用 RustFS 容器 |
| `make frontend-build` | 构建前端到 `backend/server/web-dist` |
| `make release` | 按当前宿主机架构构建 release 二进制 |
| `make release-x86` | 构建 `x86_64-unknown-linux-gnu` release 二进制 |
| `make docker-build` | 用现成二进制重建 runtime 镜像 |
| `make docker-up` | 重启服务容器 |
| `make deploy` | `release + docker-build + docker-up` |
| `make deploy-x86` | `release-x86 + docker-build + docker-up` |
| `make status` | 查看容器状态 |
| `make logs` | 跟随服务日志 |
| `make clean` | 清理本地构建产物 |

## 构建与部署

生产部署推荐流程：

1. 本地提交并推送代码。
2. 服务器进入项目目录执行 `git pull --ff-only`。
3. 确认 `backend/server/.env` 已按生产环境配置。
4. 执行部署：

```bash
make deploy
```

`make deploy` 会依次完成：

1. 检查并加载 Node、pnpm、Cargo 工具链。
2. 安装前端依赖并构建 Vite 产物。
3. 输出前端产物到 `backend/server/web-dist`。
4. 构建 Rust release 二进制。
5. 复制二进制到 `backend/server/build/patrick-im-server`。
6. 使用 Docker Compose 重建 runtime 镜像。
7. 重启 `patrick-im-server` 容器。

如果服务器架构是 x86_64 Linux，可以使用：

```bash
make deploy-x86
```

如果只想先构建二进制，不重启服务：

```bash
make release-x86
```

然后再手动执行：

```bash
make docker-build
make docker-up
```

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

如果启用浏览器直传 RustFS，公网反代还需要把 bucket path-style 请求直接转给 RustFS。默认 bucket 是 `patrick-im`：

```nginx
location ^~ /patrick-im/ {
    proxy_pass http://127.0.0.1:9000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_connect_timeout 60s;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_request_buffering off;
    proxy_buffering off;
}
```

如果中继下载很慢，请检查站点层是否配置了类似 `limit_rate 10240k;` 的限速规则。

## 开发约定

- 前端和后端目录分离，协议类型在 `frontend/web/shared` 和 `backend/server/src/protocol.rs` 保持同步。
- 前端生产构建先输出到 `backend/server/web-dist`，后端再把静态资源内嵌进单二进制。
- Docker 镜像只负责运行时打包，不在镜像构建阶段编译前端或 Rust。
- 远端部署不走源码同步脚本，统一使用 `git pull + make`。

## 开源许可

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
