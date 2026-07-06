mod files;
mod health;
mod session;
mod threads;
mod web;
mod ws;

use crate::state::AppState;
use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/healthz", get(health::healthz))
        .route("/api/session", get(session::session_info))
        .route(
            "/api/files/relay-upload",
            post(files::relay_upload).layer(DefaultBodyLimit::max(
                (crate::routes::files::RELAY_FILE_LIMIT_BYTES as usize)
                    + crate::services::relay_store::RELAY_CHUNK_SIZE_BYTES,
            )),
        )
        .route("/api/files/upload-request", post(files::upload_request))
        .route(
            "/api/files/upload-part/{part_number}",
            post(files::upload_part).layer(DefaultBodyLimit::max(
                crate::services::relay_store::RELAY_CHUNK_SIZE_BYTES,
            )),
        )
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
    use crate::services::relay_store::RELAY_CHUNK_SIZE_BYTES;
    use axum::body::{Body, Bytes};
    use axum::extract::{DefaultBodyLimit, Path};
    use axum::http::{Request, StatusCode};
    use axum::routing::{get, post};
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

    #[tokio::test]
    async fn relay_part_route_accepts_full_chunk_body() {
        let default_response = relay_part_test_router(false)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/files/upload-part/1")
                    .body(Body::from(vec![7_u8; RELAY_CHUNK_SIZE_BYTES]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(default_response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let response = relay_part_test_router(true)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/files/upload-part/1")
                    .body(Body::from(vec![7_u8; RELAY_CHUNK_SIZE_BYTES]))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    fn relay_part_test_router(with_relay_limit: bool) -> Router {
        let method = post(|Path(part_number): Path<i32>, body: Bytes| async move {
            assert_eq!(part_number, 1);
            assert_eq!(body.len(), RELAY_CHUNK_SIZE_BYTES);
            StatusCode::OK
        });

        if with_relay_limit {
            Router::new().route(
                "/api/files/upload-part/{part_number}",
                method.layer(DefaultBodyLimit::max(RELAY_CHUNK_SIZE_BYTES)),
            )
        } else {
            Router::new().route(
                "/api/files/upload-part/{part_number}",
                post(|_part_number: Path<i32>, _body: Bytes| async move { StatusCode::OK }),
            )
        }
    }
}
