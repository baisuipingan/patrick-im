use super::session::handle_socket;
use crate::session::require_session;
use crate::state::AppState;
use crate::utils::sanitize_room_id;
use salvo::prelude::*;
use salvo::websocket::WebSocketUpgrade;

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
