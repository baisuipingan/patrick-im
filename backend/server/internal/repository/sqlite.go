package repository

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
	if err := runVersionedMigrations(db); err != nil {
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
		if err := dropSQLiteIndexes(tx, "message_records_legacy_rewrite"); err != nil {
			return err
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

type schemaMigration struct {
	version int64
	name    string
	run     func(*gorm.DB) error
}

func runVersionedMigrations(db *gorm.DB) error {
	if err := db.AutoMigrate(&SchemaMigrationRecord{}); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	migrations := []schemaMigration{
		{version: 1, name: "core_im_v2", run: migrateCoreIMV2},
		{version: 2, name: "backfill_legacy_messages", run: backfillV2FromMessageRecords},
		{version: 3, name: "core_im_v2_indexes", run: migrateCoreIMV2Indexes},
	}
	for _, migration := range migrations {
		applied, err := isMigrationApplied(db, migration.version)
		if err != nil {
			return err
		}
		if applied {
			continue
		}
		if err := db.Transaction(func(tx *gorm.DB) error {
			if err := migration.run(tx); err != nil {
				return fmt.Errorf("migration %03d_%s: %w", migration.version, migration.name, err)
			}
			return tx.Create(&SchemaMigrationRecord{
				Version:   migration.version,
				Name:      migration.name,
				AppliedAt: time.Now().UnixMilli(),
			}).Error
		}); err != nil {
			return err
		}
	}
	return nil
}

func isMigrationApplied(db *gorm.DB, version int64) (bool, error) {
	var count int64
	if err := db.Model(&SchemaMigrationRecord{}).Where("version = ?", version).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func migrateCoreIMV2(tx *gorm.DB) error {
	return tx.AutoMigrate(
		&UserRecord{},
		&RoomRecord{},
		&RoomMemberRecord{},
		&ConversationRecord{},
		&MessageV2Record{},
		&AttachmentRecord{},
		&TransferRecord{},
		&ReadStateRecord{},
	)
}

func backfillV2FromMessageRecords(tx *gorm.DB) error {
	var rows []MessageRecord
	if err := tx.Order("created_at ASC, id ASC").Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		if err := upsertV2FromMessageRecord(tx, row); err != nil {
			return err
		}
	}
	return nil
}

func upsertV2FromMessageRecord(tx *gorm.DB, row MessageRecord) error {
	now := row.CreatedAt
	if now <= 0 {
		now = time.Now().UnixMilli()
	}
	if err := upsertUser(tx, row.SenderID, row.SenderName, now); err != nil {
		return err
	}
	if row.TargetID != nil {
		if err := upsertUser(tx, *row.TargetID, *row.TargetID, now); err != nil {
			return err
		}
	}
	if err := upsertRoom(tx, row.RoomID, now); err != nil {
		return err
	}
	if err := upsertRoomMember(tx, row.RoomID, row.SenderID, row.SenderName, now); err != nil {
		return err
	}
	conversation := conversationRecordForMessage(row)
	if err := upsertConversation(tx, conversation, row); err != nil {
		return err
	}
	messageType := row.Kind
	if row.FileID != nil && row.ContentType != nil && strings.HasPrefix(strings.ToLower(*row.ContentType), "image/") {
		messageType = "image"
	}
	message := MessageV2Record{
		ID:             row.ID,
		RoomID:         row.RoomID,
		ConversationID: conversation.ID,
		SenderID:       row.SenderID,
		SenderName:     row.SenderName,
		TargetID:       row.TargetID,
		Type:           messageType,
		Text:           row.Text,
		Status:         "sent",
		CreatedAt:      now,
	}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&message).Error; err != nil {
		return err
	}
	if row.FileID == nil || row.FileName == nil || row.ContentType == nil {
		return nil
	}
	attachment := AttachmentRecord{
		ID:          *row.FileID,
		MessageID:   row.ID,
		FileName:    *row.FileName,
		Size:        row.FileSize,
		ContentType: *row.ContentType,
		StorageKind: "local",
		StoragePath: row.StoragePath,
		Previewable: strings.HasPrefix(strings.ToLower(*row.ContentType), "image/"),
		CreatedAt:   now,
	}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&attachment).Error
}

func upsertUser(tx *gorm.DB, id, nickname string, now int64) error {
	id = strings.TrimSpace(id)
	if id == "" {
		id = "unknown"
	}
	nickname = strings.TrimSpace(nickname)
	if nickname == "" {
		nickname = id
	}
	record := UserRecord{ID: id, Nickname: nickname, CreatedAt: now, UpdatedAt: now}
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns([]string{"nickname", "updated_at"}),
	}).Create(&record).Error
}

func upsertRoom(tx *gorm.DB, roomID string, now int64) error {
	record := RoomRecord{ID: roomID, DisplayName: roomID, CreatedAt: now, UpdatedAt: now}
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "id"}},
		DoUpdates: clause.AssignmentColumns([]string{"display_name", "updated_at"}),
	}).Create(&record).Error
}

func upsertRoomMember(tx *gorm.DB, roomID, userID, nickname string, now int64) error {
	record := RoomMemberRecord{
		ID:         roomMemberID(roomID, userID),
		RoomID:     roomID,
		UserID:     userID,
		Nickname:   nickname,
		Role:       "member",
		JoinedAt:   now,
		LastSeenAt: now,
	}
	return tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "room_id"}, {Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"nickname", "last_seen_at"}),
	}).Create(&record).Error
}

func upsertConversation(tx *gorm.DB, record ConversationRecord, row MessageRecord) error {
	summary := summarizeMessageRecord(row)
	record.LastMessageID = &row.ID
	record.LastMessageText = &summary
	record.LastMessageAt = row.CreatedAt
	record.UpdatedAt = row.CreatedAt
	return tx.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "id"}},
		DoUpdates: clause.Assignments(map[string]any{
			"title":             record.Title,
			"peer_user_id":      record.PeerUserID,
			"last_message_id":   record.LastMessageID,
			"last_message_text": record.LastMessageText,
			"last_message_at":   record.LastMessageAt,
			"updated_at":        record.UpdatedAt,
		}),
	}).Create(&record).Error
}

func conversationRecordForMessage(row MessageRecord) ConversationRecord {
	now := row.CreatedAt
	if now <= 0 {
		now = time.Now().UnixMilli()
	}
	if row.TargetID == nil || strings.TrimSpace(*row.TargetID) == "" {
		return ConversationRecord{
			ID:        roomConversationID(row.RoomID),
			RoomID:    row.RoomID,
			Type:      "room",
			Title:     "房间聊天",
			CreatedAt: now,
			UpdatedAt: now,
		}
	}
	peerID := strings.TrimSpace(*row.TargetID)
	return ConversationRecord{
		ID:         directConversationID(row.RoomID, row.SenderID, peerID),
		RoomID:     row.RoomID,
		Type:       "direct",
		Title:      "私聊",
		PeerUserID: &peerID,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

func summarizeMessageRecord(row MessageRecord) string {
	if row.Text != nil && strings.TrimSpace(*row.Text) != "" {
		text := strings.TrimSpace(*row.Text)
		if len([]rune(text)) > 160 {
			return string([]rune(text)[:160])
		}
		return text
	}
	if row.FileName != nil {
		if row.ContentType != nil && strings.HasPrefix(strings.ToLower(*row.ContentType), "image/") {
			return "[图片] " + *row.FileName
		}
		return "[文件] " + *row.FileName
	}
	return "新消息"
}

func migrateCoreIMV2Indexes(tx *gorm.DB) error {
	statements := []string{
		`CREATE INDEX IF NOT EXISTS idx_conversations_room_updated ON conversations(room_id, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_v2_messages_room_created_desc ON messages(room_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)`,
		`CREATE INDEX IF NOT EXISTS idx_transfers_room_updated ON transfers(room_id, updated_at DESC)`,
	}
	for _, statement := range statements {
		if err := tx.Exec(statement).Error; err != nil {
			return err
		}
	}
	return nil
}

func roomConversationID(roomID string) string {
	return "room:" + roomID
}

func directConversationID(roomID, left, right string) string {
	ids := []string{strings.TrimSpace(left), strings.TrimSpace(right)}
	sort.Strings(ids)
	return "direct:" + roomID + ":" + ids[0] + ":" + ids[1]
}

func roomMemberID(roomID, userID string) string {
	return roomID + ":" + userID
}

func dropSQLiteIndexes(db *gorm.DB, tableName string) error {
	rows, err := db.Raw(`
SELECT name
FROM sqlite_master
WHERE type = 'index'
  AND tbl_name = ?
  AND sql IS NOT NULL`, tableName).Rows()
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		if err := db.Exec(`DROP INDEX IF EXISTS ` + quoteSQLiteIdentifier(name)).Error; err != nil {
			return fmt.Errorf("drop legacy index %s: %w", name, err)
		}
	}
	return rows.Err()
}

func quoteSQLiteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
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
