use crate::protocol::{ClientToServerMessage, ServerToClientMessage};
use crate::state::{AppState, ClientTx};
use crate::store::message_store::{PersistRelayFileMessageOutcome, normalize_target_id};

pub(super) async fn handle_client_message(
    state: &AppState,
    room_id: &str,
    client_id: &str,
    connection_id: &str,
    tx: &ClientTx,
    payload: ClientToServerMessage,
) {
    match payload {
        ClientToServerMessage::Ping => {
            let _ = state.room_hub.send_json(
                tx,
                &ServerToClientMessage::Pong {
                    serverTime: crate::utils::now_ms(),
                },
            );
        }
        ClientToServerMessage::SetProfile { nickname } => {
            rename_peer(state, room_id, client_id, connection_id, nickname).await;
        }
        ClientToServerMessage::ChatSend { text, targetId } => {
            handle_chat_send(state, room_id, client_id, connection_id, text, targetId).await;
        }
        ClientToServerMessage::Signal { targetId, payload } => {
            forward_signal(state, room_id, client_id, connection_id, &targetId, payload).await;
        }
        ClientToServerMessage::RelayFileAnnounced { file } => {
            handle_relay_file(state, room_id, client_id, connection_id, file, tx).await;
        }
    }
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
    tx: &ClientTx,
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
    let normalized_target = match normalize_target_id(client_id, file.targetId.clone()) {
        Some(target) if state.room_hub.is_client_connected(room_id, &target).await => Some(target),
        _ => None,
    };
    let recipients = normalized_target
        .clone()
        .map(|target| vec![client_id.to_owned(), target]);
    let outcome = match state
        .message_store
        .persist_confirmed_relay_file_message(
            room_id,
            client_id,
            &from_name,
            normalized_target,
            file,
        )
        .await
    {
        Ok(message) => message,
        Err(error) => {
            let _ = state.room_hub.send_json(
                tx,
                &ServerToClientMessage::Error {
                    code: "relay_file_announce_failed".to_owned(),
                    message: format!("relay 文件确认失败: {error}"),
                },
            );
            return;
        }
    };

    match outcome {
        PersistRelayFileMessageOutcome::Created(message) => {
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
        PersistRelayFileMessageOutcome::Existing(message) => {
            let _ = state
                .room_hub
                .send_json(tx, &ServerToClientMessage::ChatEvent { message });
        }
    }
}
