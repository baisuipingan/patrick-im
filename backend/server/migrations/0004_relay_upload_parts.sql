CREATE TABLE IF NOT EXISTS relay_upload_parts (
  file_id VARCHAR(64) NOT NULL,
  part_number INT NOT NULL,
  etag VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (file_id, part_number),
  KEY index_relay_upload_parts_by_created_at (created_at),
  CONSTRAINT fk_relay_upload_parts_file_id
    FOREIGN KEY (file_id) REFERENCES relay_upload_requests(file_id)
    ON DELETE CASCADE
);
