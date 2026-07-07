# Patrick IM v2 架构方案

## 目标边界

v2 不是恢复旧页面，也不是换一层样式。最终产物要保留旧 patrick-im 的定制能力，用 Go + Gin + GORM + SQLite 继续承载单机部署优势，并把前端改成控制台式 IM 工作台：

- 左侧：房间和会话列表，包含未读、摘要、连接状态、最近房间。
- 中间：消息时间线、发送状态、复制/预览/下载/重试。
- 右侧：房间详情、成员、附件、传输队列。
- 底部：支持文本、图片、文件、粘贴、拖拽、超大文本自动转 `.txt`。
- 实时层：WebSocket 统一 envelope，负责消息推送、未读、房间成员、传输状态、WebRTC 信令。
- 文件层：优先 WebRTC P2P，服务端本地磁盘 fallback，后端不参与 P2P 文件内容。

## 目录结构

后端目标结构：

```text
backend/server/internal/config
backend/server/internal/domain
backend/server/internal/httpapi
backend/server/internal/protocol
backend/server/internal/realtime
backend/server/internal/repository
backend/server/internal/session
backend/server/internal/staticweb
backend/server/internal/transfer
backend/server/internal/util
```

前端目标结构：

```text
frontend/web/src/app
frontend/web/src/components
frontend/web/src/features/chat
frontend/web/src/features/transfer
frontend/web/src/features/webrtc
frontend/web/src/lib
frontend/web/shared
```

## 数据模型

### users

浏览器身份。一个浏览器 session 默认对应一个 user。

- `id`: string primary key
- `nickname`: string
- `created_at`: millis
- `updated_at`: millis

### rooms

房间是分享和多人临时会话的容器。

- `id`: room slug primary key
- `display_name`: string
- `created_at`: millis
- `updated_at`: millis

### room_members

记录用户进入过的房间和最后在线时间。

- `room_id`, `user_id`: composite unique
- `nickname`: string snapshot
- `role`: `owner | member`
- `joined_at`: millis
- `last_seen_at`: millis

### conversations

统一全局房间、私聊和未来群聊。

- `id`: string primary key
- `room_id`: string
- `type`: `room | direct | group`
- `title`: string
- `peer_user_id`: nullable string
- `last_message_id`: nullable string
- `last_message_text`: nullable string
- `last_message_at`: millis
- `created_at`: millis
- `updated_at`: millis

约束：

- room conversation id 固定为 `room:{room_id}`
- direct conversation id 固定为 `direct:{room_id}:{min_user_id}:{max_user_id}`

### messages

- `id`: string primary key
- `client_message_id`: nullable unique per sender
- `room_id`: string
- `conversation_id`: string
- `sender_id`: string
- `sender_name`: string
- `target_id`: nullable string
- `type`: `text | image | file | system | txt_file`
- `text`: nullable text
- `status`: `sent | deleted | revoked`
- `created_at`: millis

### attachments

- `id`: string primary key
- `message_id`: string
- `file_name`: string
- `size`: int64
- `content_type`: string
- `storage_kind`: `local | p2p | pending`
- `storage_path`: nullable string
- `checksum`: nullable string
- `previewable`: bool
- `created_at`: millis

### transfers

传输是 UI 状态和文件状态的桥，不等于消息本身。

- `id`: string primary key
- `room_id`: string
- `conversation_id`: string
- `message_id`: nullable string
- `attachment_id`: nullable string
- `sender_id`: string
- `receiver_id`: nullable string
- `transport`: `webrtc_p2p | server_fallback`
- `direction`: `upload | download`
- `state`: `queued | negotiating | transferring | paused | completed | failed | cancelled`
- `bytes_done`, `bytes_total`: int64
- `error`: nullable string
- `created_at`, `updated_at`: millis

### read_states

- `conversation_id`, `user_id`: composite primary key
- `last_read_at`: millis
- `last_read_message_id`: nullable string
- `updated_at`: millis

## Migration 策略

必须有 `schema_migrations`：

- `version`: integer primary key
- `name`: string
- `applied_at`: millis

迁移规则：

- 每个 migration 在事务里执行。
- 每个 migration 可重复启动，已记录版本直接跳过。
- `CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS` 优先。
- 需要重建表时，先读取现有 index，再 drop/rename，避免 index 已存在。
- 给旧表补非空字段时先 nullable/backfill/rebuild，避免 SQLite `NOT NULL` 陷阱。

首批 migration：

1. `001_core_im_v2`: 新建 users、rooms、room_members、conversations、messages、attachments、transfers、read_states。
2. `002_backfill_legacy_messages`: 从旧 `message_records` 回填 room/direct conversations、messages、attachments。
3. `003_indexes`: 补高频查询 index。

## REST API

保持旧接口可兼容一段时间，同时新增 v2 接口。

### Session

- `GET /api/session`: 创建或恢复 session，返回 user/session/ice/file limits。
- `PATCH /api/session`: 修改 nickname，并更新 room member snapshot。

### Rooms

- `GET /api/rooms`: 当前用户进入过的房间和最近会话摘要。
- `POST /api/rooms`: 创建或进入房间。
- `GET /api/rooms/:room_id`: 房间详情、成员、会话摘要。

### Conversations

- `GET /api/rooms/:room_id/conversations`: 会话列表。
- `POST /api/rooms/:room_id/conversations/direct`: 创建/打开私聊。
- `POST /api/conversations/:conversation_id/read`: 标记已读。

### Messages

- `GET /api/conversations/:conversation_id/messages?before=&limit=`
- `POST /api/conversations/:conversation_id/messages`
- `DELETE /api/conversations/:conversation_id/messages`

### Attachments / fallback 文件

- `POST /api/conversations/:conversation_id/attachments`
- `GET /api/attachments/:attachment_id`
- `GET /api/files/:file_id`

## WebSocket 协议

连接：

- `GET /api/rooms/:room_id/ws`
- token 来源支持 cookie、`?token=`、`Authorization: Bearer`、以及现有 subprotocol `patrick-im-session.{token}`。
- 鉴权失败返回明确 401，前端显示错误并停止无限连接中。

统一 envelope：

```json
{
  "type": "message_created",
  "request_id": "optional-client-request-id",
  "room_id": "lobby",
  "conversation_id": "room:lobby",
  "payload": {},
  "created_at": 1783420000000,
  "error": null
}
```

事件：

- client -> server: `send_message`, `mark_read`, `transfer_update`, `webrtc_offer`, `webrtc_answer`, `webrtc_ice`, `ping`
- server -> client: `room_snapshot`, `message_created`, `message_ack`, `unread_updated`, `room_updated`, `member_updated`, `transfer_updated`, `webrtc_offer`, `webrtc_answer`, `webrtc_ice`, `error`, `pong`

ack 规则：

- 每个 client mutation 带 `request_id`。
- 成功返回同 request_id 的 `message_ack` 或对应 ack。
- 失败返回同 request_id 的 `error`。
- 断线重连后，前端用 REST 补历史和 unread，不依赖内存事件完全可靠。

## 前端状态设计

核心 store 可以先用 React hooks，不引入重量状态库：

- `session`: 当前用户、token、限制、ICE。
- `rooms`: 最近房间、当前房间详情。
- `conversations`: 会话列表、active conversation、unread。
- `messages`: 按 conversation 分页缓存。
- `transfers`: transfer row map。
- `connection`: websocket 状态、错误、重连次数。
- `webrtc`: peer connection、data channel、direct path、incoming/outgoing transfers。

组件：

- `AppShell`
- `Sidebar`
- `ConversationList`
- `ChatHeader`
- `MessageTimeline`
- `MessageBubble`
- `MessageActions`
- `Composer`
- `TransferPanel`
- `RoomDetailsPanel`
- `AttachmentPreview`

## 文件和图片策略

- `text`: 小于等于 200 KiB，作为文本消息。
- `txt_file`: 大于 200 KiB 且小于等于 1 MiB，前端生成 `.txt` 文件走 attachment。
- `image`: content-type 为 `image/*` 的 attachment，时间线直接预览。
- `file`: 其他 attachment。
- P2P 文件：只存传输元数据和本地 UI 消息；若需要历史可下载，必须 fallback 上传。
- fallback 文件：后端保存到本地磁盘，附件入库，权限校验后下载。

## 验收矩阵

后端：

- `go test ./...`
- 空库启动生成完整 schema。
- 旧 `message_records` 库升级后历史消息可读。
- 重复启动不重复迁移、不报 index exists。
- WebSocket cookie/query/header/subprotocol 鉴权测试。
- 消息分页、未读、附件权限测试。

前端：

- `pnpm test`
- `pnpm build`
- 状态机测试：发送消息、unread、超大文本转文件、transfer pause/cancel。

浏览器：

- 两个上下文进入同房间。
- 发送文本、图片粘贴、文件上传、断线重连、新消息角标。
- 桌面和移动截图无溢出、无重叠。

部署：

- `make test`
- `make release-x86`
- `make publish-x86`
- `docker compose up -d --force-recreate --remove-orphans`

