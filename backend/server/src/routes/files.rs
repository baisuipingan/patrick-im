use crate::protocol::{
    RelayAbortUploadRequest, RelayCompleteUploadRequest, RelayDiscardUploadRequest,
    RelayUploadRequest, RelayUploadResponse,
};
use crate::session::require_session;
use crate::state::AppState;
use crate::store::message_store::FileLookupError;
use crate::utils::{encode_content_disposition_name, sanitize_room_id};
use salvo::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, ETAG};
use salvo::prelude::*;
use tokio_util::io::ReaderStream;

const RELAY_FILE_LIMIT_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const RELAY_PART_MAX_BYTES: usize = 16 * 1024 * 1024;

#[handler]
pub async fn upload_request(
    req: &mut Request,
    depot: &mut Depot,
) -> Result<Json<RelayUploadResponse>, StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?;
    let session = require_session(req, &state.config.session_secret)
        .map_err(|error| {
            StatusError::internal_server_error().brief(format!("session decode error: {error}"))
        })?
        .ok_or_else(|| StatusError::unauthorized().brief("missing session"))?;

    let payload = req
        .parse_body::<RelayUploadRequest>()
        .await
        .map_err(|_| StatusError::bad_request().brief("invalid upload request"))?;

    if payload.fileName.trim().is_empty() || payload.roomId.trim().is_empty() || payload.size == 0 {
        return Err(StatusError::bad_request().brief("file metadata is incomplete"));
    }
    if payload.size > RELAY_FILE_LIMIT_BYTES {
        return Err(StatusError::payload_too_large().brief(format!(
            "file too large for relay mode ({RELAY_FILE_LIMIT_BYTES} bytes max)"
        )));
    }

    let response = state
        .relay_store
        .create_upload(&session, payload)
        .await
        .map_err(|error| StatusError::internal_server_error().brief(error.to_string()))?;
    Ok(Json(response))
}

#[handler]
pub async fn upload_part(
    req: &mut Request,
    depot: &mut Depot,
) -> Result<Json<crate::protocol::RelayUploadPartResponse>, StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?;
    let session = require_session(req, &state.config.session_secret)
        .map_err(|error| {
            StatusError::internal_server_error().brief(format!("session decode error: {error}"))
        })?
        .ok_or_else(|| StatusError::unauthorized().brief("missing session"))?;

    let upload_token = req
        .headers()
        .get("x-patrick-upload-token")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
        .ok_or_else(|| StatusError::bad_request().brief("missing upload token"))?;
    let part_number = req
        .headers()
        .get("x-patrick-part-number")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|part| *part > 0)
        .ok_or_else(|| StatusError::bad_request().brief("invalid part number"))?;
    let body = req
        .payload_with_max_size(RELAY_PART_MAX_BYTES)
        .await
        .map_err(|_| StatusError::bad_request().brief("missing upload body"))?;

    let response = state
        .relay_store
        .upload_part(&session, &upload_token, part_number, body.to_owned())
        .await
        .map_err(|error| StatusError::internal_server_error().brief(error.to_string()))?;
    Ok(Json(response))
}

#[handler]
pub async fn complete_upload(
    req: &mut Request,
    depot: &mut Depot,
) -> Result<Json<crate::protocol::RelayCompleteUploadResponse>, StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?;
    let session = require_session(req, &state.config.session_secret)
        .map_err(|error| {
            StatusError::internal_server_error().brief(format!("session decode error: {error}"))
        })?
        .ok_or_else(|| StatusError::unauthorized().brief("missing session"))?;
    let payload = req
        .parse_body::<RelayCompleteUploadRequest>()
        .await
        .map_err(|_| StatusError::bad_request().brief("invalid complete payload"))?;

    let response = state
        .relay_store
        .complete_upload(&session, payload)
        .await
        .map_err(|error| StatusError::internal_server_error().brief(error.to_string()))?;
    Ok(Json(response))
}

#[handler]
pub async fn abort_upload(
    req: &mut Request,
    depot: &mut Depot,
) -> Result<Json<serde_json::Value>, StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?;
    let session = require_session(req, &state.config.session_secret)
        .map_err(|error| {
            StatusError::internal_server_error().brief(format!("session decode error: {error}"))
        })?
        .ok_or_else(|| StatusError::unauthorized().brief("missing session"))?;
    let payload = req
        .parse_body::<RelayAbortUploadRequest>()
        .await
        .map_err(|_| StatusError::bad_request().brief("invalid abort payload"))?;

    let aborted = state
        .relay_store
        .abort_upload(&session, payload)
        .await
        .map_err(|error| StatusError::internal_server_error().brief(error.to_string()))?;
    Ok(Json(serde_json::json!({ "aborted": aborted })))
}

#[handler]
pub async fn discard_upload(
    req: &mut Request,
    depot: &mut Depot,
) -> Result<Json<serde_json::Value>, StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?;
    let session = require_session(req, &state.config.session_secret)
        .map_err(|error| {
            StatusError::internal_server_error().brief(format!("session decode error: {error}"))
        })?
        .ok_or_else(|| StatusError::unauthorized().brief("missing session"))?;
    let payload = req
        .parse_body::<RelayDiscardUploadRequest>()
        .await
        .map_err(|_| StatusError::bad_request().brief("invalid discard payload"))?;

    state
        .relay_store
        .discard_upload(&session, payload)
        .await
        .map_err(|error| StatusError::internal_server_error().brief(error.to_string()))?;
    Ok(Json(serde_json::json!({ "discarded": true })))
}

#[handler]
pub async fn file_access(
    req: &mut Request,
    depot: &mut Depot,
    res: &mut Response,
) -> Result<(), StatusError> {
    let state = depot
        .obtain::<AppState>()
        .map_err(|_| StatusError::internal_server_error())?;
    let room_id = sanitize_room_id(&req.param::<String>("room_id").unwrap_or_default());
    let file_id = req.param::<String>("file_id").unwrap_or_default();
    let session = require_session(req, &state.config.session_secret)
        .map_err(|error| {
            StatusError::internal_server_error().brief(format!("session decode error: {error}"))
        })?
        .ok_or_else(|| StatusError::unauthorized().brief("missing session"))?;

    let descriptor = match state
        .message_store
        .lookup_file_for_client(&room_id, &file_id, &session.clientId)
        .await
    {
        Ok(descriptor) => descriptor,
        Err(FileLookupError::NotFound) => {
            return Err(StatusError::not_found().brief("file not found"));
        }
        Err(FileLookupError::Forbidden) => {
            return Err(StatusError::forbidden().brief("file not accessible"));
        }
    };

    let object = state
        .relay_store
        .get_object(&descriptor.objectKey)
        .await
        .map_err(|error| StatusError::not_found().brief(error.to_string()))?;

    if let Some(content_type) = object.content_type() {
        res.headers_mut().insert(
            CONTENT_TYPE,
            salvo::http::HeaderValue::from_str(content_type)
                .map_err(|_| StatusError::internal_server_error())?,
        );
    }
    if let Some(length) = object.content_length() {
        res.headers_mut().insert(
            CONTENT_LENGTH,
            salvo::http::HeaderValue::from_str(&length.to_string())
                .map_err(|_| StatusError::internal_server_error())?,
        );
    }
    if let Some(etag) = object.e_tag() {
        res.headers_mut().insert(
            ETAG,
            salvo::http::HeaderValue::from_str(etag)
                .map_err(|_| StatusError::internal_server_error())?,
        );
    }

    res.headers_mut().insert(
        CACHE_CONTROL,
        salvo::http::HeaderValue::from_static("private, no-store"),
    );
    let disposition = if descriptor.previewable {
        format!(
            "inline; filename*=UTF-8''{}",
            encode_content_disposition_name(&descriptor.fileName)
        )
    } else {
        format!(
            "attachment; filename*=UTF-8''{}",
            encode_content_disposition_name(&descriptor.fileName)
        )
    };
    res.headers_mut().insert(
        CONTENT_DISPOSITION,
        salvo::http::HeaderValue::from_str(&disposition)
            .map_err(|_| StatusError::internal_server_error())?,
    );

    let stream = ReaderStream::new(object.body.into_async_read());
    res.stream(stream);
    Ok(())
}
