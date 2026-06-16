mod relay_files;
mod threading;

use crate::config::AppConfig;
use crate::protocol::{
    ChatMessage, ClearThreadResponse, MessageKind, MessageTransport, RelayFileAnnouncement,
    RelayFileDescriptor, RelayUploadedPart, ThreadClearedPayload,
};
use crate::utils::{now_ms, previewable_from_content_type};
use anyhow::{Context, Result, anyhow};
use relay_files::{
    collect_orphaned_files, load_relay_files_by_ids, relay_file_record_to_descriptor,
};
use sqlx::{MySql, MySqlPool};
use sqlx::migrate::Migrator;
use sqlx::migrate::MigrateDatabase;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
pub use threading::{build_thread_key, normalize_target_id};

static MIGRATOR: Migrator = sqlx::migrate!();

#[derive(Debug, Clone)]
pub struct MessageStore {
    pool: MySqlPool,
    recent_message_limit: i64,
}

#[derive(Debug, Clone)]
pub struct ClearThreadOutcome {
    pub response: ClearThreadResponse,
    pub event: Option<ThreadClearedPayload>,
    pub orphaned_files: Vec<RelayFileDescriptor>,
}

#[derive(Debug, Clone)]
pub struct PendingRelayUpload {
    pub file_id: String,
    pub room_id: String,
    pub from_id: String,
    pub target_id: Option<String>,
    pub file_name: String,
    pub size: u64,
    pub content_type: String,
    pub object_key: String,
    pub created_at: u64,
}

#[derive(Debug, Clone)]
pub struct RelayUploadRequestRecord {
    pub from_id: String,
    pub request_id: String,
    pub file_id: String,
    pub room_id: String,
    pub target_id: Option<String>,
    pub file_name: String,
    pub size: u64,
    pub content_type: String,
    pub object_key: String,
    pub upload_id: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileLookupError {
    NotFound,
    Forbidden,
}

#[derive(Debug, Clone)]
pub enum PersistRelayFileMessageOutcome {
    Created(ChatMessage),
    Existing(ChatMessage),
}

#[derive(Debug, Clone)]
#[allow(clippy::large_enum_variant)]
pub enum StoreRelayUploadRequestOutcome {
    Inserted,
    Existing(Box<RelayUploadRequestRecord>),
}

#[derive(Debug, Clone)]
pub enum StorePendingRelayUploadOutcome {
    Inserted,
    Existing(PendingRelayUpload),
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(super) struct MessageRecordRow {
    id: String,
    room_id: String,
    from_id: String,
    from_name: String,
    target_id: Option<String>,
    kind: String,
    created_at: i64,
    transport: String,
    text: Option<String>,
    relay_file_id: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub(super) struct RelayFileRecordRow {
    pub(super) file_id: String,
    pub(super) from_id: String,
    pub(super) from_name: String,
    pub(super) target_id: Option<String>,
    pub(super) file_name: String,
    pub(super) size: i64,
    pub(super) content_type: String,
    pub(super) object_key: String,
    pub(super) created_at: i64,
    pub(super) previewable: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct PendingRelayUploadRow {
    file_id: String,
    room_id: String,
    from_id: String,
    target_id: Option<String>,
    file_name: String,
    size: i64,
    content_type: String,
    object_key: String,
    created_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct RelayUploadRequestRecordRow {
    from_id: String,
    request_id: String,
    file_id: String,
    room_id: String,
    target_id: Option<String>,
    file_name: String,
    size: i64,
    content_type: String,
    object_key: String,
    upload_id: String,
    created_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct RelayUploadPartRow {
    part_number: i32,
    etag: String,
}

impl MessageStore {
    pub async fn new(config: &AppConfig) -> Result<Self> {
        let recent_message_limit = i64::try_from(config.recent_message_limit)
            .context("recent_message_limit exceeds i64 range")?;
        ensure_database_exists(&config.mysql_url).await?;

        let connect_options = MySqlConnectOptions::from_str(&config.mysql_url)
            .context("failed to parse mysql url for sqlx")?
            .ssl_mode(MySqlSslMode::Disabled);
        let pool = MySqlPoolOptions::new()
            .max_connections(10)
            .connect_with(connect_options)
            .await
            .context("failed to connect to mysql through sqlx")?;

        tracing::info!("running sqlx database migrations");
        MIGRATOR
            .run(&pool)
            .await
            .context("failed to run sqlx migrations")?;
        tracing::info!("sqlx database migrations completed");

        Ok(Self {
            pool,
            recent_message_limit,
        })
    }

    pub async fn list_visible_messages(
        &self,
        room_id: &str,
        client_id: &str,
    ) -> Result<Vec<ChatMessage>> {
        let mut rows = sqlx::query_as::<_, MessageRecordRow>(
            r#"
            SELECT
                id,
                room_id,
                from_id,
                from_name,
                target_id,
                kind,
                created_at,
                transport,
                text,
                relay_file_id
            FROM message_records
            WHERE room_id = ?
              AND (target_id IS NULL OR from_id = ? OR target_id = ?)
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            "#,
        )
        .bind(room_id)
        .bind(client_id)
        .bind(client_id)
        .bind(self.recent_message_limit)
        .fetch_all(&self.pool)
        .await
        .context("failed to load visible messages")?;

        rows.reverse();
        self.inflate_messages(rows).await
    }

    pub async fn persist_text_message(
        &self,
        room_id: &str,
        from_id: &str,
        from_name: &str,
        target_id: Option<String>,
        text: &str,
    ) -> Result<ChatMessage> {
        let message = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            roomId: room_id.to_owned(),
            kind: MessageKind::Text,
            fromId: from_id.to_owned(),
            fromName: from_name.to_owned(),
            targetId: target_id.clone(),
            createdAt: now_ms(),
            transport: MessageTransport::ServerSync,
            text: Some(text.trim().to_owned()),
            file: None,
        };

        sqlx::query(
            r#"
            INSERT INTO message_records (
                id,
                room_id,
                thread_key,
                from_id,
                from_name,
                target_id,
                kind,
                created_at,
                transport,
                text,
                relay_file_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&message.id)
        .bind(&message.roomId)
        .bind(build_thread_key(from_id, target_id.as_deref()))
        .bind(&message.fromId)
        .bind(&message.fromName)
        .bind(message.targetId.clone())
        .bind(message.kind.as_str())
        .bind(to_i64(message.createdAt, "message.createdAt")?)
        .bind(message.transport.as_str())
        .bind(message.text.clone())
        .bind(Option::<String>::None)
        .execute(&self.pool)
        .await
        .context("failed to persist text message")?;

        Ok(message)
    }

    pub async fn store_completed_relay_upload(
        &self,
        upload: PendingRelayUpload,
    ) -> Result<StorePendingRelayUploadOutcome> {
        let file_id = upload.file_id.clone();
        let insert_result = sqlx::query(
            r#"
            INSERT INTO pending_relay_uploads (
                file_id,
                room_id,
                from_id,
                target_id,
                file_name,
                size,
                content_type,
                object_key,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&upload.file_id)
        .bind(&upload.room_id)
        .bind(&upload.from_id)
        .bind(upload.target_id.clone())
        .bind(&upload.file_name)
        .bind(to_i64(upload.size, "pending_relay_upload.size")?)
        .bind(&upload.content_type)
        .bind(&upload.object_key)
        .bind(to_i64(
            upload.created_at,
            "pending_relay_upload.created_at",
        )?)
        .execute(&self.pool)
        .await;

        match insert_result {
            Ok(_) => Ok(StorePendingRelayUploadOutcome::Inserted),
            Err(error) if is_unique_violation(&error) => {
                let existing =
                    self.find_pending_relay_upload(&file_id)
                        .await?
                        .ok_or_else(|| {
                            anyhow!("pending relay upload conflicted but could not be reloaded")
                        })?;
                Ok(StorePendingRelayUploadOutcome::Existing(existing))
            }
            Err(error) => Err(error).context("failed to persist pending relay upload"),
        }
    }

    pub async fn find_pending_relay_upload(
        &self,
        file_id: &str,
    ) -> Result<Option<PendingRelayUpload>> {
        sqlx::query_as::<_, PendingRelayUploadRow>(
            r#"
            SELECT
                file_id,
                room_id,
                from_id,
                target_id,
                file_name,
                size,
                content_type,
                object_key,
                created_at
            FROM pending_relay_uploads
            WHERE file_id = ?
            LIMIT 1
            "#,
        )
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await
        .context("failed to load pending relay upload")
        .and_then(|row| row.map(pending_relay_upload_row_to_record).transpose())
    }

    pub async fn find_relay_upload_request(
        &self,
        from_id: &str,
        request_id: &str,
    ) -> Result<Option<RelayUploadRequestRecord>> {
        sqlx::query_as::<_, RelayUploadRequestRecordRow>(
            r#"
            SELECT
                from_id,
                request_id,
                file_id,
                room_id,
                target_id,
                file_name,
                size,
                content_type,
                object_key,
                upload_id,
                created_at
            FROM relay_upload_requests
            WHERE from_id = ? AND request_id = ?
            LIMIT 1
            "#,
        )
        .bind(from_id)
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await
        .context("failed to load relay upload request")
        .and_then(|row| row.map(relay_upload_request_row_to_record).transpose())
    }

    pub async fn store_relay_upload_request(
        &self,
        record: &RelayUploadRequestRecord,
    ) -> Result<StoreRelayUploadRequestOutcome> {
        let insert_result = sqlx::query(
            r#"
            INSERT INTO relay_upload_requests (
                from_id,
                request_id,
                file_id,
                room_id,
                target_id,
                file_name,
                size,
                content_type,
                object_key,
                upload_id,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&record.from_id)
        .bind(&record.request_id)
        .bind(&record.file_id)
        .bind(&record.room_id)
        .bind(record.target_id.clone())
        .bind(&record.file_name)
        .bind(to_i64(record.size, "relay_upload_request.size")?)
        .bind(&record.content_type)
        .bind(&record.object_key)
        .bind(&record.upload_id)
        .bind(to_i64(
            record.created_at,
            "relay_upload_request.created_at",
        )?)
        .execute(&self.pool)
        .await;

        match insert_result {
            Ok(_) => Ok(StoreRelayUploadRequestOutcome::Inserted),
            Err(error) if is_unique_violation(&error) => {
                let existing = self
                    .find_relay_upload_request(&record.from_id, &record.request_id)
                    .await?
                    .ok_or_else(|| {
                        anyhow!("relay upload request conflicted but could not be reloaded")
                    })?;
                Ok(StoreRelayUploadRequestOutcome::Existing(Box::new(existing)))
            }
            Err(error) => Err(error).context("failed to persist relay upload request"),
        }
    }

    pub async fn store_relay_upload_part(
        &self,
        file_id: &str,
        part: &RelayUploadedPart,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO relay_upload_parts (
                file_id,
                part_number,
                etag,
                created_at
            )
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                etag = VALUES(etag),
                created_at = VALUES(created_at)
            "#,
        )
        .bind(file_id)
        .bind(part.partNumber)
        .bind(part.etag.trim_matches('"'))
        .bind(to_i64(now_ms(), "relay_upload_part.created_at")?)
        .execute(&self.pool)
        .await
        .context("failed to persist relay upload part")?;

        Ok(())
    }

    pub async fn list_relay_upload_parts(&self, file_id: &str) -> Result<Vec<RelayUploadedPart>> {
        let rows = sqlx::query_as::<_, RelayUploadPartRow>(
            r#"
            SELECT
                part_number,
                etag
            FROM relay_upload_parts
            WHERE file_id = ?
            ORDER BY part_number ASC
            "#,
        )
        .bind(file_id)
        .fetch_all(&self.pool)
        .await
        .context("failed to list relay upload parts")?;

        Ok(rows
            .into_iter()
            .map(|row| RelayUploadedPart {
                partNumber: row.part_number,
                etag: row.etag,
            })
            .collect())
    }

    pub async fn remove_pending_relay_upload(&self, file_id: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM pending_relay_uploads WHERE file_id = ?")
            .bind(file_id)
            .execute(&self.pool)
            .await
            .context("failed to delete pending relay upload")?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn remove_relay_upload_request_by_file_id(&self, file_id: &str) -> Result<bool> {
        sqlx::query("DELETE FROM relay_upload_parts WHERE file_id = ?")
            .bind(file_id)
            .execute(&self.pool)
            .await
            .context("failed to delete relay upload parts")?;

        let result = sqlx::query("DELETE FROM relay_upload_requests WHERE file_id = ?")
            .bind(file_id)
            .execute(&self.pool)
            .await
            .context("failed to delete relay upload request")?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn persist_confirmed_relay_file_message(
        &self,
        room_id: &str,
        from_id: &str,
        from_name: &str,
        target_id: Option<String>,
        file: RelayFileAnnouncement,
    ) -> Result<PersistRelayFileMessageOutcome> {
        let file_id = file.fileId.clone();
        let created_at = now_ms();
        let mut tx = self
            .pool
            .begin()
            .await
            .context("failed to open relay file transaction")?;
        let pending = sqlx::query_as::<_, PendingRelayUploadRow>(
            r#"
            SELECT
                file_id,
                room_id,
                from_id,
                target_id,
                file_name,
                size,
                content_type,
                object_key,
                created_at
            FROM pending_relay_uploads
            WHERE file_id = ?
            LIMIT 1
            FOR UPDATE
            "#,
        )
        .bind(&file_id)
        .fetch_optional(&mut *tx)
        .await
        .context("failed to load pending relay upload")?;

        if pending.is_none() {
            let existing = load_existing_relay_message_by_file_id(&mut tx, room_id, &file_id)
                .await
                .context("failed to load existing relay file message")?
                .ok_or_else(|| anyhow!("relay file upload is not ready to announce"))?;
            validate_existing_relay_message(room_id, from_id, &existing, &file)?;
            tx.commit()
                .await
                .context("failed to finalize duplicate relay file transaction")?;
            return Ok(PersistRelayFileMessageOutcome::Existing(existing));
        }
        let pending = pending.expect("pending checked above");

        validate_pending_relay_upload(room_id, from_id, &pending, &file)?;
        let descriptor = RelayFileDescriptor {
            fileId: pending.file_id.clone(),
            fileName: pending.file_name.clone(),
            size: to_u64(pending.size, "pending_relay_upload.size")?,
            contentType: pending.content_type.clone(),
            objectKey: pending.object_key.clone(),
            fromId: from_id.to_owned(),
            fromName: from_name.to_owned(),
            createdAt: created_at,
            targetId: target_id.clone(),
            previewable: previewable_from_content_type(&pending.content_type),
        };

        let message = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            roomId: room_id.to_owned(),
            kind: MessageKind::RelayFile,
            fromId: from_id.to_owned(),
            fromName: from_name.to_owned(),
            targetId: target_id.clone(),
            createdAt: created_at,
            transport: MessageTransport::ServerRelay,
            text: None,
            file: Some(descriptor.clone()),
        };

        let thread_key = build_thread_key(from_id, target_id.as_deref());
        sqlx::query(
            r#"
            INSERT INTO relay_file_records (
                file_id,
                room_id,
                thread_key,
                from_id,
                from_name,
                target_id,
                file_name,
                size,
                content_type,
                object_key,
                created_at,
                previewable
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&descriptor.fileId)
        .bind(room_id)
        .bind(&thread_key)
        .bind(&descriptor.fromId)
        .bind(&descriptor.fromName)
        .bind(descriptor.targetId.clone())
        .bind(&descriptor.fileName)
        .bind(to_i64(descriptor.size, "relay_file.size")?)
        .bind(&descriptor.contentType)
        .bind(&descriptor.objectKey)
        .bind(to_i64(descriptor.createdAt, "relay_file.createdAt")?)
        .bind(descriptor.previewable)
        .execute(&mut *tx)
        .await
        .context("failed to persist relay file record")?;

        sqlx::query(
            r#"
            INSERT INTO message_records (
                id,
                room_id,
                thread_key,
                from_id,
                from_name,
                target_id,
                kind,
                created_at,
                transport,
                text,
                relay_file_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&message.id)
        .bind(room_id)
        .bind(&thread_key)
        .bind(&message.fromId)
        .bind(&message.fromName)
        .bind(message.targetId.clone())
        .bind(message.kind.as_str())
        .bind(to_i64(message.createdAt, "message.createdAt")?)
        .bind(message.transport.as_str())
        .bind(Option::<String>::None)
        .bind(Some(descriptor.fileId.clone()))
        .execute(&mut *tx)
        .await
        .context("failed to persist relay file message")?;

        sqlx::query("DELETE FROM pending_relay_uploads WHERE file_id = ?")
            .bind(&pending.file_id)
            .execute(&mut *tx)
            .await
            .context("failed to delete pending relay upload after announcement")?;

        sqlx::query("DELETE FROM relay_upload_requests WHERE file_id = ?")
            .bind(&pending.file_id)
            .execute(&mut *tx)
            .await
            .context("failed to delete relay upload request after announcement")?;

        tx.commit()
            .await
            .context("failed to commit relay file transaction")?;

        Ok(PersistRelayFileMessageOutcome::Created(message))
    }

    pub async fn clear_thread(
        &self,
        room_id: &str,
        actor_id: &str,
        actor_name: &str,
        target_id: Option<String>,
    ) -> Result<ClearThreadOutcome> {
        let thread_key = build_thread_key(actor_id, target_id.as_deref());
        let mut tx = self
            .pool
            .begin()
            .await
            .context("failed to open clear-thread transaction")?;

        let removed_rows = sqlx::query_as::<_, MessageRecordRow>(
            r#"
            SELECT
                id,
                room_id,
                from_id,
                from_name,
                target_id,
                kind,
                created_at,
                transport,
                text,
                relay_file_id
            FROM message_records
            WHERE room_id = ? AND thread_key = ?
            FOR UPDATE
            "#,
        )
        .bind(room_id)
        .bind(&thread_key)
        .fetch_all(&mut *tx)
        .await
        .context("failed to load thread messages before clear")?;

        sqlx::query("DELETE FROM message_records WHERE room_id = ? AND thread_key = ?")
            .bind(room_id)
            .bind(&thread_key)
            .execute(&mut *tx)
            .await
            .context("failed to delete thread messages")?;

        let orphaned_files = collect_orphaned_files(&mut tx, room_id, &removed_rows).await?;

        tx.commit()
            .await
            .context("failed to commit clear-thread transaction")?;

        let response = ClearThreadResponse {
            targetId: normalize_target_id(actor_id, target_id.clone()),
            removedMessages: removed_rows.len(),
            removedRelayFiles: orphaned_files.len(),
        };
        let event = if removed_rows.is_empty() {
            None
        } else {
            Some(ThreadClearedPayload {
                targetId: response.targetId.clone(),
                actorId: actor_id.to_owned(),
                actorName: actor_name.to_owned(),
                removedMessages: response.removedMessages,
                removedRelayFiles: response.removedRelayFiles,
            })
        };

        Ok(ClearThreadOutcome {
            response,
            event,
            orphaned_files,
        })
    }

    pub async fn lookup_file_for_client(
        &self,
        room_id: &str,
        file_id: &str,
        client_id: &str,
    ) -> Result<RelayFileDescriptor, FileLookupError> {
        let file = sqlx::query_as::<_, RelayFileRecordRow>(
            r#"
            SELECT
                file_id,
                from_id,
                from_name,
                target_id,
                file_name,
                size,
                content_type,
                object_key,
                created_at,
                previewable
            FROM relay_file_records
            WHERE file_id = ? AND room_id = ?
            LIMIT 1
            "#,
        )
        .bind(file_id)
        .bind(room_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| FileLookupError::NotFound)?;

        let Some(file) = file else {
            return Err(FileLookupError::NotFound);
        };

        let descriptor = relay_file_record_to_descriptor(file);
        let allowed = descriptor
            .targetId
            .as_ref()
            .map(|target| descriptor.fromId == client_id || target == client_id)
            .unwrap_or(true);
        if allowed {
            Ok(descriptor)
        } else {
            Err(FileLookupError::Forbidden)
        }
    }

    async fn inflate_messages(&self, rows: Vec<MessageRecordRow>) -> Result<Vec<ChatMessage>> {
        let file_ids = rows
            .iter()
            .filter_map(|row| row.relay_file_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        let files_by_id = if file_ids.is_empty() {
            HashMap::new()
        } else {
            load_relay_files_by_ids(&self.pool, &file_ids)
                .await
                .context("failed to load relay file descriptors for messages")?
                .into_iter()
                .map(|record| {
                    (
                        record.file_id.clone(),
                        relay_file_record_to_descriptor(record),
                    )
                })
                .collect::<HashMap<_, _>>()
        };

        rows.into_iter()
            .map(|row| message_row_to_chat_message(row, &files_by_id))
            .collect()
    }
}

async fn ensure_database_exists(mysql_url: &str) -> Result<()> {
    if MySql::database_exists(mysql_url)
        .await
        .context("failed to check mysql database existence")?
    {
        return Ok(());
    }

    MySql::create_database(mysql_url)
        .await
        .context("failed to create mysql database")?;
    tracing::info!("created mysql database for patrick-im");
    Ok(())
}

fn validate_pending_relay_upload(
    room_id: &str,
    from_id: &str,
    pending: &PendingRelayUploadRow,
    file: &RelayFileAnnouncement,
) -> Result<()> {
    if pending.file_id != file.fileId
        || pending.room_id != room_id
        || pending.from_id != from_id
        || pending.object_key != file.objectKey
        || pending.file_name != file.fileName
        || to_u64(pending.size, "pending_relay_upload.size")? != file.size
        || pending.content_type != file.contentType
        || pending.target_id != file.targetId
    {
        return Err(anyhow!(
            "relay file announcement does not match completed upload"
        ));
    }

    Ok(())
}

fn validate_existing_relay_message(
    room_id: &str,
    from_id: &str,
    message: &ChatMessage,
    file: &RelayFileAnnouncement,
) -> Result<()> {
    let Some(descriptor) = message.file.as_ref() else {
        return Err(anyhow!(
            "existing relay file message is missing its descriptor"
        ));
    };

    if message.roomId != room_id
        || message.kind != MessageKind::RelayFile
        || message.transport != MessageTransport::ServerRelay
        || message.fromId != from_id
        || descriptor.fileId != file.fileId
        || descriptor.fileName != file.fileName
        || descriptor.size != file.size
        || descriptor.contentType != file.contentType
        || descriptor.objectKey != file.objectKey
    {
        return Err(anyhow!(
            "relay file announcement does not match stored relay message"
        ));
    }

    Ok(())
}

fn message_row_to_chat_message(
    row: MessageRecordRow,
    files_by_id: &HashMap<String, RelayFileDescriptor>,
) -> Result<ChatMessage> {
    let row_id = row.id.clone();
    if let Some(file_id) = row.relay_file_id.as_ref()
        && !files_by_id.contains_key(file_id)
    {
        return Err(anyhow!(
            "missing relay file descriptor for message {}",
            row_id
        ));
    }

    Ok(ChatMessage {
        id: row.id,
        roomId: row.room_id,
        kind: MessageKind::parse(&row.kind)
            .with_context(|| format!("invalid message kind in row {}", row_id))?,
        fromId: row.from_id,
        fromName: row.from_name,
        targetId: row.target_id,
        createdAt: row.created_at as u64,
        transport: MessageTransport::parse(&row.transport)
            .with_context(|| format!("invalid message transport in row {}", row_id))?,
        text: row.text,
        file: row
            .relay_file_id
            .and_then(|file_id| files_by_id.get(&file_id).cloned()),
    })
}

fn to_i64(value: u64, field_name: &str) -> Result<i64> {
    i64::try_from(value).with_context(|| format!("{field_name} exceeds i64 range"))
}

fn to_u64(value: i64, field_name: &str) -> Result<u64> {
    u64::try_from(value).with_context(|| format!("{field_name} is negative"))
}

fn relay_upload_request_row_to_record(
    row: RelayUploadRequestRecordRow,
) -> Result<RelayUploadRequestRecord> {
    Ok(RelayUploadRequestRecord {
        from_id: row.from_id,
        request_id: row.request_id,
        file_id: row.file_id,
        room_id: row.room_id,
        target_id: row.target_id,
        file_name: row.file_name,
        size: to_u64(row.size, "relay_upload_request.size")?,
        content_type: row.content_type,
        object_key: row.object_key,
        upload_id: row.upload_id,
        created_at: to_u64(row.created_at, "relay_upload_request.created_at")?,
    })
}

fn pending_relay_upload_row_to_record(row: PendingRelayUploadRow) -> Result<PendingRelayUpload> {
    Ok(PendingRelayUpload {
        file_id: row.file_id,
        room_id: row.room_id,
        from_id: row.from_id,
        target_id: row.target_id,
        file_name: row.file_name,
        size: to_u64(row.size, "pending_relay_upload.size")?,
        content_type: row.content_type,
        object_key: row.object_key,
        created_at: to_u64(row.created_at, "pending_relay_upload.created_at")?,
    })
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .map(|database_error| database_error.is_unique_violation())
        .unwrap_or(false)
}

async fn load_existing_relay_message_by_file_id(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    room_id: &str,
    file_id: &str,
) -> Result<Option<ChatMessage>> {
    let row = sqlx::query_as::<_, MessageRecordRow>(
        r#"
        SELECT
            id,
            room_id,
            from_id,
            from_name,
            target_id,
            kind,
            created_at,
            transport,
            text,
            relay_file_id
        FROM message_records
        WHERE room_id = ? AND relay_file_id = ?
        LIMIT 1
        "#,
    )
    .bind(room_id)
    .bind(file_id)
    .fetch_optional(&mut **tx)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };

    let relay_file = sqlx::query_as::<_, RelayFileRecordRow>(
        r#"
        SELECT
            file_id,
            from_id,
            from_name,
            target_id,
            file_name,
            size,
            content_type,
            object_key,
            created_at,
            previewable
        FROM relay_file_records
        WHERE room_id = ? AND file_id = ?
        LIMIT 1
        "#,
    )
    .bind(room_id)
    .bind(file_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| anyhow!("relay file record is missing for file {file_id}"))?;

    let descriptor = relay_file_record_to_descriptor(relay_file);
    let files_by_id = HashMap::from([(file_id.to_owned(), descriptor)]);
    message_row_to_chat_message(row, &files_by_id).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_i64_rejects_overflow() {
        let error = to_i64((i64::MAX as u64) + 1, "overflow").unwrap_err();
        assert!(error.to_string().contains("overflow exceeds i64 range"));
    }

    #[test]
    fn validate_pending_relay_upload_rejects_mismatch() {
        let pending = PendingRelayUploadRow {
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
        let file = RelayFileAnnouncement {
            fileId: "file-1".to_owned(),
            fileName: "other.png".to_owned(),
            size: 42,
            contentType: "image/png".to_owned(),
            objectKey: "rooms/room-1/file-1/demo.png".to_owned(),
            targetId: Some("bob".to_owned()),
            previewable: true,
        };

        let error = validate_pending_relay_upload("room-1", "alice", &pending, &file).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("relay file announcement does not match completed upload")
        );
    }

    #[test]
    fn validate_existing_relay_message_rejects_mismatch() {
        let message = ChatMessage {
            id: "msg-1".to_owned(),
            roomId: "room-1".to_owned(),
            kind: MessageKind::RelayFile,
            fromId: "alice".to_owned(),
            fromName: "Alice".to_owned(),
            targetId: None,
            createdAt: 1,
            transport: MessageTransport::ServerRelay,
            text: None,
            file: Some(RelayFileDescriptor {
                fileId: "file-1".to_owned(),
                fileName: "demo.png".to_owned(),
                size: 42,
                contentType: "image/png".to_owned(),
                objectKey: "rooms/room-1/file-1/demo.png".to_owned(),
                fromId: "alice".to_owned(),
                fromName: "Alice".to_owned(),
                createdAt: 1,
                targetId: None,
                previewable: true,
            }),
        };
        let file = RelayFileAnnouncement {
            fileId: "file-1".to_owned(),
            fileName: "other.png".to_owned(),
            size: 42,
            contentType: "image/png".to_owned(),
            objectKey: "rooms/room-1/file-1/demo.png".to_owned(),
            targetId: None,
            previewable: true,
        };

        let error =
            validate_existing_relay_message("room-1", "alice", &message, &file).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("relay file announcement does not match stored relay message")
        );
    }

    #[test]
    fn to_u64_rejects_negative_values() {
        let error = to_u64(-1, "negative").unwrap_err();
        assert!(error.to_string().contains("negative is negative"));
    }
}
