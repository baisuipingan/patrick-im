CREATE TABLE IF NOT EXISTS message_records (
  id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  room_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  thread_key VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  from_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  from_name VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  target_id VARCHAR(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  kind VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at BIGINT NOT NULL,
  transport VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  text TEXT COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  relay_file_id VARCHAR(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (id),
  KEY index_message_records_by_room_id (room_id),
  KEY index_message_records_by_thread_key (thread_key),
  KEY index_message_records_by_from_id (from_id),
  KEY index_message_records_by_created_at (created_at),
  KEY index_message_records_by_relay_file_id (relay_file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS relay_file_records (
  file_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  room_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  thread_key VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  from_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  from_name VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  target_id VARCHAR(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  file_name VARCHAR(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  size BIGINT NOT NULL,
  content_type VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  object_key VARCHAR(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at BIGINT NOT NULL,
  previewable TINYINT(1) NOT NULL,
  PRIMARY KEY (file_id),
  KEY index_relay_file_records_by_room_id (room_id),
  KEY index_relay_file_records_by_thread_key (thread_key),
  KEY index_relay_file_records_by_from_id (from_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE message_records
  MODIFY COLUMN kind VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  MODIFY COLUMN transport VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  MODIFY COLUMN text TEXT COLLATE utf8mb4_unicode_ci DEFAULT NULL;

ALTER TABLE relay_file_records
  MODIFY COLUMN file_name VARCHAR(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  MODIFY COLUMN object_key VARCHAR(512) COLLATE utf8mb4_unicode_ci NOT NULL;
