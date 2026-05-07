# Patrick IM

## 目录

- `frontend/web`: React + Vite 前端
- `backend/server`: Rust + Salvo 服务端
- `backend/server/web-dist`: 前端生产构建产物，Rust 编译时内嵌
- `backend/server/build`: 发布二进制输出目录
- `ops/docker-compose.server.yml`: 运行时容器定义
- `Makefile`: 构建、发版、重启容器的统一入口

## 本地开发

准备后端环境变量：

```bash
cp backend/server/.env.example backend/server/.env
```

前端开发：

```bash
corepack enable
cd frontend/web
pnpm install
pnpm run dev
```

后端开发：

```bash
cargo run -p patrick-im-server
```

默认地址：

- 前端开发页：`http://127.0.0.1:5173`
- Rust 服务：`http://127.0.0.1:5800`

和中继上传直接相关的环境变量：

- `PATRICK_IM_RUSTFS_ENDPOINT`: 服务端容器访问 RustFS 的内网地址
- `PATRICK_IM_RUSTFS_PUBLIC_ENDPOINT`: 浏览器直传/直下 RustFS 时使用的公网入口，默认回退到 `PATRICK_IM_PUBLIC_BASE_URL`

## 发版命令

统一用 `Makefile`：

```bash
make help
```

最常用的几个目标：

- `make release`: 按当前宿主机架构构建前端和 Rust release 二进制
- `make release-x86`: 构建 `x86_64-unknown-linux-gnu` release 二进制
- `make docker-build`: 用现成二进制重建 runtime 镜像
- `make docker-up`: 重启容器
- `make deploy`: `release + docker-build + docker-up`
- `make deploy-x86`: `release-x86 + docker-build + docker-up`
- `make status`: 查看当前容器状态
- `make logs`: 跟随服务日志

## 服务器部署流程

你要的最简单流程就是：

1. 本地提交并 push
2. 服务器进入项目目录执行 `git pull --ff-only`
3. 然后执行：

```bash
make deploy
```

这一个命令会顺序完成：

1. 加载 `nvm` 和 `cargo` 环境
2. 前端 `corepack pnpm install --frozen-lockfile --prefer-offline && corepack pnpm run build`
3. 产物输出到 `backend/server/web-dist`
4. Rust `cargo build --release --target x86_64-unknown-linux-gnu`
5. 二进制复制到 `backend/server/build/patrick-im-server`
6. `docker compose build`
7. `docker compose up -d --force-recreate`

如果你只是想先看二进制能不能出，再决定是否重启容器，就先跑：

```bash
make release-x86
```

然后再跑：

```bash
make docker-build
make docker-up
```

## 设计原则

- 前端和后端目录彻底分开
- 前端先构建，后端再把静态资源内嵌进单二进制
- Docker 不负责编译，只负责运行时打包
- 远端部署不走源码同步脚本，只走 `git pull + make`

## Nginx 反代要求

如果你要启用浏览器直传 RustFS，公网反代必须把 bucket path-style 请求直接转给 RustFS。

对当前默认 bucket `patrick-im`，至少需要一段和下面等价的配置：

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

如果你想让中继下载不被站点层限速，再确认站点配置里不要有类似 `limit_rate 10240k;` 这种限制。
