package repository

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func OpenSQLite(path string, fileStorePath ...string) (*gorm.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	configureSQLitePool(sqlDB)
	legacyFileRoot := ""
	if len(fileStorePath) > 0 && strings.TrimSpace(fileStorePath[0]) != "" {
		if legacyFileRoot, err = filepath.Abs(fileStorePath[0]); err != nil {
			return nil, err
		}
		legacyFileRoot = filepath.ToSlash(filepath.Clean(legacyFileRoot))
	}
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
	} {
		if err := db.Exec(pragma).Error; err != nil {
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}
	if err := migrateLegacyMessageRecords(db, legacyFileRoot); err != nil {
		return nil, err
	}
	if err := db.AutoMigrate(&MessageRecord{}); err != nil {
		return nil, err
	}
	return db, nil
}

func configureSQLitePool(db *sql.DB) {
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
}

func migrateLegacyMessageRecords(db *gorm.DB, legacyFileRoot string) error {
	if !db.Migrator().HasTable("message_records") {
		return nil
	}
	if db.Migrator().HasColumn(&MessageRecord{}, "SenderID") {
		return nil
	}
	if !hasSQLiteColumn(db, "message_records", "from_id") {
		return nil
	}

	hasRelayFiles := db.Migrator().HasTable("relay_file_records")
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`ALTER TABLE message_records RENAME TO message_records_legacy_rewrite`).Error; err != nil {
			return fmt.Errorf("rename legacy message_records: %w", err)
		}
		if err := tx.Migrator().CreateTable(&MessageRecord{}); err != nil {
			return fmt.Errorf("create migrated message_records: %w", err)
		}

		insertSQL := `
INSERT INTO message_records (
	id, room_id, sender_id, sender_name, target_id, kind, text,
	file_id, file_name, file_size, content_type, storage_path, created_at
)
SELECT
	m.id,
	m.room_id,
	COALESCE(NULLIF(m.from_id, ''), 'unknown'),
	COALESCE(NULLIF(m.from_name, ''), 'Unknown'),
	m.target_id,
	CASE WHEN m.kind = 'relay-file' THEN 'file' ELSE COALESCE(NULLIF(m.kind, ''), 'text') END,
	m.text,
	%s,
	m.created_at
FROM message_records_legacy_rewrite AS m
%s`
		fileColumns := `
	m.relay_file_id,
	NULL,
	0,
	NULL,
	NULL`
		joinClause := ""
		args := []any{}
		if hasRelayFiles {
			fileColumns = `
	COALESCE(m.relay_file_id, r.file_id),
	r.file_name,
	COALESCE(r.size, 0),
	r.content_type,
	CASE
		WHEN r.object_key IS NULL OR r.object_key = '' THEN NULL
		WHEN ? = '' THEN r.object_key
		ELSE ? || '/' || r.object_key
	END`
			joinClause = `LEFT JOIN relay_file_records AS r ON r.file_id = m.relay_file_id`
			args = append(args, legacyFileRoot, legacyFileRoot)
		}
		if err := tx.Exec(fmt.Sprintf(insertSQL, fileColumns, joinClause), args...).Error; err != nil {
			return fmt.Errorf("copy legacy message_records: %w", err)
		}
		if err := tx.Exec(`DROP TABLE message_records_legacy_rewrite`).Error; err != nil {
			return fmt.Errorf("drop legacy message_records: %w", err)
		}
		return nil
	})
}

func hasSQLiteColumn(db *gorm.DB, tableName, columnName string) bool {
	rows, err := db.Raw(`PRAGMA table_info(` + tableName + `)`).Rows()
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, dataType string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &pk); err != nil {
			return false
		}
		if strings.EqualFold(name, columnName) {
			return true
		}
	}
	return false
}
