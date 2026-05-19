mod files;
mod health;
mod session;
mod threads;
mod web;
mod ws;

use salvo::prelude::*;

pub fn router() -> Router {
    Router::new()
        .push(Router::with_path("api/healthz").get(health::healthz))
        .push(Router::with_path("api/session").get(session::session_info))
        .push(
            Router::with_path("api")
                .push(
                    Router::with_path("files")
                        .push(Router::with_path("upload-request").post(files::upload_request))
                        .push(Router::with_path("complete").post(files::complete_upload))
                        .push(Router::with_path("abort").post(files::abort_upload))
                        .push(Router::with_path("discard").post(files::discard_upload))
                        .push(
                            Router::with_path("{room_id}/{file_id}/access").get(files::file_access),
                        ),
                )
                .push(Router::with_path("rooms/{room_id}/ws").get(ws::room_ws))
                .push(
                    Router::with_path("rooms/{room_id}/threads/clear").post(threads::clear_thread),
                ),
        )
        .push(Router::with_path("{**path}").get(web::asset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use salvo::http::StatusCode;
    use salvo::test::{ResponseExt, TestClient};

    #[tokio::test]
    async fn root_path_serves_embedded_index() {
        let service = Service::new(router());

        let mut response = TestClient::get("http://127.0.0.1:5800/")
            .send(&service)
            .await;

        assert_eq!(response.status_code, Some(StatusCode::OK));
        let body = response.take_string().await.unwrap();
        assert!(body.contains("<title>Patrick-IM</title>"));
        assert!(body.contains("<div id=\"root\"></div>"));
    }
}
