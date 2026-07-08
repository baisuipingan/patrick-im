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

type SchemaMigrationRecord struct {
	Version   int64  `gorm:"primaryKey"`
	Name      string `gorm:"size:128;not null"`
	AppliedAt int64  `gorm:"not null"`
}

func (SchemaMigrationRecord) TableName() string { return "schema_migrations" }

type UserRecord struct {
	ID        string `gorm:"primaryKey;size:64"`
	Nickname  string `gorm:"size:64;not null"`
	CreatedAt int64  `gorm:"not null"`
	UpdatedAt int64  `gorm:"not null"`
}

func (UserRecord) TableName() string { return "users" }

type RoomRecord struct {
	ID          string `gorm:"primaryKey;size:96"`
	DisplayName string `gorm:"size:96;not null"`
	CreatedAt   int64  `gorm:"not null"`
	UpdatedAt   int64  `gorm:"not null"`
}

func (RoomRecord) TableName() string { return "rooms" }

type RoomMemberRecord struct {
	ID         string `gorm:"primaryKey;size:160"`
	RoomID     string `gorm:"size:96;not null;uniqueIndex:idx_room_members_room_user,priority:1;index"`
	UserID     string `gorm:"size:64;not null;uniqueIndex:idx_room_members_room_user,priority:2;index"`
	Nickname   string `gorm:"size:64;not null"`
	Role       string `gorm:"size:24;not null;default:member"`
	JoinedAt   int64  `gorm:"not null"`
	LastSeenAt int64  `gorm:"not null"`
}

func (RoomMemberRecord) TableName() string { return "room_members" }

type ConversationRecord struct {
	ID              string  `gorm:"primaryKey;size:192"`
	RoomID          string  `gorm:"size:96;not null;index"`
	Type            string  `gorm:"size:24;not null;index"`
	Title           string  `gorm:"size:128;not null"`
	PeerUserID      *string `gorm:"size:64;index"`
	LastMessageID   *string `gorm:"size:64"`
	LastMessageText *string `gorm:"size:512"`
	LastMessageAt   int64   `gorm:"not null;default:0;index"`
	CreatedAt       int64   `gorm:"not null"`
	UpdatedAt       int64   `gorm:"not null"`
}

func (ConversationRecord) TableName() string { return "conversations" }

type MessageV2Record struct {
	ID              string  `gorm:"primaryKey;size:64"`
	ClientMessageID *string `gorm:"size:96;uniqueIndex"`
	RoomID          string  `gorm:"size:96;not null;index"`
	ConversationID  string  `gorm:"size:192;not null;index:idx_v2_messages_conversation_created,priority:1;index"`
	SenderID        string  `gorm:"size:64;not null;index"`
	SenderName      string  `gorm:"size:64;not null"`
	TargetID        *string `gorm:"size:64;index"`
	Type            string  `gorm:"size:24;not null"`
	Text            *string `gorm:"type:text"`
	Status          string  `gorm:"size:24;not null;default:sent"`
	CreatedAt       int64   `gorm:"not null;index:idx_v2_messages_conversation_created,priority:2;index"`
}

func (MessageV2Record) TableName() string { return "messages" }

type AttachmentRecord struct {
	ID          string  `gorm:"primaryKey;size:64"`
	MessageID   string  `gorm:"size:64;not null;index"`
	FileName    string  `gorm:"size:255;not null"`
	Size        int64   `gorm:"not null"`
	ContentType string  `gorm:"size:128;not null"`
	StorageKind string  `gorm:"size:24;not null"`
	StoragePath *string `gorm:"size:1024"`
	Checksum    *string `gorm:"size:128"`
	Previewable bool    `gorm:"not null;default:false"`
	CreatedAt   int64   `gorm:"not null"`
}

func (AttachmentRecord) TableName() string { return "attachments" }

type TransferRecord struct {
	ID             string  `gorm:"primaryKey;size:64"`
	RoomID         string  `gorm:"size:96;not null;index"`
	ConversationID string  `gorm:"size:192;not null;index"`
	MessageID      *string `gorm:"size:64;index"`
	AttachmentID   *string `gorm:"size:64;index"`
	SenderID       string  `gorm:"size:64;not null;index"`
	ReceiverID     *string `gorm:"size:64;index"`
	Transport      string  `gorm:"size:24;not null"`
	Direction      string  `gorm:"size:16;not null"`
	State          string  `gorm:"size:24;not null"`
	BytesDone      int64   `gorm:"not null;default:0"`
	BytesTotal     int64   `gorm:"not null;default:0"`
	Error          *string `gorm:"size:512"`
	CreatedAt      int64   `gorm:"not null"`
	UpdatedAt      int64   `gorm:"not null"`
}

func (TransferRecord) TableName() string { return "transfers" }

type ReadStateRecord struct {
	ID                string  `gorm:"primaryKey;size:256"`
	ConversationID    string  `gorm:"size:192;not null;uniqueIndex:idx_read_states_conversation_user,priority:1;index"`
	UserID            string  `gorm:"size:64;not null;uniqueIndex:idx_read_states_conversation_user,priority:2;index"`
	LastReadAt        int64   `gorm:"not null;default:0"`
	LastReadMessageID *string `gorm:"size:64"`
	UpdatedAt         int64   `gorm:"not null"`
}

func (ReadStateRecord) TableName() string { return "read_states" }
