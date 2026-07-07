package chat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

const MaxTextBytes = 64 * 1024

var (
	ErrNotFound   = errors.New("not found")
	ErrForbidden  = errors.New("forbidden")
	ErrValidation = errors.New("validation")
)

type Store struct {
	db          *gorm.DB
	fileRoot    string
	uploadLimit int64
}

type FileObject struct {
	Message     protocol.Message
	Path        string
	ContentType string
	FileName    string
	Size        int64
	Previewable bool
}

func NewStore(db *gorm.DB, fileRoot string, uploadLimit int64) (*Store, error) {
	if uploadLimit <= 0 {
		uploadLimit = 256 * 1024 * 1024
	}
	if err := os.MkdirAll(fileRoot, 0o755); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(fileRoot)
	if err != nil {
		return nil, err
	}
	return &Store{db: db, fileRoot: abs, uploadLimit: uploadLimit}, nil
}

func (s *Store) ListMessages(ctx context.Context, roomID, viewerID string, limit int, before int64) ([]protocol.Message, error) {
	if limit <= 0 || limit > 200 {
		limit = 80
	}
	var rows []repository.MessageRecord
	query := s.db.WithContext(ctx).
		Where("room_id = ? AND (target_id IS NULL OR sender_id = ? OR target_id = ?)", roomID, viewerID, viewerID)
	if before > 0 {
		query = query.Where("created_at < ?", before)
	}
	if err := query.Order("created_at DESC, id DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	reverse(rows)
	messages := make([]protocol.Message, 0, len(rows))
	for _, row := range rows {
		messages = append(messages, recordToMessage(row))
	}
	return messages, nil
}

func (s *Store) CreateTextMessage(ctx context.Context, roomID string, author session.Payload, text string, targetID *string) (protocol.Message, error) {
	text = strings.TrimSpace(text)
	if text == "" || len([]byte(text)) > MaxTextBytes {
		return protocol.Message{}, ErrValidation
	}
	targetID = normalizeTargetID(author.ClientID, targetID)
	now := util.NowMillisInt64()
	row := repository.MessageRecord{
		ID:         uuid.NewString(),
		RoomID:     roomID,
		SenderID:   author.ClientID,
		SenderName: author.Nickname,
		TargetID:   targetID,
		Kind:       string(protocol.MessageKindText),
		Text:       &text,
		CreatedAt:  now,
	}
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return protocol.Message{}, err
	}
	if err := s.mirrorMessageRecord(ctx, row); err != nil {
		return protocol.Message{}, err
	}
	return recordToMessage(row), nil
}

func (s *Store) CreateFileMessage(ctx context.Context, roomID string, author session.Payload, header *multipart.FileHeader, targetID *string) (protocol.Message, error) {
	if header == nil || header.Size <= 0 || header.Size > s.uploadLimit {
		return protocol.Message{}, ErrValidation
	}
	targetID = normalizeTargetID(author.ClientID, targetID)
	fileID := uuid.NewString()
	fileName := util.SanitizeFileName(header.Filename)
	contentType := strings.TrimSpace(header.Header.Get("content-type"))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	storagePath, err := s.storagePath(roomID, fileID, fileName)
	if err != nil {
		return protocol.Message{}, err
	}
	if err := os.MkdirAll(filepath.Dir(storagePath), 0o755); err != nil {
		return protocol.Message{}, err
	}
	if err := copyUpload(header, storagePath, s.uploadLimit); err != nil {
		_ = os.Remove(storagePath)
		return protocol.Message{}, err
	}
	now := util.NowMillisInt64()
	row := repository.MessageRecord{
		ID:          uuid.NewString(),
		RoomID:      roomID,
		SenderID:    author.ClientID,
		SenderName:  author.Nickname,
		TargetID:    targetID,
		Kind:        string(protocol.MessageKindFile),
		FileID:      &fileID,
		FileName:    &fileName,
		FileSize:    header.Size,
		ContentType: &contentType,
		StoragePath: &storagePath,
		CreatedAt:   now,
	}
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		_ = os.Remove(storagePath)
		return protocol.Message{}, err
	}
	if err := s.mirrorMessageRecord(ctx, row); err != nil {
		_ = os.Remove(storagePath)
		return protocol.Message{}, err
	}
	return recordToMessage(row), nil
}

func (s *Store) FileForClient(ctx context.Context, fileID, clientID string) (FileObject, error) {
	var row repository.MessageRecord
	err := s.db.WithContext(ctx).Where("file_id = ?", fileID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return FileObject{}, ErrNotFound
	}
	if err != nil {
		return FileObject{}, err
	}
	if row.TargetID != nil && row.SenderID != clientID && *row.TargetID != clientID {
		return FileObject{}, ErrForbidden
	}
	message := recordToMessage(row)
	if message.File == nil || row.StoragePath == nil || row.FileName == nil || row.ContentType == nil {
		return FileObject{}, ErrNotFound
	}
	return FileObject{
		Message:     message,
		Path:        *row.StoragePath,
		ContentType: *row.ContentType,
		FileName:    *row.FileName,
		Size:        row.FileSize,
		Previewable: message.File.Previewable,
	}, nil
}

func (s *Store) ClearThread(ctx context.Context, roomID string, actor session.Payload, targetID *string) (protocol.ClearMessagesResponse, []string, error) {
	targetID = normalizeTargetID(actor.ClientID, targetID)
	var rows []repository.MessageRecord
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		query := tx.Where("room_id = ?", roomID)
		if targetID == nil {
			query = query.Where("target_id IS NULL")
		} else {
			query = query.Where(
				"((sender_id = ? AND target_id = ?) OR (sender_id = ? AND target_id = ?))",
				actor.ClientID,
				*targetID,
				*targetID,
				actor.ClientID,
			)
		}
		if err := query.Find(&rows).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		ids := make([]string, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.ID)
		}
		if err := tx.Where("id IN ?", ids).Delete(&repository.MessageRecord{}).Error; err != nil {
			return err
		}
		if err := tx.Where("message_id IN ?", ids).Delete(&repository.AttachmentRecord{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", ids).Delete(&repository.MessageV2Record{}).Error
	})
	if err != nil {
		return protocol.ClearMessagesResponse{}, nil, err
	}
	paths := make([]string, 0)
	for _, row := range rows {
		if row.StoragePath != nil {
			paths = append(paths, *row.StoragePath)
		}
	}
	return protocol.ClearMessagesResponse{TargetID: targetID, Removed: len(rows)}, paths, nil
}

func (s *Store) DeleteFiles(paths []string) {
	for _, path := range paths {
		_ = os.Remove(path)
	}
}

func RecipientsFor(message protocol.Message) []string {
	if message.TargetID == nil {
		return nil
	}
	return []string{message.SenderID, *message.TargetID}
}

func ClearRecipients(actorID string, targetID *string) []string {
	if targetID == nil {
		return nil
	}
	return []string{actorID, *targetID}
}

func normalizeTargetID(senderID string, targetID *string) *string {
	if targetID == nil {
		return nil
	}
	value := strings.TrimSpace(*targetID)
	if value == "" || value == senderID {
		return nil
	}
	return &value
}

func recordToMessage(row repository.MessageRecord) protocol.Message {
	message := protocol.Message{
		ID:         row.ID,
		RoomID:     row.RoomID,
		Kind:       protocol.MessageKind(row.Kind),
		SenderID:   row.SenderID,
		SenderName: row.SenderName,
		TargetID:   row.TargetID,
		Text:       row.Text,
		CreatedAt:  row.CreatedAt,
	}
	if row.FileID != nil && row.FileName != nil && row.ContentType != nil {
		message.File = &protocol.FileInfo{
			ID:          *row.FileID,
			FileName:    *row.FileName,
			Size:        row.FileSize,
			ContentType: *row.ContentType,
			URL:         "/api/files/" + *row.FileID,
			Previewable: util.IsImageContentType(*row.ContentType),
		}
	}
	return message
}

func reverse(rows []repository.MessageRecord) {
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
}

func (s *Store) storagePath(roomID, fileID, fileName string) (string, error) {
	path := filepath.Join(s.fileRoot, util.SanitizeRoomID(roomID), fileID+"-"+fileName)
	clean := filepath.Clean(path)
	if !strings.HasPrefix(clean, s.fileRoot+string(os.PathSeparator)) {
		return "", fmt.Errorf("file path escapes storage root")
	}
	return clean, nil
}

func copyUpload(header *multipart.FileHeader, path string, limit int64) error {
	src, err := header.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	tmp := path + ".uploading"
	dst, err := os.Create(tmp)
	if err != nil {
		return err
	}
	written, copyErr := io.Copy(dst, io.LimitReader(src, limit+1))
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	if written > limit {
		_ = os.Remove(tmp)
		return ErrValidation
	}
	return os.Rename(tmp, path)
}
