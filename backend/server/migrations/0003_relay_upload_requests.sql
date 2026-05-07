CREATE TABLE IF NOT EXISTS relay_upload_requests (
  from_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  request_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  file_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  room_id VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  target_id VARCHAR(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  file_name VARCHAR(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  size BIGINT NOT NULL,
  content_type VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  object_key VARCHAR(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  upload_id VARCHAR(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (from_id, request_id),
  UNIQUE KEY uniq_relay_upload_requests_file_id (file_id),
  KEY index_relay_upload_requests_by_room_id (room_id),
  KEY index_relay_upload_requests_by_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
