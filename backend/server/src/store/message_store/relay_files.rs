use super::{MessageRecordRow, RelayFileRecordRow};
use crate::protocol::RelayFileDescriptor;
use anyhow::{Context, Result};
use sqlx::mysql::MySqlConnection;
use sqlx::{MySql, MySqlPool, QueryBuilder, Transaction};
use std::collections::HashSet;

#[derive(Debug, Clone, sqlx::FromRow)]
struct FileIdRow {
    file_id: String,
}

pub(super) fn relay_file_record_to_descriptor(record: RelayFileRecordRow) -> RelayFileDescriptor {
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

pub(super) async fn collect_orphaned_files(
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

pub(super) async fn load_relay_files_by_ids(
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
