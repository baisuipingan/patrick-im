use crate::protocol::{ClearThreadRequest, ServerToClientMessage};
use crate::session::require_session;
use crate::state::AppState;
use crate::utils::sanitize_room_id;
use salvo::prelude::*;

#[handler]
pub async fn clear_thread(
    req: &mut Request,
    depot: &mut Depot,
) -> Result<Json<crate::protocol::ClearThreadResponse>, StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?;
    let room_id = sanitize_room_id(&req.param::<String>("room_id").unwrap_or_default());
    let session = require_session(req, &state.config.session_secret)
        .map_err(|error| {
            StatusError::internal_server_error().brief(format!("session decode error: {error}"))
        })?
        .ok_or_else(|| StatusError::unauthorized().brief("missing session"))?;

    if !state
        .room_hub
        .is_client_connected(&room_id, &session.clientId)
        .await
    {
        return Err(StatusError::forbidden().brief("client is not connected to this room"));
    }

    let body = req
        .parse_body::<ClearThreadRequest>()
        .await
        .map_err(|_| StatusError::bad_request().brief("invalid clear-thread payload"))?;

    let actor_name = state
        .room_hub
        .display_name_for(&room_id, &session.clientId)
        .await
        .unwrap_or(session.nickname.clone());

    let outcome = state
        .message_store
        .clear_thread(&room_id, &session.clientId, &actor_name, body.targetId)
        .await
        .map_err(|error| StatusError::internal_server_error().brief(error.to_string()))?;

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

    Ok(Json(outcome.response))
}
