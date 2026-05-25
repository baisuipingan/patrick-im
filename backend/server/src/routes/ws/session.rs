use super::commands::handle_client_message;
use crate::protocol::{ClientToServerMessage, ServerToClientMessage};
use crate::state::{AppState, CLIENT_QUEUE_CAPACITY, ClientTx};
use axum::extract::ws::{Message, Utf8Bytes, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, watch};

pub(super) async fn handle_socket(
    state: AppState,
    room_id: String,
    client_id: String,
    nickname: String,
    ws: WebSocket,
) {
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(CLIENT_QUEUE_CAPACITY);
    let (control_tx, mut control_rx) = mpsc::channel::<Message>(16);
    let (shutdown_tx, _) = watch::channel(false);
    let tx = ClientTx::new(outbound_tx, shutdown_tx);

    let writer_tx = tx.clone();
    tokio::spawn(async move {
        let mut shutdown_rx = writer_tx.subscribe_shutdown();
        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    match changed {
                        Ok(()) if *shutdown_rx.borrow() => break,
                        Ok(()) => continue,
                        Err(_) => break,
                    }
                }
                outbound = outbound_rx.recv() => {
                    let Some(outbound) = outbound else {
                        break;
                    };
                    if ws_tx.send(Message::Text(Utf8Bytes::from(outbound))).await.is_err() {
                        break;
                    }
                }
                control = control_rx.recv() => {
                    let Some(control) = control else {
                        break;
                    };
                    if ws_tx.send(control).await.is_err() {
                        break;
                    }
                }
            }
        }
        writer_tx.close();
    });

    let joined = state
        .room_hub
        .join_room(&room_id, &client_id, &nickname, tx.clone())
        .await;
    if let Some(replaced_tx) = joined.replaced_tx.as_ref() {
        replaced_tx.close();
    }
    let connection_id = joined.connection_id.clone();
    send_room_snapshot(&state, &room_id, &client_id, &tx, joined.peers).await;
    state
        .room_hub
        .broadcast(
            &room_id,
            Some(&client_id),
            None,
            &ServerToClientMessage::PeerJoined {
                peer: joined.joined_peer,
            },
        )
        .await;

    let mut shutdown_rx = tx.subscribe_shutdown();
    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                match changed {
                    Ok(()) if *shutdown_rx.borrow() => break,
                    Ok(()) => continue,
                    Err(_) => break,
                }
            }
            maybe_message = ws_rx.next() => {
                let Some(Ok(message)) = maybe_message else {
                    break;
                };
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Ping(bytes) => {
                        let _ = control_tx.try_send(Message::Pong(bytes));
                        continue;
                    }
                    Message::Close(_) => break,
                    _ => continue,
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

                handle_client_message(
                    &state,
                    &room_id,
                    &client_id,
                    &connection_id,
                    &tx,
                    payload,
                )
                .await;
            }
        }
    }

    tx.close();
    remove_peer(&state, &room_id, &client_id, &connection_id).await;
}

async fn send_room_snapshot(
    state: &AppState,
    room_id: &str,
    client_id: &str,
    tx: &ClientTx,
    peers: Vec<crate::protocol::RoomPeer>,
) {
    let messages = match state
        .message_store
        .list_visible_messages(room_id, client_id)
        .await
    {
        Ok(messages) => messages,
        Err(error) => {
            tracing::error!(room_id, client_id, error = %error, "failed to load visible messages");
            Vec::new()
        }
    };
    let snapshot = ServerToClientMessage::RoomSnapshot {
        roomId: room_id.to_owned(),
        peers,
        messages,
        serverTime: crate::utils::now_ms(),
    };
    let _ = state.room_hub.send_json(tx, &snapshot);
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
