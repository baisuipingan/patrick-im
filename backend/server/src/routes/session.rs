use crate::protocol::{IceServer, SessionResponse};
use crate::session::get_or_create_session;
use crate::state::AppState;
use salvo::prelude::*;

const RELAY_FILE_LIMIT_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const DIRECT_FILE_SOFT_LIMIT_BYTES: u64 = u64::MAX;

#[handler]
pub async fn session_info(
    depot: &mut Depot,
    req: &mut Request,
    res: &mut Response,
) -> Result<Json<SessionResponse>, StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?;
    let current_session =
        get_or_create_session(req, res, &state.config.session_secret).map_err(|error| {
            StatusError::internal_server_error().brief(format!("session error: {error}"))
        })?;

    Ok(Json(SessionResponse {
        clientId: current_session.clientId,
        nickname: current_session.nickname,
        iceServers: build_ice_servers(state),
        relayFileLimitBytes: RELAY_FILE_LIMIT_BYTES,
        directFileSoftLimitBytes: DIRECT_FILE_SOFT_LIMIT_BYTES,
        recommendedTransferMode: "auto",
    }))
}

fn build_ice_servers(state: &AppState) -> Vec<IceServer> {
    let mut servers = Vec::new();
    if !state.config.stun_urls.is_empty() {
        servers.push(IceServer {
            urls: state.config.stun_urls.clone(),
            username: None,
            credential: None,
        });
    }

    if !state.config.turn_urls.is_empty() {
        servers.push(IceServer {
            urls: state.config.turn_urls.clone(),
            username: state.config.turn_username.clone(),
            credential: state.config.turn_credential.clone(),
        });
    }

    servers
}
