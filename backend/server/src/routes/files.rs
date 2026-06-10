use crate::http::{ApiError, ApiResult, JsonResponse, ok_json};
use crate::protocol::{
    RelayAbortUploadRequest, RelayCompleteUploadRequest, RelayCompleteUploadResponse,
    RelayDiscardUploadRequest, RelayUploadPartAckRequest, RelayUploadRequest, RelayUploadResponse,
};
use crate::services::relay_store::{RelayUploadTokenPayload, ResumeRelayUploadInput};
use crate::session::require_session;
use crate::state::AppState;
use crate::store::message_store::{
    FileLookupError, PendingRelayUpload, RelayUploadRequestRecord, StorePendingRelayUploadOutcome,
    StoreRelayUploadRequestOutcome,
};
use crate::utils::{encode_content_disposition_name, sanitize_file_name, sanitize_room_id};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::LOCATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use uuid::Uuid;

const RELAY_FILE_LIMIT_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
struct NormalizedRelayUploadRequest {
    client_request_id: String,
    room_id: String,
    file_name: String,
    content_type: String,
    size: u64,
    target_id: Option<String>,
}

pub async fn upload_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RelayUploadRequest>,
) -> JsonResponse<RelayUploadResponse> {
    let session = require_session(&headers, &state.config.session_secret)
        .map_err(|error| ApiError::internal(format!("session decode error: {error}")))?
        .ok_or_else(|| ApiError::unauthorized("missing session"))?;

    if payload.fileName.trim().is_empty() || payload.roomId.trim().is_empty() || payload.size == 0 {
        return Err(ApiError::bad_request("file metadata is incomplete"));
    }
    if payload.size > RELAY_FILE_LIMIT_BYTES {
        return Err(ApiError::payload_too_large(format!(
            "file too large for relay mode ({RELAY_FILE_LIMIT_BYTES} bytes max)"
        )));
    }
    let normalized = normalize_upload_request(&payload);

    if let Some(existing) = state
        .message_store
        .find_relay_upload_request(&session.clientId, &normalized.client_request_id)
        .await
        .map_err(ApiError::from_internal)?
    {
        validate_relay_upload_request_record(&existing, &session.clientId, &normalized)
            .map_err(ApiError::from_conflict)?;
        let uploaded_parts = state
            .message_store
            .list_relay_upload_parts(&existing.file_id)
            .await
            .map_err(ApiError::from_internal)?;
        let response = state
            .relay_store
            .resume_upload(
                ResumeRelayUploadInput {
                    file_id: existing.file_id.clone(),
                    object_key: existing.object_key.clone(),
                    upload_id: existing.upload_id.clone(),
                    room_id: existing.room_id.clone(),
                    file_name: existing.file_name.clone(),
                    content_type: existing.content_type.clone(),
                    size: existing.size,
                    target_id: existing.target_id.clone(),
                    from_id: existing.from_id.clone(),
                },
                uploaded_parts,
            )
            .await
            .map_err(ApiError::from_internal)?;
        return Ok(ok_json(response));
    }

    let created = state
        .relay_store
        .create_upload(&session, payload)
        .await
        .map_err(ApiError::from_internal)?;
    let record = RelayUploadRequestRecord {
        from_id: session.clientId.clone(),
        request_id: normalized.client_request_id.clone(),
        file_id: created.token_payload.fileId.clone(),
        room_id: created.token_payload.roomId.clone(),
        target_id: created.token_payload.targetId.clone(),
        file_name: created.token_payload.fileName.clone(),
        size: created.token_payload.size,
        content_type: created.token_payload.contentType.clone(),
        object_key: created.token_payload.objectKey.clone(),
        upload_id: created.token_payload.uploadId.clone(),
        created_at: created.token_payload.issuedAt,
    };

    match state
        .message_store
        .store_relay_upload_request(&record)
        .await
        .map_err(ApiError::from_internal)?
    {
        StoreRelayUploadRequestOutcome::Inserted => Ok(ok_json(created.response)),
        StoreRelayUploadRequestOutcome::Existing(existing) => {
            if let Err(error) = state
                .relay_store
                .abort_upload_by_key(&record.object_key, &record.upload_id)
                .await
            {
                tracing::warn!(
                    object_key = %record.object_key,
                    error = %error,
                    "failed to abort duplicate relay upload after idempotent request conflict"
                );
            }

            validate_relay_upload_request_record(&existing, &session.clientId, &normalized)
                .map_err(ApiError::from_conflict)?;
            let uploaded_parts = state
                .message_store
                .list_relay_upload_parts(&existing.file_id)
                .await
                .map_err(ApiError::from_internal)?;
            let response = state
                .relay_store
                .resume_upload(
                    ResumeRelayUploadInput {
                        file_id: existing.file_id.clone(),
                        object_key: existing.object_key.clone(),
                        upload_id: existing.upload_id.clone(),
                        room_id: existing.room_id.clone(),
                        file_name: existing.file_name.clone(),
                        content_type: existing.content_type.clone(),
                        size: existing.size,
                        target_id: existing.target_id.clone(),
                        from_id: existing.from_id.clone(),
                    },
                    uploaded_parts,
                )
                .await
                .map_err(ApiError::from_internal)?;
            Ok(ok_json(response))
        }
    }
}

pub async fn ack_upload_part(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RelayUploadPartAckRequest>,
) -> JsonResponse<serde_json::Value> {
    let session = require_session(&headers, &state.config.session_secret)
        .map_err(|error| ApiError::internal(format!("session decode error: {error}")))?
        .ok_or_else(|| ApiError::unauthorized("missing session"))?;
    if payload.part.partNumber <= 0 || payload.part.etag.trim().is_empty() {
        return Err(ApiError::bad_request("invalid upload part ack"));
    }

    let upload = state
        .relay_store
        .verify_upload_token(&session, &payload.uploadToken)
        .map_err(ApiError::from_internal)?;
    state
        .message_store
        .store_relay_upload_part(&upload.file_id, &payload.part)
        .await
        .map_err(ApiError::from_internal)?;

    Ok(ok_json(serde_json::json!({ "ok": true })))
}

pub async fn complete_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RelayCompleteUploadRequest>,
) -> JsonResponse<RelayCompleteUploadResponse> {
    let session = require_session(&headers, &state.config.session_secret)
        .map_err(|error| ApiError::internal(format!("session decode error: {error}")))?
        .ok_or_else(|| ApiError::unauthorized("missing session"))?;
    let upload_token = state
        .relay_store
        .describe_upload_token(&session, &payload.uploadToken)
        .map_err(ApiError::from_internal)?;

    if let Some(existing) = state
        .message_store
        .find_pending_relay_upload(&upload_token.fileId)
        .await
        .map_err(ApiError::from_internal)?
    {
        validate_pending_upload_matches_token(&existing, &upload_token)
            .map_err(ApiError::from_conflict)?;
        return Ok(ok_json(build_complete_upload_response(
            &existing.file_id,
            &existing.object_key,
        )));
    }

    let completed = match state.relay_store.complete_upload(&session, payload).await {
        Ok(completed) => completed,
        Err(error) => {
            if let Some(existing) = state
                .message_store
                .find_pending_relay_upload(&upload_token.fileId)
                .await
                .map_err(ApiError::from_internal)?
            {
                validate_pending_upload_matches_token(&existing, &upload_token)
                    .map_err(ApiError::from_conflict)?;
                return Ok(ok_json(build_complete_upload_response(
                    &existing.file_id,
                    &existing.object_key,
                )));
            }
            return Err(ApiError::from_internal(error));
        }
    };

    match state
        .message_store
        .store_completed_relay_upload(PendingRelayUpload {
            file_id: completed.file_id.clone(),
            room_id: completed.room_id.clone(),
            from_id: completed.from_id.clone(),
            target_id: completed.target_id.clone(),
            file_name: completed.file_name.clone(),
            size: completed.size,
            content_type: completed.content_type.clone(),
            object_key: completed.object_key.clone(),
            created_at: completed.created_at,
        })
        .await
    {
        Ok(StorePendingRelayUploadOutcome::Inserted) => {}
        Ok(StorePendingRelayUploadOutcome::Existing(existing)) => {
            validate_pending_upload_matches_completed(&existing, &completed)
                .map_err(ApiError::from_conflict)?;
            return Ok(ok_json(build_complete_upload_response(
                &existing.file_id,
                &existing.object_key,
            )));
        }
        Err(error) => {
            tracing::error!(
                room_id = %completed.room_id,
                file_id = %completed.file_id,
                error = %error,
                "failed to persist completed relay upload metadata"
            );
            if let Err(cleanup_error) = state
                .relay_store
                .delete_object_by_key(&completed.object_key)
                .await
            {
                tracing::error!(
                    object_key = %completed.object_key,
                    error = %cleanup_error,
                    "failed to cleanup relay object after metadata persist failure"
                );
            }
            let _ = state
                .message_store
                .remove_relay_upload_request_by_file_id(&completed.file_id)
                .await;
            return Err(ApiError::internal(
                "failed to persist relay upload metadata",
            ));
        }
    }

    Ok(ok_json(build_complete_upload_response(
        &completed.file_id,
        &completed.object_key,
    )))
}

pub async fn abort_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RelayAbortUploadRequest>,
) -> JsonResponse<serde_json::Value> {
    let session = require_session(&headers, &state.config.session_secret)
        .map_err(|error| ApiError::internal(format!("session decode error: {error}")))?
        .ok_or_else(|| ApiError::unauthorized("missing session"))?;
    let upload = state
        .relay_store
        .verify_upload_token(&session, &payload.uploadToken)
        .map_err(ApiError::from_internal)?;

    let aborted = state
        .relay_store
        .abort_upload(&session, payload)
        .await
        .map_err(ApiError::from_internal)?;
    if aborted {
        let _ = state
            .message_store
            .remove_relay_upload_request_by_file_id(&upload.file_id)
            .await;
    }
    Ok(ok_json(serde_json::json!({ "aborted": aborted })))
}

pub async fn discard_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RelayDiscardUploadRequest>,
) -> JsonResponse<serde_json::Value> {
    let session = require_session(&headers, &state.config.session_secret)
        .map_err(|error| ApiError::internal(format!("session decode error: {error}")))?
        .ok_or_else(|| ApiError::unauthorized("missing session"))?;

    let upload = state
        .relay_store
        .verify_upload_token(&session, &payload.uploadToken)
        .map_err(ApiError::from_internal)?;
    state
        .message_store
        .remove_pending_relay_upload(&upload.file_id)
        .await
        .map_err(ApiError::from_internal)?;
    state
        .message_store
        .remove_relay_upload_request_by_file_id(&upload.file_id)
        .await
        .map_err(ApiError::from_internal)?;
    state
        .relay_store
        .delete_object_by_key(&upload.object_key)
        .await
        .map_err(ApiError::from_internal)?;
    Ok(ok_json(serde_json::json!({ "discarded": true })))
}

pub async fn file_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((room_id, file_id)): Path<(String, String)>,
) -> ApiResult<Response> {
    let room_id = sanitize_room_id(&room_id);
    let session = require_session(&headers, &state.config.session_secret)
        .map_err(|error| ApiError::internal(format!("session decode error: {error}")))?
        .ok_or_else(|| ApiError::unauthorized("missing session"))?;

    let descriptor = match state
        .message_store
        .lookup_file_for_client(&room_id, &file_id, &session.clientId)
        .await
    {
        Ok(descriptor) => descriptor,
        Err(FileLookupError::NotFound) => {
            return Err(ApiError::not_found("file not found"));
        }
        Err(FileLookupError::Forbidden) => {
            return Err(ApiError::forbidden("file not accessible"));
        }
    };

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
    let url = state
        .relay_store
        .create_presigned_download_url(
            &descriptor.objectKey,
            disposition,
            descriptor.contentType.clone(),
        )
        .await
        .map_err(ApiError::from_internal)?;

    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(LOCATION, url)
        .body(axum::body::Body::empty())
        .map_err(ApiError::from_internal)
}

fn normalize_upload_request(request: &RelayUploadRequest) -> NormalizedRelayUploadRequest {
    let client_request_id = request
        .clientRequestId
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    NormalizedRelayUploadRequest {
        client_request_id,
        room_id: sanitize_room_id(&request.roomId),
        file_name: sanitize_file_name(&request.fileName),
        content_type: normalize_content_type(&request.contentType),
        size: request.size,
        target_id: request.targetId.clone(),
    }
}

fn normalize_content_type(content_type: &str) -> String {
    if content_type.trim().is_empty() {
        "application/octet-stream".to_owned()
    } else {
        content_type.to_owned()
    }
}

fn validate_relay_upload_request_record(
    record: &RelayUploadRequestRecord,
    client_id: &str,
    request: &NormalizedRelayUploadRequest,
) -> anyhow::Result<()> {
    if record.from_id != client_id
        || record.room_id != request.room_id
        || record.file_name != request.file_name
        || record.content_type != request.content_type
        || record.size != request.size
        || record.target_id != request.target_id
    {
        anyhow::bail!("relay upload request id conflicts with different file metadata");
    }

    Ok(())
}

fn validate_pending_upload_matches_token(
    pending: &PendingRelayUpload,
    upload_token: &RelayUploadTokenPayload,
) -> anyhow::Result<()> {
    if pending.file_id != upload_token.fileId
        || pending.room_id != upload_token.roomId
        || pending.from_id != upload_token.fromId
        || pending.target_id != upload_token.targetId
        || pending.file_name != upload_token.fileName
        || pending.size != upload_token.size
        || pending.content_type != upload_token.contentType
        || pending.object_key != upload_token.objectKey
    {
        anyhow::bail!("completed relay upload conflicts with stored pending upload");
    }

    Ok(())
}

fn validate_pending_upload_matches_completed(
    pending: &PendingRelayUpload,
    completed: &crate::services::relay_store::CompletedRelayUpload,
) -> anyhow::Result<()> {
    if pending.file_id != completed.file_id
        || pending.room_id != completed.room_id
        || pending.from_id != completed.from_id
        || pending.target_id != completed.target_id
        || pending.file_name != completed.file_name
        || pending.size != completed.size
        || pending.content_type != completed.content_type
        || pending.object_key != completed.object_key
    {
        anyhow::bail!("completed relay upload conflicts with stored pending upload");
    }

    Ok(())
}

fn build_complete_upload_response(file_id: &str, object_key: &str) -> RelayCompleteUploadResponse {
    RelayCompleteUploadResponse {
        fileId: file_id.to_owned(),
        objectKey: object_key.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_upload_request_fills_defaults() {
        let normalized = normalize_upload_request(&RelayUploadRequest {
            clientRequestId: Some("  req-1 ".to_owned()),
            roomId: " Room 1 ".to_owned(),
            fileName: " a/b.png ".to_owned(),
            contentType: "".to_owned(),
            size: 12,
            targetId: Some("peer".to_owned()),
        });

        assert_eq!(normalized.client_request_id, "req-1");
        assert_eq!(normalized.room_id, "room-1");
        assert_eq!(normalized.file_name, "a-b.png");
        assert_eq!(normalized.content_type, "application/octet-stream");
        assert_eq!(normalized.size, 12);
        assert_eq!(normalized.target_id.as_deref(), Some("peer"));
    }

    #[test]
    fn validate_relay_upload_request_record_rejects_mismatch() {
        let record = RelayUploadRequestRecord {
            from_id: "alice".to_owned(),
            request_id: "req-1".to_owned(),
            file_id: "file-1".to_owned(),
            room_id: "room-1".to_owned(),
            target_id: Some("bob".to_owned()),
            file_name: "demo.png".to_owned(),
            size: 42,
            content_type: "image/png".to_owned(),
            object_key: "rooms/room-1/file-1/demo.png".to_owned(),
            upload_id: "upload-1".to_owned(),
            created_at: 1,
        };
        let normalized = NormalizedRelayUploadRequest {
            client_request_id: "req-1".to_owned(),
            room_id: "room-1".to_owned(),
            file_name: "other.png".to_owned(),
            content_type: "image/png".to_owned(),
            size: 42,
            target_id: Some("bob".to_owned()),
        };

        let error =
            validate_relay_upload_request_record(&record, "alice", &normalized).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("relay upload request id conflicts with different file metadata")
        );
    }

    #[test]
    fn validate_pending_upload_matches_token_rejects_mismatch() {
        let pending = PendingRelayUpload {
            file_id: "file-1".to_owned(),
            room_id: "room-1".to_owned(),
            from_id: "alice".to_owned(),
            target_id: Some("bob".to_owned()),
            file_name: "demo.png".to_owned(),
            size: 42,
            content_type: "image/png".to_owned(),
            object_key: "rooms/room-1/file-1/demo.png".to_owned(),
            created_at: 1,
        };
        let token = RelayUploadTokenPayload {
            fileId: "file-1".to_owned(),
            objectKey: "rooms/room-1/file-1/demo.png".to_owned(),
            uploadId: "upload-1".to_owned(),
            roomId: "room-1".to_owned(),
            fileName: "other.png".to_owned(),
            contentType: "image/png".to_owned(),
            size: 42,
            targetId: Some("bob".to_owned()),
            fromId: "alice".to_owned(),
            issuedAt: 1,
        };

        let error = validate_pending_upload_matches_token(&pending, &token).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("completed relay upload conflicts with stored pending upload")
        );
    }
}
