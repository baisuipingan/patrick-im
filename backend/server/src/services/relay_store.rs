use crate::config::AppConfig;
use crate::protocol::{
    RelayAbortUploadRequest, RelayCompleteUploadRequest, RelayFileDescriptor, RelayUploadPart,
    RelayUploadPartResponse, RelayUploadRequest, RelayUploadResponse, RelayUploadedPart,
};
use crate::session::SessionPayload;
use crate::signing::{create_signed_token, read_signed_token};
use crate::utils::{build_object_key, now_ms, sanitize_file_name, sanitize_room_id};
use anyhow::{Context, Result, anyhow};
use axum::body::Bytes;
use object_store::local::LocalFileSystem;
use object_store::path::Path;
use object_store::{ObjectStore, PutPayload};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const RELAY_CHUNK_SIZE_BYTES: usize = 5 * 1024 * 1024;

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
pub struct RelayObject {
    pub path: PathBuf,
    pub size: u64,
}

#[derive(Debug)]
pub struct RelayStore {
    store: LocalFileSystem,
    root: PathBuf,
    signing_secret: String,
}

impl RelayStore {
    pub async fn new(config: &AppConfig) -> Result<Self> {
        tokio::fs::create_dir_all(&config.file_store_path)
            .await
            .with_context(|| {
                format!(
                    "failed to create file store path {}",
                    config.file_store_path.display()
                )
            })?;
        let root = config.file_store_path.canonicalize().with_context(|| {
            format!(
                "failed to canonicalize file store path {}",
                config.file_store_path.display()
            )
        })?;
        let store = LocalFileSystem::new_with_prefix(&root)
            .with_context(|| format!("failed to open file store path {}", root.display()))?
            .with_automatic_cleanup(true);

        Ok(Self {
            store,
            root,
            signing_secret: config.session_secret.clone(),
        })
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
        let upload_id = Uuid::new_v4().to_string();
        let object_key = build_object_key(&room_id, &file_id, &file_name);

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

        let response = self.build_upload_response(&payload, Vec::new())?;

        Ok(CreatedRelayUpload {
            token_payload: payload,
            response,
        })
    }

    pub fn resume_upload(
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
        self.build_upload_response(&payload, uploaded_parts)
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
        validate_part_number(&payload, part_number)?;
        validate_part_size(&payload, part_number, bytes.len() as u64)?;

        let etag = sha256_hex(&bytes);
        self.store
            .put(&part_path(&payload, part_number), PutPayload::from(bytes))
            .await
            .with_context(|| {
                format!(
                    "failed to store relay upload part {} for {}",
                    part_number, payload.objectKey
                )
            })?;

        Ok(RelayUploadPartResponse {
            partNumber: part_number,
            etag,
        })
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

        let total_parts = part_count(payload.size);
        if request.parts.len() != total_parts as usize {
            return Err(anyhow!("uploaded part count mismatch"));
        }

        let mut parts = request.parts.clone();
        parts.sort_by_key(|part| part.partNumber);
        let mut total_size = 0_u64;
        let final_path = self.object_filesystem_path(&payload.objectKey)?;
        if let Some(parent) = final_path.parent() {
            tokio::fs::create_dir_all(parent).await.with_context(|| {
                format!(
                    "failed to create relay object directory {}",
                    parent.display()
                )
            })?;
        }
        let temp_path = final_path.with_file_name(format!(
            ".{}.{}.assembling",
            payload.fileId, payload.uploadId
        ));
        let mut output = tokio::fs::File::create(&temp_path).await.with_context(|| {
            format!("failed to create relay temp object {}", temp_path.display())
        })?;

        let assemble_result = async {
            for expected_part_number in 1..=total_parts {
                let part = parts
                    .get((expected_part_number - 1) as usize)
                    .ok_or_else(|| anyhow!("missing uploaded part {expected_part_number}"))?;
                if part.partNumber != i32::try_from(expected_part_number)? {
                    return Err(anyhow!("uploaded part sequence mismatch"));
                }
                validate_part_number(&payload, part.partNumber)?;

                let bytes = self
                    .store
                    .get(&part_path(&payload, part.partNumber))
                    .await
                    .with_context(|| {
                        format!("failed to read relay upload part {}", part.partNumber)
                    })?
                    .bytes()
                    .await
                    .with_context(|| {
                        format!("failed to buffer relay upload part {}", part.partNumber)
                    })?;
                validate_part_size(&payload, part.partNumber, bytes.len() as u64)?;

                let actual_etag = sha256_hex(&bytes);
                if actual_etag != part.etag {
                    return Err(anyhow!("uploaded part checksum mismatch"));
                }
                total_size += bytes.len() as u64;
                output.write_all(&bytes).await.with_context(|| {
                    format!("failed to append relay upload part {}", part.partNumber)
                })?;
            }

            if total_size != payload.size {
                return Err(anyhow!("completed relay upload size mismatch"));
            }

            output.flush().await.with_context(|| {
                format!("failed to flush relay temp object {}", temp_path.display())
            })?;
            output.sync_all().await.with_context(|| {
                format!("failed to sync relay temp object {}", temp_path.display())
            })?;
            drop(output);

            match tokio::fs::rename(&temp_path, &final_path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    tokio::fs::remove_file(&final_path).await.with_context(|| {
                        format!(
                            "failed to replace existing relay object {}",
                            final_path.display()
                        )
                    })?;
                    tokio::fs::rename(&temp_path, &final_path)
                        .await
                        .with_context(|| {
                            format!(
                                "failed to move relay temp object {} to {}",
                                temp_path.display(),
                                final_path.display()
                            )
                        })?;
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "failed to move relay temp object {} to {}",
                            temp_path.display(),
                            final_path.display()
                        )
                    });
                }
            }

            Ok::<(), anyhow::Error>(())
        }
        .await;

        if let Err(error) = assemble_result {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(error);
        }

        let metadata = tokio::fs::metadata(&final_path).await.with_context(|| {
            format!(
                "failed to stat completed relay object {}",
                final_path.display()
            )
        })?;
        if metadata.len() != payload.size {
            let _ = tokio::fs::remove_file(&final_path).await;
            return Err(anyhow!(
                "completed relay object size mismatch: expected {}, got {}",
                payload.size,
                metadata.len()
            ));
        }

        self.delete_upload_parts(&payload).await?;

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

        self.delete_upload_parts(&payload).await?;
        Ok(true)
    }

    pub async fn abort_upload_by_key(&self, object_key: &str, upload_id: &str) -> Result<()> {
        self.delete_upload_parts_by_key(object_key, upload_id).await
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
        match self.store.delete(&object_path(object_key)).await {
            Ok(()) => Ok(()),
            Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(error) => {
                Err(error).with_context(|| format!("failed to delete relay object {object_key}"))
            }
        }
    }

    pub async fn delete_orphaned_files(&self, files: &[RelayFileDescriptor]) -> Result<()> {
        for descriptor in files {
            self.delete_object(descriptor).await?;
        }
        Ok(())
    }

    pub async fn get_object(&self, object_key: &str) -> Result<RelayObject> {
        let object_path = object_path(object_key);
        let meta = self
            .store
            .head(&object_path)
            .await
            .with_context(|| format!("failed to stat relay object {object_key}"))?;
        let path = self.object_filesystem_path(object_key)?;

        Ok(RelayObject {
            path,
            size: meta.size,
        })
    }

    fn object_filesystem_path(&self, object_key: &str) -> Result<PathBuf> {
        let object_path = object_path(object_key);
        let path = self
            .store
            .path_to_filesystem(&object_path)
            .with_context(|| format!("failed to resolve relay object {object_key}"))?;
        if !path.starts_with(&self.root) {
            return Err(anyhow!("relay object path escapes file store root"));
        }
        Ok(path)
    }

    fn read_upload_token(&self, token: &str) -> Result<RelayUploadTokenPayload> {
        read_signed_token(&self.signing_secret, token)
    }

    fn build_upload_response(
        &self,
        payload: &RelayUploadTokenPayload,
        uploaded_parts: Vec<RelayUploadedPart>,
    ) -> Result<RelayUploadResponse> {
        let total_parts = part_count(payload.size);
        let mut parts = Vec::with_capacity(total_parts as usize);

        for part_number in 1..=total_parts {
            let part_number = i32::try_from(part_number).context("relay part number overflow")?;
            parts.push(RelayUploadPart {
                partNumber: part_number,
                uploadUrl: format!("/api/files/upload-part/{part_number}"),
            });
        }

        Ok(RelayUploadResponse {
            fileId: payload.fileId.clone(),
            objectKey: payload.objectKey.clone(),
            uploadToken: create_signed_token(&self.signing_secret, payload)?,
            chunkSizeBytes: RELAY_CHUNK_SIZE_BYTES as u64,
            uploadedParts: uploaded_parts,
            parts,
        })
    }

    async fn delete_upload_parts(&self, payload: &RelayUploadTokenPayload) -> Result<()> {
        self.delete_upload_parts_by_key(&payload.objectKey, &payload.uploadId)
            .await
    }

    async fn delete_upload_parts_by_key(&self, object_key: &str, upload_id: &str) -> Result<()> {
        let prefix = Path::from(format!(
            ".uploads/{upload_id}/{}",
            object_key.trim_start_matches('/')
        ));
        let mut objects = self.store.list(Some(&prefix));

        while let Some(item) = futures_util::TryStreamExt::try_next(&mut objects)
            .await
            .with_context(|| format!("failed to list relay upload parts for {object_key}"))?
        {
            match self.store.delete(&item.location).await {
                Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("failed to delete relay upload part {}", item.location)
                    });
                }
            }
        }

        Ok(())
    }
}

fn object_path(object_key: &str) -> Path {
    Path::from(object_key.trim_start_matches('/').to_owned())
}

fn part_path(payload: &RelayUploadTokenPayload, part_number: i32) -> Path {
    Path::from(format!(
        ".uploads/{}/{}/{}.part",
        payload.uploadId,
        payload.objectKey.trim_start_matches('/'),
        part_number
    ))
}

fn part_count(size: u64) -> u64 {
    size.div_ceil(RELAY_CHUNK_SIZE_BYTES as u64)
}

fn validate_part_number(payload: &RelayUploadTokenPayload, part_number: i32) -> Result<()> {
    if part_number <= 0 {
        return Err(anyhow!("invalid relay upload part number"));
    }
    if part_number as u64 > part_count(payload.size) {
        return Err(anyhow!("relay upload part number out of range"));
    }
    Ok(())
}

fn validate_part_size(
    payload: &RelayUploadTokenPayload,
    part_number: i32,
    actual_size: u64,
) -> Result<()> {
    let expected_size = expected_part_size(payload.size, part_number)?;
    if actual_size != expected_size {
        return Err(anyhow!(
            "relay upload part size mismatch: expected {expected_size}, got {actual_size}"
        ));
    }
    Ok(())
}

fn expected_part_size(total_size: u64, part_number: i32) -> Result<u64> {
    let total_parts = part_count(total_size);
    validate_positive_part_number(part_number)?;
    let part_number = part_number as u64;
    if part_number > total_parts {
        return Err(anyhow!("relay upload part number out of range"));
    }
    if part_number < total_parts {
        return Ok(RELAY_CHUNK_SIZE_BYTES as u64);
    }

    let previous_size = (total_parts - 1) * RELAY_CHUNK_SIZE_BYTES as u64;
    Ok(total_size - previous_size)
}

fn validate_positive_part_number(part_number: i32) -> Result<()> {
    if part_number <= 0 {
        return Err(anyhow!("invalid relay upload part number"));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn normalize_content_type(content_type: &str) -> String {
    if content_type.trim().is_empty() {
        "application/octet-stream".to_owned()
    } else {
        content_type.to_owned()
    }
}
