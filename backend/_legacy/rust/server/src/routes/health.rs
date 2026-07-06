use crate::http::ok_json;
use axum::response::IntoResponse;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct HealthResponse<'a> {
    status: &'a str,
    service: &'a str,
}

pub async fn healthz() -> impl IntoResponse {
    ok_json(HealthResponse {
        status: "ok",
        service: "patrick-im-server",
    })
}
