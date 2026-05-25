use super::session::handle_socket;
use crate::http::{ApiError, ApiResult};
use crate::session::require_session;
use crate::state::AppState;
use crate::utils::sanitize_room_id;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;

pub async fn room_ws(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    let room_id = sanitize_room_id(&room_id);
    if room_id.trim().is_empty() {
        return Err(ApiError::bad_request("missing room_id"));
    }

    let session = require_session(&headers, &state.config.session_secret)
        .map_err(|error| ApiError::internal(format!("session decode error: {error}")))?
        .ok_or_else(|| ApiError::unauthorized("missing session"))?;

    let client_id = session.clientId.clone();
    let nickname = session.nickname.clone();
    Ok(ws
        .on_upgrade(move |socket| async move {
            handle_socket(state, room_id, client_id, nickname, socket).await;
        })
        .into())
}
