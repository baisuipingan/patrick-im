# Patrick IM Rust Architecture

## 目标

把 Patrick IM 收敛成一套单机优先、边界清晰的 Rust 服务：

- 房间
- 文本消息
- WebRTC 信令
- P2P 文件直传
- 服务端中继文件兜底
- 聊天记录和文件引用持久化

## 当前架构

### 前端

- React 19 + Vite
- 浏览器原生 WebRTC DataChannel
- File System Access API

前端不改成 Rust/WASM。原因很直接：这部分强依赖浏览器原生 API，改语言不会提升传输性能，只会增加维护复杂度。

### 后端

- Salvo: HTTP + WebSocket
- SQLx + MySQL: 消息和文件引用
- RustFS S3 API: relay 文件对象体
- Tokio: 异步运行时

### 运行时状态

- 进程内存:
  - 当前在线 WebSocket
  - 房间成员实时视图
  - WebRTC 信令转发
  - 尚未完成 announce 的短时上传状态
- MySQL:
  - 文本消息
  - relay 文件元数据
  - 文件引用关系
  - 线程清理依据
- RustFS:
  - relay 文件对象本体

## 为什么不保留 Redis

这版目标是单机部署。单机下最关键的实时状态是 WebSocket sender、DataChannel、连接代次，这些东西天然只能存在当前进程内存里，Redis 不能替代它们。

如果同时把：

- 在线连接放内存
- presence 放 Redis
- 消息放 MySQL

就会变成三套状态源，复杂度高于收益。

所以当前版本的原则是：

- 实时连接态只放内存
- 持久数据只放 MySQL
- 大文件对象只放 RustFS

后续只有在“多实例横向扩容”真的发生时，才考虑引入 Redis pub/sub 或独立消息总线。

## 当前已完成

- 匿名 session
- 房间 WebSocket
- 文本消息广播
- WebRTC 信令转发
- 私聊 / 全局聊天线程清理
- MySQL 消息持久化
- MySQL relay 文件元数据与引用持久化
- RustFS multipart relay 上传
- relay 文件访问鉴权与流式下载
- 前端静态资源由 Rust 服务直接托管

## 当前未完成

- 生产服务器真实联调
- 前端默认流量切到 Rust 正式环境
- 多实例广播与扩容策略

## 下一步

1. 在服务器上把 MySQL、RustFS、OpenResty、Rust 服务全链路跑通。
2. 用真实前端对接 Rust 服务做回归测试。
3. 跑一次真实部署回归，包括清空线程、relay 上传、私聊可见性。
4. 只有当单机不够用时，再讨论 Redis / pubsub / 多实例。
