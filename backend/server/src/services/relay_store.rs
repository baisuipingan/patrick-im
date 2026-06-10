use crate::config::AppConfig;
use crate::protocol::{
    RelayAbortUploadRequest, RelayCompleteUploadRequest, RelayFileDescriptor, RelayPresignedHeader,
    RelayPresignedPart, RelayUploadRequest, RelayUploadResponse, RelayUploadedPart,
};
use crate::session::SessionPayload;
use crate::signing::{create_signed_token, read_signed_token};
use crate::utils::{build_object_key, now_ms, sanitize_file_name, sanitize_room_id};
use anyhow::{Context, Result, anyhow};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Builder as S3ConfigBuilder, Credentials, Region};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

const RELAY_CHUNK_SIZE_BYTES: usize = 5 * 1024 * 1024;
const RELAY_UPLOAD_URL_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const RELAY_DOWNLOAD_URL_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct RelayUploadTokenPayload {
    pub fileId: String,
    pub objectKey: String,
    pub uploadId: String,
    pub roomId: String,
    pub fileName: String,
    pub contentType: String,
    pub size: u64,
    pub targetId: Option<String>,
    pub fromId: String,
    pub issuedAt: u64,
}

#[derive(Debug, Clone)]
pub struct CompletedRelayUpload {
    pub file_id: String,
    pub room_id: String,
    pub file_name: String,
    pub size: u64,
    pub content_type: String,
    pub object_key: String,
    pub target_id: Option<String>,
    pub from_id: String,
    pub created_at: u64,
}

#[derive(Debug, Clone)]
pub struct CreatedRelayUpload {
    pub token_payload: RelayUploadTokenPayload,
    pub response: RelayUploadResponse,
}

#[derive(Debug, Clone)]
pub struct ResumeRelayUploadInput {
    pub file_id: String,
    pub object_key: String,
    pub upload_id: String,
    pub room_id: String,
    pub file_name: String,
    pub content_type: String,
    pub size: u64,
    pub target_id: Option<String>,
    pub from_id: String,
}

#[derive(Debug, Clone)]
pub struct RelayUploadHandle {
    pub file_id: String,
    pub object_key: String,
}

#[derive(Debug, Clone)]
pub struct RelayStore {
    client: Client,
    presign_client: Client,
    bucket: String,
    signing_secret: String,
}

impl RelayStore {
    pub fn new(config: &AppConfig) -> Self {
        Self {
            client: build_s3_client(
                &config.rustfs_endpoint,
                &config.rustfs_access_key,
                &config.rustfs_secret_key,
            ),
            presign_client: build_s3_client(
                &config.rustfs_public_endpoint,
                &config.rustfs_access_key,
                &config.rustfs_secret_key,
            ),
            bucket: config.rustfs_bucket.clone(),
            signing_secret: config.session_secret.clone(),
        }
    }

    pub async fn create_upload(
        &self,
        session: &SessionPayload,
        request: RelayUploadRequest,
    ) -> Result<CreatedRelayUpload> {
        let room_id = sanitize_room_id(&request.roomId);
        let file_name = sanitize_file_name(&request.fileName);
        let content_type = normalize_content_type(&request.contentType);

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

        let response = self.build_upload_response(&payload, Vec::new()).await?;

        Ok(CreatedRelayUpload {
            token_payload: payload,
            response,
        })
    }

    pub async fn resume_upload(
        &self,
        input: ResumeRelayUploadInput,
        uploaded_parts: Vec<RelayUploadedPart>,
    ) -> Result<RelayUploadResponse> {
        let payload = RelayUploadTokenPayload {
            fileId: input.file_id,
            objectKey: input.object_key,
            uploadId: input.upload_id,
            roomId: input.room_id,
            fileName: input.file_name,
            contentType: input.content_type,
            size: input.size,
            targetId: input.target_id,
            fromId: input.from_id,
            issuedAt: now_ms(),
        };
        self.build_upload_response(&payload, uploaded_parts).await
    }

    pub async fn complete_upload(
        &self,
        session: &SessionPayload,
        request: RelayCompleteUploadRequest,
    ) -> Result<CompletedRelayUpload> {
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

        Ok(CompletedRelayUpload {
            file_id: payload.fileId,
            room_id: payload.roomId,
            file_name: payload.fileName,
            size: payload.size,
            content_type: payload.contentType,
            object_key: payload.objectKey,
            target_id: payload.targetId,
            from_id: payload.fromId,
            created_at: now_ms(),
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
        Ok(result.is_ok())
    }

    pub async fn abort_upload_by_key(&self, object_key: &str, upload_id: &str) -> Result<()> {
        self.client
            .abort_multipart_upload()
            .bucket(&self.bucket)
            .key(object_key)
            .upload_id(upload_id)
            .send()
            .await
            .with_context(|| format!("failed to abort relay upload {object_key}"))
            .map(|_| ())
    }

    pub fn verify_upload_token(
        &self,
        session: &SessionPayload,
        upload_token: &str,
    ) -> Result<RelayUploadHandle> {
        let payload = self.read_upload_token(upload_token)?;
        if payload.fromId != session.clientId {
            return Err(anyhow!("invalid upload token owner"));
        }

        Ok(RelayUploadHandle {
            file_id: payload.fileId,
            object_key: payload.objectKey,
        })
    }

    pub fn describe_upload_token(
        &self,
        session: &SessionPayload,
        upload_token: &str,
    ) -> Result<RelayUploadTokenPayload> {
        let payload = self.read_upload_token(upload_token)?;
        if payload.fromId != session.clientId {
            return Err(anyhow!("invalid upload token owner"));
        }

        Ok(payload)
    }

    pub async fn delete_object(&self, descriptor: &RelayFileDescriptor) -> Result<()> {
        self.delete_object_by_key(&descriptor.objectKey).await
    }

    pub async fn delete_object_by_key(&self, object_key: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(object_key)
            .send()
            .await
            .with_context(|| format!("failed to delete relay object {object_key}"))?;
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

    pub async fn create_presigned_download_url(
        &self,
        object_key: &str,
        content_disposition: String,
        content_type: String,
    ) -> Result<String> {
        let presigning_config =
            PresigningConfig::expires_in(RELAY_DOWNLOAD_URL_TTL).context("invalid presign ttl")?;
        let presigned = self
            .presign_client
            .get_object()
            .bucket(&self.bucket)
            .key(object_key)
            .response_content_disposition(content_disposition)
            .response_content_type(content_type)
            .presigned(presigning_config)
            .await
            .with_context(|| format!("failed to presign relay download {object_key}"))?;

        Ok(presigned.uri().to_owned())
    }

    fn read_upload_token(&self, token: &str) -> Result<RelayUploadTokenPayload> {
        read_signed_token(&self.signing_secret, token)
    }

    async fn build_upload_response(
        &self,
        payload: &RelayUploadTokenPayload,
        uploaded_parts: Vec<RelayUploadedPart>,
    ) -> Result<RelayUploadResponse> {
        let part_count = payload.size.div_ceil(RELAY_CHUNK_SIZE_BYTES as u64);
        let part_urls = self
            .create_presigned_part_urls(&payload.objectKey, &payload.uploadId, part_count)
            .await?;

        Ok(RelayUploadResponse {
            fileId: payload.fileId.clone(),
            objectKey: payload.objectKey.clone(),
            uploadToken: create_signed_token(&self.signing_secret, payload)?,
            chunkSizeBytes: RELAY_CHUNK_SIZE_BYTES as u64,
            uploadedParts: uploaded_parts,
            partUrls: part_urls,
        })
    }

    #[allow(dead_code)]
    async fn list_uploaded_parts(
        &self,
        object_key: &str,
        upload_id: &str,
    ) -> Result<Vec<RelayUploadedPart>> {
        let mut part_number_marker = None;
        let mut uploaded_parts = Vec::new();

        loop {
            let response = self
                .client
                .list_parts()
                .bucket(&self.bucket)
                .key(object_key)
                .upload_id(upload_id)
                .set_part_number_marker(part_number_marker)
                .send()
                .await
                .with_context(|| format!("failed to list uploaded relay parts for {object_key}"))?;

            if let Some(parts) = response.parts {
                uploaded_parts.extend(parts.into_iter().filter_map(|part| {
                    let part_number = part.part_number?;
                    let etag = part.e_tag?.trim_matches('"').to_owned();
                    if etag.is_empty() {
                        return None;
                    }
                    Some(RelayUploadedPart {
                        partNumber: part_number,
                        etag,
                    })
                }));
            }

            if response.is_truncated != Some(true) {
                break;
            }

            part_number_marker = response.next_part_number_marker;
        }

        uploaded_parts.sort_by_key(|part| part.partNumber);
        Ok(uploaded_parts)
    }

    async fn create_presigned_part_urls(
        &self,
        object_key: &str,
        upload_id: &str,
        part_count: u64,
    ) -> Result<Vec<RelayPresignedPart>> {
        let presigning_config =
            PresigningConfig::expires_in(RELAY_UPLOAD_URL_TTL).context("invalid presign ttl")?;
        let mut parts = Vec::with_capacity(part_count as usize);

        for part_number in 1..=part_count {
            let part_number = i32::try_from(part_number).context("relay part number overflow")?;
            let presigned = self
                .presign_client
                .upload_part()
                .bucket(&self.bucket)
                .key(object_key)
                .upload_id(upload_id)
                .part_number(part_number)
                .presigned(presigning_config.clone())
                .await
                .context("failed to presign relay upload part")?;

            parts.push(RelayPresignedPart {
                partNumber: part_number,
                url: presigned.uri().to_owned(),
                headers: presigned
                    .headers()
                    .map(|(name, value)| RelayPresignedHeader {
                        name: name.to_owned(),
                        value: value.to_owned(),
                    })
                    .collect(),
            });
        }

        Ok(parts)
    }
}

fn build_s3_client(endpoint: &str, access_key: &str, secret_key: &str) -> Client {
    let credentials = Credentials::new(
        access_key.to_owned(),
        secret_key.to_owned(),
        None,
        None,
        "patrick-im-rustfs",
    );
    let s3_config = S3ConfigBuilder::new()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("us-east-1"))
        .endpoint_url(endpoint)
        .force_path_style(true)
        .credentials_provider(credentials)
        .build();
    Client::from_conf(s3_config)
}

fn normalize_content_type(content_type: &str) -> String {
    if content_type.trim().is_empty() {
        "application/octet-stream".to_owned()
    } else {
        content_type.to_owned()
    }
}
