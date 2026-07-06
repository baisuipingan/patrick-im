package repository

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func OpenSQLite(path string) (*gorm.DB, error) {
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
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
	} {
		if err := db.Exec(pragma).Error; err != nil {
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}
	if err := db.AutoMigrate(
		&MessageRecord{},
		&RelayFileRecord{},
		&PendingRelayUpload{},
		&RelayUploadRequestRecord{},
		&RelayUploadPart{},
	); err != nil {
		return nil, err
	}
	return db, nil
}

func configureSQLitePool(db *sql.DB) {
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
}
