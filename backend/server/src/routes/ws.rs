use crate::protocol::{ClientToServerMessage, RoomPeer, ServerToClientMessage};
use crate::session::require_session;
use crate::state::AppState;
use crate::store::message_store::normalize_target_id;
use crate::utils::sanitize_room_id;
use futures_util::{SinkExt, StreamExt};
use salvo::prelude::*;
use salvo::websocket::{Message, WebSocketUpgrade};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

#[handler]
pub async fn room_ws(
    req: &mut Request,
    depot: &mut Depot,
    res: &mut Response,
) -> Result<(), StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?
        .clone();
    let room_id = sanitize_room_id(&req.param::<String>("room_id").unwrap_or_default());
    if room_id.trim().is_empty() {
        return Err(StatusError::bad_request().brief("missing room_id"));
    }

    let session = require_session(req, &state.config.session_secret)
        .map_err(|error| {
            StatusError::internal_server_error().brief(format!("session decode error: {error}"))
        })?
        .ok_or_else(|| StatusError::unauthorized().brief("missing session"))?;

    let client_id = session.clientId.clone();
    let nickname = session.nickname.clone();
    WebSocketUpgrade::new()
        .upgrade(req, res, move |ws| async move {
            handle_socket(state, room_id, client_id, nickname, ws).await;
        })
        .await
}

async fn handle_socket(
    state: AppState,
    room_id: String,
    client_id: String,
    nickname: String,
    ws: salvo::websocket::WebSocket,
) {
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut rx = UnboundedReceiverStream::new(rx);
        while let Some(message) = rx.next().await {
            if ws_tx.send(Message::text(message)).await.is_err() {
                break;
            }
        }
    });

    let joined = state
        .room_hub
        .join_room(&room_id, &client_id, &nickname, tx.clone())
        .await;
    let connection_id = joined.connection_id.clone();
    let messages = match state
        .message_store
        .list_visible_messages(&room_id, &client_id)
        .await
    {
        Ok(messages) => messages,
        Err(error) => {
            tracing::error!(room_id, client_id, error = %error, "failed to load visible messages");
            Vec::new()
        }
    };
    let snapshot = ServerToClientMessage::RoomSnapshot {
        roomId: room_id.clone(),
        peers: joined.peers,
        messages,
        serverTime: crate::utils::now_ms(),
    };
    let _ = state.room_hub.send_json(&tx, &snapshot);
    state
        .room_hub
        .broadcast(
            &room_id,
            Some(&client_id),
            None,
            &ServerToClientMessage::PeerJoined {
                peer: RoomPeer {
                    clientId: joined.joined_peer.clientId.clone(),
                    nickname: joined.joined_peer.nickname.clone(),
                    joinedAt: joined.joined_peer.joinedAt,
                },
            },
        )
        .await;

    while let Some(Ok(message)) = ws_rx.next().await {
        if message.is_close() {
            break;
        }
        if !message.is_text() {
            continue;
        }

        let Some(text) = message.as_str().ok().map(ToOwned::to_owned) else {
            continue;
        };
        if !state
            .room_hub
            .is_current_connection(&room_id, &client_id, &connection_id)
            .await
        {
            break;
        }
        state
            .room_hub
            .touch(&room_id, &client_id, &connection_id)
            .await;

        let payload: ClientToServerMessage = match serde_json::from_str(&text) {
            Ok(payload) => payload,
            Err(_) => {
                let _ = state.room_hub.send_json(
                    &tx,
                    &ServerToClientMessage::Error {
                        code: "invalid_json".to_owned(),
                        message: "消息解析失败。".to_owned(),
                    },
                );
                continue;
            }
        };

        match payload {
            ClientToServerMessage::Ping => {
                let _ = state.room_hub.send_json(
                    &tx,
                    &ServerToClientMessage::Pong {
                        serverTime: crate::utils::now_ms(),
                    },
                );
            }
            ClientToServerMessage::SetProfile { nickname } => {
                rename_peer(&state, &room_id, &client_id, &connection_id, nickname).await;
            }
            ClientToServerMessage::ChatSend { text, targetId } => {
                handle_chat_send(&state, &room_id, &client_id, &connection_id, text, targetId)
                    .await;
            }
            ClientToServerMessage::Signal { targetId, payload } => {
                forward_signal(
                    &state,
                    &room_id,
                    &client_id,
                    &connection_id,
                    &targetId,
                    payload,
                )
                .await;
            }
            ClientToServerMessage::RelayFileAnnounced { file } => {
                handle_relay_file(&state, &room_id, &client_id, &connection_id, file, &tx).await;
            }
        }
    }

    remove_peer(&state, &room_id, &client_id, &connection_id).await;
}

async fn rename_peer(
    state: &AppState,
    room_id: &str,
    client_id: &str,
    connection_id: &str,
    nickname: String,
) {
    let Some(updated) = state
        .room_hub
        .rename_peer(room_id, client_id, connection_id, nickname)
        .await
    else {
        return;
    };

    state
        .room_hub
        .broadcast(
            room_id,
            None,
            None,
            &ServerToClientMessage::PeerJoined { peer: updated },
        )
        .await;
}

async fn handle_chat_send(
    state: &AppState,
    room_id: &str,
    client_id: &str,
    connection_id: &str,
    text: String,
    target_id: Option<String>,
) {
    if text.trim().is_empty() {
        return;
    }
    if !state
        .room_hub
        .is_current_connection(room_id, client_id, connection_id)
        .await
    {
        return;
    }
    let Some(from_name) = state.room_hub.display_name_for(room_id, client_id).await else {
        return;
    };
    let normalized_target = match normalize_target_id(client_id, target_id) {
        Some(target) if state.room_hub.is_client_connected(room_id, &target).await => Some(target),
        _ => None,
    };
    let recipients = normalized_target
        .clone()
        .map(|target| vec![client_id.to_owned(), target]);
    let message = match state
        .message_store
        .persist_text_message(room_id, client_id, &from_name, normalized_target, &text)
        .await
    {
        Ok(message) => message,
        Err(error) => {
            tracing::error!(room_id, client_id, error = %error, "failed to persist text message");
            return;
        }
    };

    state
        .room_hub
        .broadcast(
            room_id,
            None,
            recipients.as_deref(),
            &ServerToClientMessage::ChatEvent { message },
        )
        .await;
}

async fn forward_signal(
    state: &AppState,
    room_id: &str,
    from_id: &str,
    connection_id: &str,
    target_id: &str,
    payload: crate::protocol::SignalEnvelope,
) {
    if !state
        .room_hub
        .is_current_connection(room_id, from_id, connection_id)
        .await
    {
        return;
    }
    let target = state
        .room_hub
        .resolve_signal_target(room_id, from_id, connection_id, target_id)
        .await;

    if let Some(target) = target {
        let _ = state.room_hub.send_json(
            &target,
            &ServerToClientMessage::Signal {
                fromId: from_id.to_owned(),
                payload,
            },
        );
    }
}

async fn handle_relay_file(
    state: &AppState,
    room_id: &str,
    client_id: &str,
    connection_id: &str,
    file: crate::protocol::RelayFileAnnouncement,
    tx: &crate::state::ClientTx,
) {
    if !state
        .room_hub
        .is_current_connection(room_id, client_id, connection_id)
        .await
    {
        return;
    }
    let Some(from_name) = state.room_hub.display_name_for(room_id, client_id).await else {
        return;
    };
    let confirmed_file = match state
        .relay_store
        .confirm_announced_file(room_id, client_id, file)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            let _ = state.room_hub.send_json(
                tx,
                &ServerToClientMessage::Error {
                    code: "invalid_relay_file".to_owned(),
                    message: format!("relay 文件确认失败: {error}"),
                },
            );
            return;
        }
    };
    let normalized_target = match normalize_target_id(client_id, confirmed_file.targetId.clone()) {
        Some(target) if state.room_hub.is_client_connected(room_id, &target).await => Some(target),
        _ => None,
    };
    let recipients = normalized_target
        .clone()
        .map(|target| vec![client_id.to_owned(), target]);
    let message = match state
        .message_store
        .persist_relay_file_message(
            room_id,
            client_id,
            &from_name,
            normalized_target,
            confirmed_file,
        )
        .await
    {
        Ok(message) => message,
        Err(error) => {
            let _ = state.room_hub.send_json(
                tx,
                &ServerToClientMessage::Error {
                    code: "relay_persist_failed".to_owned(),
                    message: format!("relay 文件写库失败: {error}"),
                },
            );
            return;
        }
    };

    state
        .room_hub
        .broadcast(
            room_id,
            None,
            recipients.as_deref(),
            &ServerToClientMessage::ChatEvent { message },
        )
        .await;
}

async fn remove_peer(state: &AppState, room_id: &str, client_id: &str, connection_id: &str) {
    let removed = state
        .room_hub
        .leave_room(room_id, client_id, connection_id)
        .await;

    if removed {
        state
            .room_hub
            .broadcast(
                room_id,
                Some(client_id),
                None,
                &ServerToClientMessage::PeerLeft {
                    clientId: client_id.to_owned(),
                },
            )
            .await;
    }
}
