use crate::config::AppConfig;
use crate::protocol::{
    ChatMessage, ClearThreadResponse, RelayFileAnnouncement, RelayFileDescriptor,
    ThreadClearedPayload,
};
use crate::utils::now_ms;
use anyhow::{Context, Result, anyhow};
use sqlx::migrate::Migrator;
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlPoolOptions, MySqlSslMode};
use sqlx::{MySql, MySqlPool, QueryBuilder, Transaction};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;

const GLOBAL_THREAD_KEY: &str = "__global__";
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileLookupError {
    NotFound,
    Forbidden,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct MessageRecordRow {
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
struct RelayFileRecordRow {
    file_id: String,
    from_id: String,
    from_name: String,
    target_id: Option<String>,
    file_name: String,
    size: i64,
    content_type: String,
    object_key: String,
    created_at: i64,
    previewable: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct FileIdRow {
    file_id: String,
}

impl MessageStore {
    pub async fn new(config: &AppConfig) -> Result<Self> {
        let recent_message_limit = i64::try_from(config.recent_message_limit)
            .context("recent_message_limit exceeds i64 range")?;
        let connect_options = MySqlConnectOptions::from_str(&config.mysql_url)
            .context("failed to parse mysql url for sqlx")?
            .ssl_mode(MySqlSslMode::Disabled);
        let pool = MySqlPoolOptions::new()
            .max_connections(10)
            .connect_with(connect_options)
            .await
            .context("failed to connect to mysql through sqlx")?;

        MIGRATOR
            .run(&pool)
            .await
            .context("failed to run sqlx migrations")?;

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
            kind: "text".to_owned(),
            fromId: from_id.to_owned(),
            fromName: from_name.to_owned(),
            targetId: target_id.clone(),
            createdAt: now_ms(),
            transport: "server-sync".to_owned(),
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
        .bind(&message.kind)
        .bind(to_i64(message.createdAt, "message.createdAt")?)
        .bind(&message.transport)
        .bind(message.text.clone())
        .bind(Option::<String>::None)
        .execute(&self.pool)
        .await
        .context("failed to persist text message")?;

        Ok(message)
    }

    pub async fn persist_relay_file_message(
        &self,
        room_id: &str,
        from_id: &str,
        from_name: &str,
        target_id: Option<String>,
        file: RelayFileAnnouncement,
    ) -> Result<ChatMessage> {
        let created_at = now_ms();
        let descriptor = RelayFileDescriptor {
            fileId: file.fileId.clone(),
            fileName: file.fileName.clone(),
            size: file.size,
            contentType: file.contentType.clone(),
            objectKey: file.objectKey.clone(),
            fromId: from_id.to_owned(),
            fromName: from_name.to_owned(),
            createdAt: created_at,
            targetId: target_id.clone(),
            previewable: file.previewable,
        };

        let message = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            roomId: room_id.to_owned(),
            kind: "relay-file".to_owned(),
            fromId: from_id.to_owned(),
            fromName: from_name.to_owned(),
            targetId: target_id.clone(),
            createdAt: created_at,
            transport: "server-relay".to_owned(),
            text: None,
            file: Some(descriptor.clone()),
        };

        let thread_key = build_thread_key(from_id, target_id.as_deref());
        let mut tx = self
            .pool
            .begin()
            .await
            .context("failed to open relay file transaction")?;

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
        .bind(&message.kind)
        .bind(to_i64(message.createdAt, "message.createdAt")?)
        .bind(&message.transport)
        .bind(Option::<String>::None)
        .bind(Some(descriptor.fileId.clone()))
        .execute(&mut *tx)
        .await
        .context("failed to persist relay file message")?;

        tx.commit()
            .await
            .context("failed to commit relay file transaction")?;

        Ok(message)
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

fn relay_file_record_to_descriptor(record: RelayFileRecordRow) -> RelayFileDescriptor {
    RelayFileDescriptor {
        fileId: record.file_id,
        fileName: record.file_name,
        size: record.size as u64,
        contentType: record.content_type,
        objectKey: record.object_key,
        fromId: record.from_id,
        fromName: record.from_name,
        createdAt: record.created_at as u64,
        targetId: record.target_id,
        previewable: record.previewable,
    }
}

fn message_row_to_chat_message(
    row: MessageRecordRow,
    files_by_id: &HashMap<String, RelayFileDescriptor>,
) -> Result<ChatMessage> {
    if let Some(file_id) = row.relay_file_id.as_ref() {
        if !files_by_id.contains_key(file_id) {
            return Err(anyhow!(
                "missing relay file descriptor for message {}",
                row.id
            ));
        }
    }

    Ok(ChatMessage {
        id: row.id,
        roomId: row.room_id,
        kind: row.kind,
        fromId: row.from_id,
        fromName: row.from_name,
        targetId: row.target_id,
        createdAt: row.created_at as u64,
        transport: row.transport,
        text: row.text,
        file: row
            .relay_file_id
            .and_then(|file_id| files_by_id.get(&file_id).cloned()),
    })
}

pub fn normalize_target_id(client_id: &str, target_id: Option<String>) -> Option<String> {
    target_id.filter(|target| !target.is_empty() && target != client_id)
}

pub fn build_thread_key(client_id: &str, target_id: Option<&str>) -> String {
    match normalize_target_id(client_id, target_id.map(ToOwned::to_owned)) {
        None => GLOBAL_THREAD_KEY.to_owned(),
        Some(target_id) => {
            let mut pair = [client_id.to_owned(), target_id];
            pair.sort();
            format!("{}:{}", pair[0], pair[1])
        }
    }
}

async fn collect_orphaned_files(
    tx: &mut Transaction<'_, MySql>,
    room_id: &str,
    removed_rows: &[MessageRecordRow],
) -> Result<Vec<RelayFileDescriptor>> {
    let removed_file_ids = removed_rows
        .iter()
        .filter_map(|row| row.relay_file_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    if removed_file_ids.is_empty() {
        return Ok(Vec::new());
    }

    let still_referenced = load_still_referenced_file_ids(tx.as_mut(), room_id, &removed_file_ids)
        .await
        .context("failed to load remaining relay file references")?;
    let orphaned_file_ids = removed_file_ids
        .into_iter()
        .filter(|file_id| !still_referenced.contains(file_id))
        .collect::<Vec<_>>();

    if orphaned_file_ids.is_empty() {
        return Ok(Vec::new());
    }

    let records = load_relay_files_by_ids_for_room(tx.as_mut(), room_id, &orphaned_file_ids)
        .await
        .context("failed to load orphaned relay file records")?;

    delete_relay_files_by_ids(tx.as_mut(), room_id, &orphaned_file_ids)
        .await
        .context("failed to delete orphaned relay file records")?;

    Ok(records
        .into_iter()
        .map(relay_file_record_to_descriptor)
        .collect())
}

async fn load_still_referenced_file_ids(
    conn: &mut MySqlConnection,
    room_id: &str,
    file_ids: &[String],
) -> Result<HashSet<String>> {
    if file_ids.is_empty() {
        return Ok(HashSet::new());
    }

    let mut builder = QueryBuilder::<MySql>::new(
        "SELECT DISTINCT relay_file_id AS file_id FROM message_records WHERE room_id = ",
    );
    builder
        .push_bind(room_id)
        .push(" AND relay_file_id IS NOT NULL AND relay_file_id IN (");
    push_bind_list(&mut builder, file_ids);
    builder.push(")");

    let rows = builder
        .build_query_as::<FileIdRow>()
        .fetch_all(conn)
        .await?;

    Ok(rows.into_iter().map(|row| row.file_id).collect())
}

async fn load_relay_files_by_ids(
    pool: &MySqlPool,
    file_ids: &[String],
) -> Result<Vec<RelayFileRecordRow>> {
    load_relay_files_by_ids_inner(pool, None, file_ids).await
}

async fn load_relay_files_by_ids_for_room(
    conn: &mut MySqlConnection,
    room_id: &str,
    file_ids: &[String],
) -> Result<Vec<RelayFileRecordRow>> {
    load_relay_files_by_ids_inner(conn, Some(room_id), file_ids).await
}

async fn load_relay_files_by_ids_inner<'e>(
    executor: impl sqlx::Executor<'e, Database = MySql>,
    room_id: Option<&str>,
    file_ids: &[String],
) -> Result<Vec<RelayFileRecordRow>> {
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut builder = QueryBuilder::<MySql>::new(
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
        WHERE
        "#,
    );

    if let Some(room_id) = room_id {
        builder.push("room_id = ").push_bind(room_id).push(" AND ");
    }
    builder.push("file_id IN (");
    push_bind_list(&mut builder, file_ids);
    builder.push(")");

    builder
        .build_query_as::<RelayFileRecordRow>()
        .fetch_all(executor)
        .await
        .map_err(Into::into)
}

async fn delete_relay_files_by_ids(
    conn: &mut MySqlConnection,
    room_id: &str,
    file_ids: &[String],
) -> Result<()> {
    if file_ids.is_empty() {
        return Ok(());
    }

    let mut builder = QueryBuilder::<MySql>::new("DELETE FROM relay_file_records WHERE room_id = ");
    builder.push_bind(room_id).push(" AND file_id IN (");
    push_bind_list(&mut builder, file_ids);
    builder.push(")");

    builder.build().execute(conn).await?;
    Ok(())
}

fn push_bind_list<'a>(builder: &mut QueryBuilder<'a, MySql>, values: &'a [String]) {
    let mut separated = builder.separated(", ");
    for value in values {
        separated.push_bind(value);
    }
}

fn to_i64(value: u64, field_name: &str) -> Result<i64> {
    i64::try_from(value).with_context(|| format!("{field_name} exceeds i64 range"))
}
