# Patrick IM v2 功能盘点

## 盘点范围

- 当前工作分支：`refactor/im-frontend-v2`，从本地 `main` 的 `71962ee` 创建。
- 当前实现基线：`main` / `71962ee`，提交信息为 `Revert "Restore full chat frontend"`。
- 旧功能重点来源：`e4ef239`，提交信息为 `Restore full chat frontend`；同时参考 `eddc33f`、`e6cde6a`、`d8c1282`、`4248df4`、`e0bc61e`、`d039d76` 等 relay / upload / oversized-text 相关历史提交。
- 当前代码路径：`frontend/web`、`backend/server`、`ops`。
- 旧 Rust 后端已不在 tracked files 中；本次检查 `git ls-files` 未发现 `*.rs`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain*` 或 `target/`。

## 参考源与许可证

| 参考源 | 本地位置 | 版本/来源 | 许可证结论 | 使用策略 |
| --- | --- | --- | --- | --- |
| MonkeyCode | `.artifacts/reference-repos/MonkeyCode` | GitHub archive `main`，HEAD `950f7fbde13b3ef5912bc221191c23e7f0b0524b` | 本地 `LICENSE` 为 AGPL-3.0 | 只参考 console/tasks 的视觉密度、布局和交互气质；不复制代码、样式 token、组件实现或文案。 |
| LumenIM | `.artifacts/reference-repos/LumenIM` | GitHub archive `master`，HEAD `45462259a0deae87067c2bfa074396b5938033a6` | 本地未发现 `LICENSE` 文件；README 只有 GitHub license badge | 只参考 IM 业务形态和交互，不复制源码；后续如需复制任何实现，先补充许可证确认。 |
| go-chat | `.artifacts/reference-repos/go-chat` | shallow clone HEAD `cb66a43` | 本地未发现顶层 `LICENSE` 文件 | 只参考后端业务模型、事件和 API 划分，不复制源码；后续如需复制任何实现，先补充许可证确认。 |

`.artifacts/` 已加入本地 `.git/info/exclude`，不会进入提交。

## 当前实现概览

- 前端：React + Vite + TypeScript，入口集中在 `frontend/web/src/App.tsx`，少量模型函数在 `app-model.ts`，WebRTC 文件逻辑在 `webrtc.ts`。
- 后端：Go + Gin + GORM + SQLite，主要模块为 `internal/httpapi`、`internal/chat`、`internal/repository`、`internal/session`、`internal/protocol`、`internal/staticweb`。
- 部署：`Makefile` 保留 `make test`、`make frontend-build`、`make release-x86`、`make publish-x86`、`make docker-up`、`make deploy-x86`；Docker 运行单 Go binary + `web-dist`，SQLite 和文件目录挂载到 `/app/data`。
- 当前 WebSocket：`/api/rooms/:room_id/ws` 兼容旧 `presence/message/messages-cleared/signal`，同时已支持 v2 envelope：`room_snapshot`、`message_created`、`message_ack`、`unread_updated`、`room_updated`、`member_updated`、`webrtc_offer/answer/ice`；断线 cursor replay 仍待增强。
- 当前 REST：已保留旧 session/room messages/room files/file download/clear messages/health，并新增 rooms、room detail、conversations、direct conversation、conversation messages、attachments、mark read、attachment info。
- 当前 SQLite migration：已引入 `schema_migrations`、v2 IM 表和 legacy `message_records` 回填，覆盖空库、旧库、重复启动测试。

## 旧项目定制能力

旧功能不是只来自当前 `main`，核心在被 revert 的 `e4ef239`：

- 直接房间链接、复制房间链接、最近房间、本地记忆最后房间。
- 全局房间线程 + 每个在线 peer 的私聊线程。
- 会话 unread counter，切换线程时清零，非当前线程新消息高亮。
- WebSocket 状态区分 `idle`、`connecting`、`reconnecting`、`connected`、`paused`、`closed`、`error`。
- 房间快照、peer join/leave、chat event、thread clear、signal、pong/error 等事件处理。
- 文本复制、图片复制到剪贴板。
- 图片/文件粘贴到输入框、拖拽文件、附件队列。
- Enter 发送，Shift/Ctrl/Meta/Alt+Enter 插入换行，并处理中文输入法 composition。
- 超过 200 KiB 的文本自动生成 `message-YYYYMMDD-HHMMSS.txt`；文本硬限制为 1 MiB。
- 直连 WebRTC 文件传输：control channel、file offer/accept/decline/received/complete/failed/cancel 消息。
- 直连路径识别：LAN / STUN / TURN / unknown，并在 UI 里提示路径质量。
- Chromium File System Access API：选择接收目录，IndexedDB 保存 directory handle，接收时尽量直接写入磁盘；不支持时降级内存 Blob URL。
- 服务端 relay 文件：上传请求、分片上传、part ack、complete、abort、discard、pending abort/announce 队列。
- relay 上传支持暂停、继续、取消、断网自动暂停、恢复后继续、并发上传、速度和状态提示。
- 清空当前线程时同步取消该线程 relay 上传。

## 参考系统可借鉴点

- MonkeyCode console/tasks：左侧窄导航 + 主工作区 + 右侧/详情面板；细边框、低阴影、高信息密度；按钮/输入/徽标状态紧凑；适合 v2 的 AppShell、ConversationList、MessageTimeline、TransferPanel。
- LumenIM：会话列表 `ISession` 包含 `talk_mode`、`to_from_id`、`unread_num`、`msg_text`、`updated_at`；消息记录 `ITalkRecord` 有 `msg_type`、`is_revoked`、`status`、`extra`；支持文本、代码、图片、音频、视频、文件、转发、投票、图文、群公告等类型。
- go-chat：后端区分 private/group talk mode；push event 包含 `im.message`、`im.message.revoke`、`im.contact.status` 等；talk session API 支持会话创建、删除、置顶、免打扰、列表、清未读；长连接 packet 有 ping/pong/ack/authorize 语义。

## 差异表

| 功能 | 旧 patrick-im 功能 | 当前实现 | 可借鉴点 | 本次 v2 实现方案 | 验收方式 |
| --- | --- | --- | --- | --- | --- |
| 房间进入 | hash 房间、最近房间、复制分享链接、进入后 room snapshot | hash 房间，输入 room id 进入；无最近房间和分享按钮 | LumenIM 会话列表；MonkeyCode 侧栏密度 | 保留 hash 直达；新增 Room / Conversation 列表、最近房间、复制分享、移动端抽屉 | 两个浏览器用同一链接进入同房间；刷新后恢复最近房间。 |
| 会话身份 | cookie/session token、nickname 本地持久化、peer nickname | cookie + signed token；nickname 存 localStorage 并 PATCH session | go-chat session/user 与 talk session 分离 | 保留轻 session；新增 User/Session 模型和可恢复 session API | 清 cookie 后生成新身份；保留 cookie 时刷新恢复同 clientId/nickname。 |
| WebSocket 信令 | room snapshot、peer joined/left、chat-event、thread-cleared、signal、pong/error；状态可重连 | 旧事件兼容；v2 envelope、`send_message` ack、`webrtc_offer/answer/ice` 转发已实现；cursor replay 未实现 | go-chat packet ack/authorize；旧 use-room-connection 状态模型 | 统一 envelope：`type/request_id/room_id/payload/created_at/error`；支持 `message_ack`、reconnect cursor、明确 401 错误 | WS 断开重连后不丢未读；401 时 UI 显示可恢复错误。 |
| WebRTC 点对点 | direct peer mesh、路径识别、control channel、直连文件 offer/accept/cancel | `DirectMesh` 已接入新 UI；v2 信令、P2P 进度、暂停、取消、失败 fallback 已实现；路径识别未实现 | 旧 peer-mesh 的控制消息；MonkeyCode 状态徽标 | 重建 WebRTC transfer state machine；后端仅转发 `webrtc_offer/answer/ice` | Playwright 双上下文发送直连文件；失败时显示原因并可 fallback。 |
| 文本消息 | socket `chat-send`，发送状态和系统消息 | REST POST text，成功后插入；失败 notice | LumenIM `status` 字段 | 统一 REST/WS ack：optimistic local message -> ack -> sent/failed/retry | 断网发送显示失败，可重试；成功消息不重复。 |
| 图片消息 | 图片作为文件/relay/direct，previewable，复制图片 | 当前只有 file kind；图片文件可 inline 下载但消息气泡不预览 | LumenIM ImageMessage | `Message.type=image` 或 file+image attachment；缩略图、预览、复制、下载 | 粘贴 PNG 后出现预览；可复制图片到剪贴板。 |
| 文件消息 | relay-file/direct-file，状态、下载、路径标识 | server file upload/download；direct file 只在本地消息出现 | LumenIM FileMessage；go-chat upload API | Attachment + Transfer 分离；持久文件走 server fallback，P2P 文件保存传输元数据 | 历史文件可下载；直连文件显示 direct-p2p 标识。 |
| 新消息高亮/角标 | 每线程 unread count；切换线程清零 | 无 unread | LumenIM `unread_num`、talk clear unread | 后端 `read_states` + 前端 local optimistic unread；`unread_updated` 事件 | 在私聊页收到全局消息，左侧全局会话角标 + 高亮。 |
| 文本复制 | 消息操作复制文本，复制成功状态 | 无复制按钮 | LumenIM context menu | MessageActions 中加 copy text；失败显示 toast/notice | 点击复制后剪贴板内容等于原文。 |
| 图片复制 | previewable image fetch blob + ClipboardItem | 无图片复制 | 旧实现 | MessageActions 中 image copy；不支持时回退为复制图片 URL/提示 | Chromium 可复制图片；Safari/Firefox 有自然降级提示。 |
| 文件传输进度 | direct/relay 都有 transfer row、速度、状态 | server fallback 有 XHR progress；P2P send/receive progress 已接入 `TransferPanel` | 旧 transfer-state；MonkeyCode progress/status density | `TransferPanel` 显示方向、transport、进度、速度、剩余时间、状态 | 发送大文件时进度持续更新，不挤压布局。 |
| 文件传输暂停 | relay 支持手动暂停和断网暂停 | P2P 发送支持暂停/继续；server fallback 单请求上传暂不支持暂停 | 旧 relay upload task | server fallback 分片上传可暂停；P2P 先支持 cancel/retry，pause 作为可控状态 | 上传中点击暂停，网络请求停止，状态可继续。 |
| 文件传输取消 | direct cancel、relay abort/discard、pending abort queue | P2P 发送会发 cancel control；server fallback 可 abort XHR | 旧 direct control + relay abort | Transfer cancel 统一入口；server fallback 调 abort；P2P 发 cancel control | 取消后对端也显示取消，服务端临时文件被清理。 |
| 粘贴图片/文件 | clipboard files 进入附件队列 | 不支持，只有文件选择器 | LumenIM editor image/file handlers | Composer 处理 paste/drop；图片自动作为 image attachment | 从截图工具复制图片后可直接发送。 |
| 超大文本转 txt | >200 KiB 转 `.txt`，1 MiB 硬限制 | 后端 text >64 KiB 直接失败 | 旧 send-actions | 前端 >200 KiB 自动生成 txt attachment；后端接受 `txt_file` 消息类型 | 粘贴 210 KiB 文本后发送为 `.txt` 文件；普通文本仍为 text。 |
| 浏览器选择保存位置 | File System Access API 选择接收目录并持久化 | 附件保存按钮已优先调用 `showSaveFilePicker`，不支持时 Blob download | 旧 file-system helper | Transfer settings 保存 receive directory；不支持时 Blob download | Chromium 直连接收直接落到选中目录；Firefox 降级下载。 |
| P2P 直接写磁盘 | direct incoming writer 流式写入文件 | 当前 direct 收完整内存 Blob，保存时可选择位置；尚未边接收边写入磁盘 | 旧 peer-mesh writer chain | DataChannel chunk -> FileSystemWritableFileStream；校验完成后通知发送端 | 大文件接收不需要先占用完整内存 Blob。 |
| 清空会话 | 可清空全局/私聊，并取消相关 relay 上传 | DELETE 当前 thread；广播 messages-cleared | LumenIM 会话删除/清 unread | 保留清空线程；加确认弹窗、取消相关 transfers、更新 unread/read state | 清空私聊不影响全局消息；相关上传被取消。 |
| 房间成员/详情 | peers + direct path + 成员状态 | 只在左侧 peer 列表粗略展示 | LumenIM group member panel | 右侧 RoomDetailsPanel 展示成员、在线状态、直连路径、房间链接 | 成员上下线实时更新，移动端可打开详情面板。 |
| 文件/传输面板 | 传输列表独立，支持操作 | 只有单条 upload row | MonkeyCode 右侧 panel；旧 TransferRow | 右侧 TransferPanel + Attachments view | 多个传输可同时显示和操作。 |
| 消息分页 | history `limit/before` | 有 `limit/before`，前端只加载一次默认历史 | LumenIM load more | Timeline 顶部加载更多，保持滚动锚点 | 上拉加载旧消息，顺序稳定不跳动。 |
| 后端模型 | legacy message + relay records | 单表 `message_records` | go-chat talk/message/session model | 新增 `users/sessions/rooms/room_members/conversations/messages/attachments/transfers/read_states` | 空库 migration 后表结构完整，重复启动无变化。 |
| SQLite migration | legacy rewrite，曾修 index 问题 | AutoMigrate + legacy rewrite，无版本表 | 项目历史问题清单 | 引入 `schema_migrations`，每个 migration 幂等，重建表先处理 indexes | 空库、旧库、重复启动测试全部通过。 |
| 服务器 fallback 文件 | 当前 `/api/rooms/:room/files` 上传本地磁盘 | 可用，但与 transfer/attachment 模型耦合 | go-chat split upload；旧 relay API | 保留本地磁盘 fallback；分片/断点为后续扩展，先提供元数据和清理 | 服务端文件上传、下载、权限检查通过。 |
| 部署 | make + Docker Compose 单服务 | 可用 | 当前 README/Makefile | 保持 `make publish-x86`、`make docker-up`、install.sh；新 API 不增加外部服务 | `make test`、`make release-x86`、镜像启动通过。 |

## v2 最小业务模型建议

- `users`: 浏览器身份，昵称，创建时间。
- `sessions`: session token hash、user id、过期时间、last seen。
- `rooms`: room id/slug、display name、created_at、updated_at。
- `room_members`: room id、user id、nickname snapshot、role、joined_at、last_seen_at。
- `conversations`: room/global/private/group 会话；包含 last message、updated_at。
- `messages`: id、conversation_id、room_id、sender_id、type、text、created_at、client_msg_id、status。
- `attachments`: message_id、file_name、size、content_type、storage_kind、storage_path/object_key、previewable、checksum。
- `transfers`: transfer_id、message_id/attachment_id、transport、sender_id、receiver_id、state、bytes_done、bytes_total、error。
- `read_states`: conversation_id、user_id、last_read_message_id 或 last_read_at。
- `webrtc_signals`: 不长期入库；只做 transient envelope 转发和必要审计日志。

## API / 事件验收清单

REST 至少需要：

- `POST /api/session` 或 `GET /api/session`：创建/恢复 session。
- `GET /api/rooms`：房间列表/最近房间。
- `GET /api/rooms/:room_id`：房间详情、成员摘要。
- `GET /api/rooms/:room_id/messages?before=&limit=`：分页历史。
- `POST /api/rooms/:room_id/messages`：发送 text / txt_file 元数据。
- `POST /api/rooms/:room_id/attachments`：server fallback 文件上传。
- `GET /api/attachments/:attachment_id`：附件信息。
- `GET /api/files/:file_id`：下载。
- `POST /api/conversations/:conversation_id/read`：标记已读。

WebSocket event 至少需要：

- client -> server：`send_message`、`mark_read`、`webrtc_offer`、`webrtc_answer`、`webrtc_ice`、`transfer_update`、`ping`。
- server -> client：`message_created`、`message_ack`、`unread_updated`、`room_updated`、`member_updated`、`transfer_updated`、`webrtc_offer`、`webrtc_answer`、`webrtc_ice`、`error`、`pong`。

## Phase 1 结论

当前分支已经完成 v2 垂直切片：Go/Gin/GORM/SQLite 后端、版本化 migration、rooms/conversations/messages/attachments/read state、统一 WebSocket envelope、React 控制台式三栏 UI、粘贴/拖拽附件、超大文本转 `.txt`、复制/保存、P2P WebRTC 文件传输和服务端 fallback。后续增强重点是 cursor replay、server fallback 分片暂停续传、P2P 接收时流式写入磁盘和更完整的路径质量识别。
