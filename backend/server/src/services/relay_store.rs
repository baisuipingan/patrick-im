use crate::config::AppConfig;
use crate::protocol::{
    RelayAbortUploadRequest, RelayCompleteUploadRequest, RelayCompleteUploadResponse,
    RelayDiscardUploadRequest, RelayFileAnnouncement, RelayFileDescriptor, RelayUploadPartResponse,
    RelayUploadRequest, RelayUploadResponse,
};
use crate::session::SessionPayload;
use crate::signing::{create_signed_token, read_signed_token};
use crate::utils::{
    build_object_key, now_ms, previewable_from_content_type, sanitize_file_name, sanitize_room_id,
};
use anyhow::{Context, Result, anyhow};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Builder as S3ConfigBuilder, Credentials, Region};
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

const RELAY_CHUNK_SIZE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
struct RelayUploadTokenPayload {
    fileId: String,
    objectKey: String,
    uploadId: String,
    roomId: String,
    fileName: String,
    contentType: String,
    size: u64,
    targetId: Option<String>,
    fromId: String,
    issuedAt: u64,
}

#[derive(Debug, Clone)]
struct CompletedUploadRecord {
    file_id: String,
    room_id: String,
    file_name: String,
    size: u64,
    content_type: String,
    object_key: String,
    target_id: Option<String>,
    from_id: String,
}

#[derive(Debug, Clone)]
pub struct RelayStore {
    client: Client,
    bucket: String,
    signing_secret: String,
    completed_uploads: Arc<RwLock<HashMap<String, CompletedUploadRecord>>>,
}

impl RelayStore {
    pub fn new(config: &AppConfig) -> Self {
        let credentials = Credentials::new(
            config.rustfs_access_key.clone(),
            config.rustfs_secret_key.clone(),
            None,
            None,
            "patrick-im-rustfs",
        );
        let s3_config = S3ConfigBuilder::new()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .endpoint_url(config.rustfs_endpoint.clone())
            .force_path_style(true)
            .credentials_provider(credentials)
            .build();

        Self {
            client: Client::from_conf(s3_config),
            bucket: config.rustfs_bucket.clone(),
            signing_secret: config.session_secret.clone(),
            completed_uploads: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create_upload(
        &self,
        session: &SessionPayload,
        request: RelayUploadRequest,
    ) -> Result<RelayUploadResponse> {
        let room_id = sanitize_room_id(&request.roomId);
        let file_name = sanitize_file_name(&request.fileName);
        let content_type = if request.contentType.trim().is_empty() {
            "application/octet-stream".to_owned()
        } else {
            request.contentType
        };

        let file_id = Uuid::new_v4().to_string();
        let object_key = build_object_key(&room_id, &file_id, &file_name);
        let upload = self
            .client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(&object_key)
            .content_type(content_type.clone())
            .cache_control("private, no-store")
            .content_disposition(format!(
                "attachment; filename*=UTF-8''{}",
                crate::utils::encode_content_disposition_name(&file_name)
            ))
            .metadata("roomId", room_id.clone())
            .metadata("fromId", session.clientId.clone())
            .metadata("targetId", request.targetId.clone().unwrap_or_default())
            .metadata("fileName", file_name.clone())
            .send()
            .await
            .context("failed to create multipart upload")?;

        let upload_id = upload
            .upload_id()
            .ok_or_else(|| anyhow!("missing upload id from rustfs"))?
            .to_owned();

        let payload = RelayUploadTokenPayload {
            fileId: file_id.clone(),
            objectKey: object_key.clone(),
            uploadId: upload_id,
            roomId: room_id,
            fileName: file_name,
            contentType: content_type,
            size: request.size,
            targetId: request.targetId,
            fromId: session.clientId.clone(),
            issuedAt: now_ms(),
        };

        Ok(RelayUploadResponse {
            fileId: file_id,
            objectKey: object_key,
            uploadToken: create_signed_token(&self.signing_secret, &payload)?,
            chunkSizeBytes: RELAY_CHUNK_SIZE_BYTES as u64,
        })
    }

    pub async fn upload_part(
        &self,
        session: &SessionPayload,
        upload_token: &str,
        part_number: i32,
        bytes: Bytes,
    ) -> Result<RelayUploadPartResponse> {
        let payload = self.read_upload_token(upload_token)?;
        if payload.fromId != session.clientId {
            return Err(anyhow!("invalid upload token owner"));
        }

        let response = self
            .client
            .upload_part()
            .bucket(&self.bucket)
            .key(&payload.objectKey)
            .upload_id(payload.uploadId)
            .part_number(part_number)
            .body(bytes.into())
            .send()
            .await
            .context("failed to upload relay part")?;

        Ok(RelayUploadPartResponse {
            partNumber: part_number,
            etag: response.e_tag().unwrap_or_default().to_owned(),
        })
    }

    pub async fn complete_upload(
        &self,
        session: &SessionPayload,
        request: RelayCompleteUploadRequest,
    ) -> Result<RelayCompleteUploadResponse> {
        let payload = self.read_upload_token(&request.uploadToken)?;
        if payload.fromId != session.clientId {
            return Err(anyhow!("invalid upload token owner"));
        }
        if request.parts.is_empty() {
            return Err(anyhow!("missing uploaded parts"));
        }

        let completed_parts = request
            .parts
            .iter()
            .map(|part| {
                CompletedPart::builder()
                    .e_tag(part.etag.clone())
                    .part_number(part.partNumber)
                    .build()
            })
            .collect::<Vec<_>>();

        self.client
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(&payload.objectKey)
            .upload_id(payload.uploadId.clone())
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(completed_parts))
                    .build(),
            )
            .send()
            .await
            .context("failed to complete relay upload")?;

        self.completed_uploads.write().await.insert(
            payload.fileId.clone(),
            CompletedUploadRecord {
                file_id: payload.fileId.clone(),
                room_id: payload.roomId,
                file_name: payload.fileName,
                size: payload.size,
                content_type: payload.contentType,
                object_key: payload.objectKey.clone(),
                target_id: payload.targetId,
                from_id: payload.fromId,
            },
        );

        Ok(RelayCompleteUploadResponse {
            fileId: payload.fileId,
            objectKey: payload.objectKey,
        })
    }

    pub async fn abort_upload(
        &self,
        session: &SessionPayload,
        request: RelayAbortUploadRequest,
    ) -> Result<bool> {
        let payload = self.read_upload_token(&request.uploadToken)?;
        if payload.fromId != session.clientId {
            return Err(anyhow!("invalid upload token owner"));
        }

        let result = self
            .client
            .abort_multipart_upload()
            .bucket(&self.bucket)
            .key(&payload.objectKey)
            .upload_id(payload.uploadId)
            .send()
            .await;
        self.completed_uploads.write().await.remove(&payload.fileId);
        Ok(result.is_ok())
    }

    pub async fn discard_upload(
        &self,
        session: &SessionPayload,
        request: RelayDiscardUploadRequest,
    ) -> Result<()> {
        let payload = self.read_upload_token(&request.uploadToken)?;
        if payload.fromId != session.clientId {
            return Err(anyhow!("invalid upload token owner"));
        }

        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(&payload.objectKey)
            .send()
            .await
            .context("failed to discard completed relay object")?;
        self.completed_uploads.write().await.remove(&payload.fileId);
        Ok(())
    }

    pub async fn confirm_announced_file(
        &self,
        room_id: &str,
        client_id: &str,
        file: RelayFileAnnouncement,
    ) -> Result<RelayFileAnnouncement> {
        let mut uploads = self.completed_uploads.write().await;
        let Some(record) = uploads.remove(&file.fileId) else {
            return Err(anyhow!("relay file upload is not ready to announce"));
        };

        if record.from_id != client_id
            || record.room_id != room_id
            || record.object_key != file.objectKey
            || record.file_name != file.fileName
            || record.size != file.size
            || record.content_type != file.contentType
            || record.target_id != file.targetId
        {
            return Err(anyhow!(
                "relay file announcement does not match completed upload"
            ));
        }

        Ok(RelayFileAnnouncement {
            fileId: record.file_id,
            fileName: record.file_name,
            size: record.size,
            contentType: record.content_type.clone(),
            objectKey: record.object_key,
            targetId: record.target_id,
            previewable: previewable_from_content_type(&file.contentType),
        })
    }

    pub async fn delete_object(&self, descriptor: &RelayFileDescriptor) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(&descriptor.objectKey)
            .send()
            .await
            .with_context(|| format!("failed to delete relay object {}", descriptor.objectKey))?;
        self.completed_uploads
            .write()
            .await
            .remove(&descriptor.fileId);
        Ok(())
    }

    pub async fn delete_orphaned_files(&self, files: &[RelayFileDescriptor]) -> Result<()> {
        for descriptor in files {
            self.delete_object(descriptor).await?;
        }
        Ok(())
    }

    pub async fn get_object(
        &self,
        object_key: &str,
    ) -> Result<aws_sdk_s3::operation::get_object::GetObjectOutput> {
        self.client
            .get_object()
            .bucket(&self.bucket)
            .key(object_key)
            .send()
            .await
            .with_context(|| format!("failed to fetch relay object {object_key}"))
    }

    fn read_upload_token(&self, token: &str) -> Result<RelayUploadTokenPayload> {
        read_signed_token(&self.signing_secret, token)
    }
}
