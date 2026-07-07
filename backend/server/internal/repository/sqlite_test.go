package repository

import (
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestOpenSQLiteMigratesLegacyMessageRecords(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "patrick-im.sqlite")
	fileRoot := filepath.Join(dir, "files")
	legacyDB, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := legacyDB.Exec(`
CREATE TABLE message_records (
	id TEXT PRIMARY KEY,
	room_id TEXT NOT NULL,
	thread_key TEXT NOT NULL,
	from_id TEXT NOT NULL,
	from_name TEXT NOT NULL,
	target_id TEXT,
	kind TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	transport TEXT NOT NULL,
	text TEXT,
	relay_file_id TEXT
)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := legacyDB.Exec(`
CREATE TABLE relay_file_records (
	file_id TEXT PRIMARY KEY,
	room_id TEXT NOT NULL,
	thread_key TEXT NOT NULL,
	from_id TEXT NOT NULL,
	from_name TEXT NOT NULL,
	target_id TEXT,
	file_name TEXT NOT NULL,
	size INTEGER NOT NULL,
	content_type TEXT NOT NULL,
	object_key TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	previewable INTEGER NOT NULL
)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := legacyDB.Exec(`
INSERT INTO message_records (
	id, room_id, thread_key, from_id, from_name, target_id, kind,
	created_at, transport, text, relay_file_id
) VALUES
	('m-text', 'room-a', '__global__', 'alice', 'Alice', NULL, 'text', 10, 'server-sync', 'hello', NULL),
	('m-file', 'room-a', 'alice:bob', 'alice', 'Alice', 'bob', 'relay-file', 20, 'server-relay', NULL, 'file-1')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := legacyDB.Exec(`
INSERT INTO relay_file_records (
	file_id, room_id, thread_key, from_id, from_name, target_id,
	file_name, size, content_type, object_key, created_at, previewable
) VALUES (
	'file-1', 'room-a', 'alice:bob', 'alice', 'Alice', 'bob',
	'hello.txt', 12, 'text/plain', 'rooms/room-a/file-1/hello.txt', 20, 0
)`).Error; err != nil {
		t.Fatal(err)
	}
	sqlDB, err := legacyDB.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := OpenSQLite(dbPath, fileRoot)
	if err != nil {
		t.Fatal(err)
	}
	var rows []MessageRecord
	if err := db.Order("created_at").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %#v", rows)
	}
	if rows[0].SenderID != "alice" || rows[0].SenderName != "Alice" || rows[0].Kind != "text" || rows[0].Text == nil || *rows[0].Text != "hello" {
		t.Fatalf("text row = %#v", rows[0])
	}
	wantPath := filepath.ToSlash(filepath.Join(fileRoot, "rooms/room-a/file-1/hello.txt"))
	if rows[1].SenderID != "alice" || rows[1].Kind != "file" || rows[1].FileID == nil || *rows[1].FileID != "file-1" {
		t.Fatalf("file row = %#v", rows[1])
	}
	if rows[1].FileName == nil || *rows[1].FileName != "hello.txt" || rows[1].FileSize != 12 {
		t.Fatalf("file metadata = %#v", rows[1])
	}
	if rows[1].StoragePath == nil || *rows[1].StoragePath != wantPath {
		t.Fatalf("storage path = %v, want %s", rows[1].StoragePath, wantPath)
	}
}
