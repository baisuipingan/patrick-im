mod files;
mod health;
mod session;
mod threads;
mod web;
mod ws;

use crate::state::AppState;
use axum::Router;
use axum::routing::{get, post};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/healthz", get(health::healthz))
        .route("/api/session", get(session::session_info))
        .route("/api/files/upload-request", post(files::upload_request))
        .route("/api/files/upload-part", post(files::ack_upload_part))
        .route("/api/files/complete", post(files::complete_upload))
        .route("/api/files/abort", post(files::abort_upload))
        .route("/api/files/discard", post(files::discard_upload))
        .route(
            "/api/files/{room_id}/{file_id}/access",
            get(files::file_access),
        )
        .route("/api/rooms/{room_id}/ws", get(ws::room_ws))
        .route(
            "/api/rooms/{room_id}/threads/clear",
            post(threads::clear_thread),
        )
        .route("/", get(web::index))
        .route("/{*path}", get(web::asset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use tower::ServiceExt;

    #[tokio::test]
    async fn root_path_serves_embedded_index() {
        let response = Router::new()
            .route("/", get(web::index))
            .route("/{*path}", get(web::asset))
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.contains("<title>Patrick-IM</title>"));
        assert!(body.contains("<div id=\"root\"></div>"));
    }
}
