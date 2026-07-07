package repository

type MessageRecord struct {
	ID          string  `gorm:"primaryKey;size:64"`
	RoomID      string  `gorm:"size:96;not null;index:idx_messages_room_created,priority:1;index"`
	SenderID    string  `gorm:"size:64;not null;index"`
	SenderName  string  `gorm:"size:64;not null"`
	TargetID    *string `gorm:"size:64;index"`
	Kind        string  `gorm:"size:16;not null"`
	Text        *string `gorm:"type:text"`
	FileID      *string `gorm:"size:64;uniqueIndex"`
	FileName    *string `gorm:"size:255"`
	FileSize    int64   `gorm:"not null;default:0"`
	ContentType *string `gorm:"size:128"`
	StoragePath *string `gorm:"size:1024"`
	CreatedAt   int64   `gorm:"not null;index:idx_messages_room_created,priority:2;index"`
}

func (MessageRecord) TableName() string { return "message_records" }
