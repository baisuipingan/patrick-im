use crate::http::{ApiError, JsonResponse, ok_json};
use crate::protocol::{ClearThreadRequest, ServerToClientMessage};
use crate::session::require_session;
use crate::state::AppState;
use crate::utils::sanitize_room_id;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;

pub async fn clear_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(body): Json<ClearThreadRequest>,
) -> JsonResponse<crate::protocol::ClearThreadResponse> {
    let room_id = sanitize_room_id(&room_id);
    let session = require_session(&headers, &state.config.session_secret)
        .map_err(|error| ApiError::internal(format!("session decode error: {error}")))?
        .ok_or_else(|| ApiError::unauthorized("missing session"))?;

    if !state
        .room_hub
        .is_client_connected(&room_id, &session.clientId)
        .await
    {
        return Err(ApiError::forbidden("client is not connected to this room"));
    }

    let actor_name = state
        .room_hub
        .display_name_for(&room_id, &session.clientId)
        .await
        .unwrap_or(session.nickname.clone());

    let outcome = state
        .message_store
        .clear_thread(&room_id, &session.clientId, &actor_name, body.targetId)
        .await
        .map_err(ApiError::from_internal)?;

    let _ = state
        .relay_store
        .delete_orphaned_files(&outcome.orphaned_files)
        .await;

    if let Some(event) = outcome.event {
        let recipients = event
            .targetId
            .as_ref()
            .map(|target| vec![session.clientId.clone(), target.clone()]);
        state
            .room_hub
            .broadcast(
                &room_id,
                None,
                recipients.as_deref(),
                &ServerToClientMessage::ThreadCleared {
                    targetId: event.targetId,
                    actorId: event.actorId,
                    actorName: event.actorName,
                    removedMessages: event.removedMessages,
                    removedRelayFiles: event.removedRelayFiles,
                },
            )
            .await;
    }

    Ok(ok_json(outcome.response))
}
