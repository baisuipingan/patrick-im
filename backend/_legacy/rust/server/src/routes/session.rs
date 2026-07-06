use crate::http::{ApiError, ApiResult};
use crate::protocol::{IceServer, SessionResponse};
use crate::session::get_or_create_session;
use crate::state::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;

const RELAY_FILE_LIMIT_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const DIRECT_FILE_SOFT_LIMIT_BYTES: u64 = u64::MAX;

pub async fn session_info(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<impl IntoResponse> {
    let mut response_headers = HeaderMap::new();
    let secure = should_use_secure_cookie(&headers, state.config.secure_cookies);
    let current_session = get_or_create_session(
        &headers,
        &mut response_headers,
        secure,
        &state.config.session_secret,
    )
    .map_err(|error| ApiError::internal(format!("session error: {error}")))?;

    let response = SessionResponse {
        clientId: current_session.clientId,
        nickname: current_session.nickname,
        iceServers: build_ice_servers(&state),
        relayFileLimitBytes: RELAY_FILE_LIMIT_BYTES,
        directFileSoftLimitBytes: DIRECT_FILE_SOFT_LIMIT_BYTES,
        recommendedTransferMode: "auto",
    };

    Ok((response_headers, axum::Json(response)))
}

fn should_use_secure_cookie(headers: &HeaderMap, configured_secure: bool) -> bool {
    configured_secure || forwarded_proto_is_https(headers)
}

fn forwarded_proto_is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .any(|proto| proto.trim().eq_ignore_ascii_case("https"))
        })
        .unwrap_or(false)
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn secure_cookie_prefers_explicit_config() {
        let headers = HeaderMap::new();

        assert!(should_use_secure_cookie(&headers, true));
    }

    #[test]
    fn secure_cookie_accepts_forwarded_https_proto() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http, https"));

        assert!(should_use_secure_cookie(&headers, false));
    }

    #[test]
    fn secure_cookie_stays_disabled_for_plain_http() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));

        assert!(!should_use_secure_cookie(&headers, false));
    }
}
