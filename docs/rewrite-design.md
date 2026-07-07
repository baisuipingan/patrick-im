# Patrick-IM Rewrite Design

## Product Shape

Patrick-IM is a lightweight room chat:

- A visitor opens a room from the URL hash or a typed room id.
- The server gives the visitor a signed cookie session and a guest nickname.
- Visitors in the same room see online peers, text messages, uploaded files, and optional direct-file status for private peers.
- A visitor can send to the whole room or choose one online peer for a private thread.
- Refreshing the page restores recent message history from SQLite.
- Private peers can exchange files over WebRTC DataChannel when both browsers are online and ICE succeeds.

Anything outside that shape is accidental complexity for this product.

## Complexity To Remove

- Coupling direct browser-to-browser transfer to durable message persistence.
- Client-side multipart/resume upload state machines.
- WebSocket commands that mutate durable state.
- Separate relay upload request, pending upload, part upload, and announcement tables.
- Frontend message synchronization that depends on a second WebSocket command after HTTP upload.

## New Boundary

Use REST for every durable write. Use WebSocket for subscription and lightweight WebRTC signaling.

| Capability | Method | Path | Purpose |
| --- | --- | --- | --- |
| Health | `GET` | `/api/healthz` | Container/runtime check |
| Session | `GET` | `/api/session` | Create/refresh signed visitor session |
| Rename | `PATCH` | `/api/session` | Update nickname in signed session |
| History | `GET` | `/api/rooms/:room/messages` | Load recent messages visible to current visitor |
| Send text | `POST` | `/api/rooms/:room/messages` | Persist a text message and broadcast it |
| Send file | `POST` | `/api/rooms/:room/files` | Store one file, persist one file message, broadcast it |
| Download | `GET` | `/api/files/:file` | Stream an accessible uploaded file |
| Clear thread | `DELETE` | `/api/rooms/:room/messages?targetId=` | Clear global or private thread |
| Subscribe | `GET` | `/api/rooms/:room/ws` | Receive presence/message events and forward WebRTC signals |

## Backend Shape

- `cmd/patrick-im-server`: process wiring and graceful shutdown.
- `internal/config`: environment parsing.
- `internal/session`: HMAC-signed cookie session.
- `internal/repository`: SQLite/GORM models and database opening.
- `internal/chat`: message repository, file storage, in-memory room hub.
- `internal/httpapi`: thin Gin handlers and WebSocket adapter.
- `internal/staticweb`: built frontend serving.

The useful patterns are intentionally ordinary:

- Repository pattern around GORM so HTTP handlers do not know SQL details.
- Observer/pub-sub hub for WebSocket presence and broadcasts.
- Targeted WebSocket forwarding for WebRTC offer, answer, and ICE candidate payloads.
- Transaction per write so a file message is never half-persisted.
- Stable history ordering by `(created_at, id)`, with a simple `before` cursor for older messages.

## Frontend Shape

One screen, one state model:

- Session state.
- Current room.
- Online peers.
- Current thread target.
- Message list.
- Composer/upload status.
- Direct peer connection status.
- WebSocket subscription status.

The frontend should call REST to send text and persistent files. WebSocket receives updates from other clients and forwards `signal` messages between peers. When a private peer has an open WebRTC DataChannel, the frontend may send the selected file directly; if direct transfer is unavailable, it falls back to REST upload.

Direct WebRTC file messages are local session artifacts, not durable history. Server-uploaded file messages remain the durable path.
