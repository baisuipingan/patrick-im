package repository

type MessageRecord struct {
	ID          string  `gorm:"primaryKey;size:191"`
	RoomID      string  `gorm:"size:191;not null;index:idx_message_room_created,priority:1;index"`
	ThreadKey   string  `gorm:"size:191;not null;index:idx_message_thread"`
	FromID      string  `gorm:"size:191;not null;index"`
	FromName    string  `gorm:"size:191;not null"`
	TargetID    *string `gorm:"size:191;index"`
	Kind        string  `gorm:"size:64;not null"`
	CreatedAt   int64   `gorm:"not null;index:idx_message_room_created,priority:2;index"`
	Transport   string  `gorm:"size:64;not null"`
	Text        *string `gorm:"type:text"`
	RelayFileID *string `gorm:"size:191;index"`
}

func (MessageRecord) TableName() string { return "message_records" }

type RelayFileRecord struct {
	FileID      string  `gorm:"primaryKey;size:191"`
	RoomID      string  `gorm:"size:191;not null;index"`
	ThreadKey   string  `gorm:"size:191;not null;index"`
	FromID      string  `gorm:"size:191;not null;index"`
	FromName    string  `gorm:"size:191;not null"`
	TargetID    *string `gorm:"size:191;index"`
	FileName    string  `gorm:"size:512;not null"`
	Size        int64   `gorm:"not null"`
	ContentType string  `gorm:"size:191;not null"`
	ObjectKey   string  `gorm:"size:512;not null"`
	CreatedAt   int64   `gorm:"not null;index"`
	Previewable bool    `gorm:"not null"`
}

func (RelayFileRecord) TableName() string { return "relay_file_records" }

type PendingRelayUpload struct {
	FileID      string  `gorm:"primaryKey;size:191"`
	RoomID      string  `gorm:"size:191;not null;index"`
	FromID      string  `gorm:"size:191;not null;index"`
	TargetID    *string `gorm:"size:191"`
	FileName    string  `gorm:"size:512;not null"`
	Size        int64   `gorm:"not null"`
	ContentType string  `gorm:"size:191;not null"`
	ObjectKey   string  `gorm:"size:512;not null"`
	CreatedAt   int64   `gorm:"not null;index"`
}

func (PendingRelayUpload) TableName() string { return "pending_relay_uploads" }

type RelayUploadRequestRecord struct {
	FromID      string  `gorm:"primaryKey;size:191"`
	RequestID   string  `gorm:"primaryKey;size:191"`
	FileID      string  `gorm:"size:191;not null;uniqueIndex"`
	RoomID      string  `gorm:"size:191;not null;index"`
	TargetID    *string `gorm:"size:191"`
	FileName    string  `gorm:"size:512;not null"`
	Size        int64   `gorm:"not null"`
	ContentType string  `gorm:"size:191;not null"`
	ObjectKey   string  `gorm:"size:512;not null"`
	UploadID    string  `gorm:"size:512;not null"`
	CreatedAt   int64   `gorm:"not null;index"`
}

func (RelayUploadRequestRecord) TableName() string { return "relay_upload_requests" }

type RelayUploadPart struct {
	FileID     string `gorm:"primaryKey;size:191"`
	PartNumber int    `gorm:"primaryKey"`
	Etag       string `gorm:"size:255;not null"`
	CreatedAt  int64  `gorm:"not null;index"`
}

func (RelayUploadPart) TableName() string { return "relay_upload_parts" }
