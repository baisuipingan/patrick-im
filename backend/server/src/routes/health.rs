use salvo::prelude::*;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct HealthResponse<'a> {
    status: &'a str,
    service: &'a str,
}

#[handler]
pub async fn healthz() -> Json<HealthResponse<'static>> {
    Json(HealthResponse {
        status: "ok",
        service: "patrick-im-server",
    })
}
