package messages

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

var (
	ErrFileNotFound  = errors.New("file not found")
	ErrFileForbidden = errors.New("file not accessible")
	ErrConflict      = errors.New("conflict")
)

type Store struct {
	db                 *gorm.DB
	recentMessageLimit int
}

type ClearThreadOutcome struct {
	Response      protocol.ClearThreadResponse
	Event         *protocol.ThreadClearedPayload
	OrphanedFiles []protocol.RelayFileDescriptor
}

type PersistRelayFileOutcome struct {
	Created bool
	Message protocol.ChatMessage
}

func NewStore(db *gorm.DB, recentMessageLimit int) *Store {
	if recentMessageLimit <= 0 {
		recentMessageLimit = 60
	}
	return &Store{db: db, recentMessageLimit: recentMessageLimit}
}

func (s *Store) DB() *gorm.DB {
	return s.db
}

func (s *Store) ListVisibleMessages(ctx context.Context, roomID, clientID string) ([]protocol.ChatMessage, error) {
	var rows []repository.MessageRecord
	err := s.db.WithContext(ctx).
		Where("room_id = ? AND (target_id IS NULL OR from_id = ? OR target_id = ?)", roomID, clientID, clientID).
		Order("created_at DESC, id DESC").
		Limit(s.recentMessageLimit).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return s.inflateMessages(ctx, s.db.WithContext(ctx), rows)
}

func (s *Store) PersistTextMessage(ctx context.Context, roomID, fromID, fromName string, targetID *string, text string) (protocol.ChatMessage, error) {
	normalizedTarget := NormalizeTargetID(fromID, targetID)
	message := protocol.ChatMessage{
		ID:        uuid.NewString(),
		RoomID:    roomID,
		Kind:      protocol.MessageKindText,
		FromID:    fromID,
		FromName:  fromName,
		TargetID:  normalizedTarget,
		CreatedAt: util.NowMS(),
		Transport: protocol.MessageTransportServerSync,
		Text:      &text,
	}
	row := repository.MessageRecord{
		ID:        message.ID,
		RoomID:    message.RoomID,
		ThreadKey: BuildThreadKey(fromID, normalizedTarget),
		FromID:    message.FromID,
		FromName:  message.FromName,
		TargetID:  normalizedTarget,
		Kind:      string(message.Kind),
		CreatedAt: int64(message.CreatedAt),
		Transport: string(message.Transport),
		Text:      message.Text,
	}
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return protocol.ChatMessage{}, err
	}
	return message, nil
}

func (s *Store) FindRelayUploadRequest(ctx context.Context, fromID, requestID string) (*repository.RelayUploadRequestRecord, error) {
	var row repository.RelayUploadRequestRecord
	err := s.db.WithContext(ctx).
		Where("from_id = ? AND request_id = ?", fromID, requestID).
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (s *Store) StoreRelayUploadRequest(ctx context.Context, record repository.RelayUploadRequestRecord) (*repository.RelayUploadRequestRecord, bool, error) {
	result := s.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&record)
	if result.Error != nil {
		return nil, false, result.Error
	}
	if result.RowsAffected > 0 {
		return nil, true, nil
	}
	existing, err := s.FindRelayUploadRequest(ctx, record.FromID, record.RequestID)
	if err != nil {
		return nil, false, err
	}
	if existing == nil {
		return nil, false, fmt.Errorf("relay upload request conflicted but could not be reloaded")
	}
	return existing, false, nil
}

func (s *Store) StoreRelayUploadPart(ctx context.Context, fileID string, part protocol.RelayUploadedPart) error {
	row := repository.RelayUploadPart{
		FileID:     fileID,
		PartNumber: part.PartNumber,
		Etag:       trimQuotes(part.Etag),
		CreatedAt:  int64(util.NowMS()),
	}
	return s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "file_id"}, {Name: "part_number"}},
			DoUpdates: clause.AssignmentColumns([]string{"etag", "created_at"}),
		}).
		Create(&row).Error
}

func (s *Store) ListRelayUploadParts(ctx context.Context, fileID string) ([]protocol.RelayUploadedPart, error) {
	var rows []repository.RelayUploadPart
	if err := s.db.WithContext(ctx).Where("file_id = ?", fileID).Order("part_number ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]protocol.RelayUploadedPart, 0, len(rows))
	for _, row := range rows {
		out = append(out, protocol.RelayUploadedPart{PartNumber: row.PartNumber, Etag: row.Etag})
	}
	return out, nil
}

func (s *Store) StoreCompletedRelayUpload(ctx context.Context, upload repository.PendingRelayUpload) (*repository.PendingRelayUpload, bool, error) {
	result := s.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&upload)
	if result.Error != nil {
		return nil, false, result.Error
	}
	if result.RowsAffected > 0 {
		return nil, true, nil
	}
	existing, err := s.FindPendingRelayUpload(ctx, upload.FileID)
	if err != nil {
		return nil, false, err
	}
	if existing == nil {
		return nil, false, fmt.Errorf("pending relay upload conflicted but could not be reloaded")
	}
	return existing, false, nil
}

func (s *Store) FindPendingRelayUpload(ctx context.Context, fileID string) (*repository.PendingRelayUpload, error) {
	var row repository.PendingRelayUpload
	err := s.db.WithContext(ctx).Where("file_id = ?", fileID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (s *Store) RemovePendingRelayUpload(ctx context.Context, fileID string) (bool, error) {
	result := s.db.WithContext(ctx).Where("file_id = ?", fileID).Delete(&repository.PendingRelayUpload{})
	return result.RowsAffected > 0, result.Error
}

func (s *Store) RemoveRelayUploadRequestByFileID(ctx context.Context, fileID string) (bool, error) {
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("file_id = ?", fileID).Delete(&repository.RelayUploadPart{}).Error; err != nil {
			return err
		}
		return tx.Where("file_id = ?", fileID).Delete(&repository.RelayUploadRequestRecord{}).Error
	})
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) PersistConfirmedRelayFileMessage(
	ctx context.Context,
	roomID, fromID, fromName string,
	targetID *string,
	file protocol.RelayFileAnnouncement,
) (PersistRelayFileOutcome, error) {
	var outcome PersistRelayFileOutcome
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var pending repository.PendingRelayUpload
		err := tx.Where("file_id = ?", file.FileID).First(&pending).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			existing, err := loadExistingRelayMessageByFileID(tx, roomID, file.FileID)
			if err != nil {
				return err
			}
			if existing == nil {
				return fmt.Errorf("relay file upload is not ready to announce")
			}
			if err := validateExistingRelayMessage(roomID, fromID, *existing, file); err != nil {
				return err
			}
			outcome = PersistRelayFileOutcome{Created: false, Message: *existing}
			return nil
		}
		if err != nil {
			return err
		}
		if err := validatePendingRelayUpload(roomID, fromID, pending, file); err != nil {
			return err
		}

		normalizedTarget := NormalizeTargetID(fromID, targetID)
		createdAt := util.NowMS()
		descriptor := protocol.RelayFileDescriptor{
			FileID:      pending.FileID,
			FileName:    pending.FileName,
			Size:        uint64(pending.Size),
			ContentType: pending.ContentType,
			ObjectKey:   pending.ObjectKey,
			FromID:      fromID,
			FromName:    fromName,
			CreatedAt:   createdAt,
			TargetID:    normalizedTarget,
			Previewable: protocol.IsPreviewableImage(pending.ContentType),
		}
		message := protocol.ChatMessage{
			ID:        uuid.NewString(),
			RoomID:    roomID,
			Kind:      protocol.MessageKindRelayFile,
			FromID:    fromID,
			FromName:  fromName,
			TargetID:  normalizedTarget,
			CreatedAt: createdAt,
			Transport: protocol.MessageTransportServerRelay,
			File:      &descriptor,
		}
		threadKey := BuildThreadKey(fromID, normalizedTarget)
		if err := tx.Create(&repository.RelayFileRecord{
			FileID:      descriptor.FileID,
			RoomID:      roomID,
			ThreadKey:   threadKey,
			FromID:      descriptor.FromID,
			FromName:    descriptor.FromName,
			TargetID:    descriptor.TargetID,
			FileName:    descriptor.FileName,
			Size:        int64(descriptor.Size),
			ContentType: descriptor.ContentType,
			ObjectKey:   descriptor.ObjectKey,
			CreatedAt:   int64(descriptor.CreatedAt),
			Previewable: descriptor.Previewable,
		}).Error; err != nil {
			return err
		}
		if err := tx.Create(&repository.MessageRecord{
			ID:          message.ID,
			RoomID:      roomID,
			ThreadKey:   threadKey,
			FromID:      message.FromID,
			FromName:    message.FromName,
			TargetID:    message.TargetID,
			Kind:        string(message.Kind),
			CreatedAt:   int64(message.CreatedAt),
			Transport:   string(message.Transport),
			RelayFileID: &descriptor.FileID,
		}).Error; err != nil {
			return err
		}
		if err := tx.Where("file_id = ?", pending.FileID).Delete(&repository.PendingRelayUpload{}).Error; err != nil {
			return err
		}
		if err := tx.Where("file_id = ?", pending.FileID).Delete(&repository.RelayUploadPart{}).Error; err != nil {
			return err
		}
		if err := tx.Where("file_id = ?", pending.FileID).Delete(&repository.RelayUploadRequestRecord{}).Error; err != nil {
			return err
		}
		outcome = PersistRelayFileOutcome{Created: true, Message: message}
		return nil
	})
	return outcome, err
}

func (s *Store) ClearThread(ctx context.Context, roomID, actorID, actorName string, targetID *string) (ClearThreadOutcome, error) {
	normalizedTarget := NormalizeTargetID(actorID, targetID)
	threadKey := BuildThreadKey(actorID, normalizedTarget)
	var removedRows []repository.MessageRecord
	var orphaned []protocol.RelayFileDescriptor

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("room_id = ? AND thread_key = ?", roomID, threadKey).Find(&removedRows).Error; err != nil {
			return err
		}
		if err := tx.Where("room_id = ? AND thread_key = ?", roomID, threadKey).Delete(&repository.MessageRecord{}).Error; err != nil {
			return err
		}
		files, err := collectOrphanedFiles(tx, roomID, removedRows)
		if err != nil {
			return err
		}
		orphaned = files
		return nil
	})
	if err != nil {
		return ClearThreadOutcome{}, err
	}

	response := protocol.ClearThreadResponse{
		TargetID:          normalizedTarget,
		RemovedMessages:   len(removedRows),
		RemovedRelayFiles: len(orphaned),
	}
	var event *protocol.ThreadClearedPayload
	if len(removedRows) > 0 {
		event = &protocol.ThreadClearedPayload{
			TargetID:          response.TargetID,
			ActorID:           actorID,
			ActorName:         actorName,
			RemovedMessages:   response.RemovedMessages,
			RemovedRelayFiles: response.RemovedRelayFiles,
		}
	}
	return ClearThreadOutcome{Response: response, Event: event, OrphanedFiles: orphaned}, nil
}

func (s *Store) LookupFileForClient(ctx context.Context, roomID, fileID, clientID string) (protocol.RelayFileDescriptor, error) {
	var row repository.RelayFileRecord
	err := s.db.WithContext(ctx).Where("file_id = ? AND room_id = ?", fileID, roomID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return protocol.RelayFileDescriptor{}, ErrFileNotFound
	}
	if err != nil {
		return protocol.RelayFileDescriptor{}, err
	}
	descriptor := relayFileRecordToDescriptor(row)
	if descriptor.TargetID != nil && descriptor.FromID != clientID && *descriptor.TargetID != clientID {
		return protocol.RelayFileDescriptor{}, ErrFileForbidden
	}
	return descriptor, nil
}

func (s *Store) inflateMessages(ctx context.Context, db *gorm.DB, rows []repository.MessageRecord) ([]protocol.ChatMessage, error) {
	fileIDs := make([]string, 0)
	seen := map[string]struct{}{}
	for _, row := range rows {
		if row.RelayFileID != nil {
			if _, ok := seen[*row.RelayFileID]; !ok {
				seen[*row.RelayFileID] = struct{}{}
				fileIDs = append(fileIDs, *row.RelayFileID)
			}
		}
	}
	filesByID := map[string]protocol.RelayFileDescriptor{}
	if len(fileIDs) > 0 {
		var files []repository.RelayFileRecord
		if err := db.WithContext(ctx).Where("file_id IN ?", fileIDs).Find(&files).Error; err != nil {
			return nil, err
		}
		for _, file := range files {
			filesByID[file.FileID] = relayFileRecordToDescriptor(file)
		}
	}

	out := make([]protocol.ChatMessage, 0, len(rows))
	for _, row := range rows {
		message := protocol.ChatMessage{
			ID:        row.ID,
			RoomID:    row.RoomID,
			Kind:      protocol.MessageKind(row.Kind),
			FromID:    row.FromID,
			FromName:  row.FromName,
			TargetID:  row.TargetID,
			CreatedAt: uint64(row.CreatedAt),
			Transport: protocol.MessageTransport(row.Transport),
			Text:      row.Text,
		}
		if row.RelayFileID != nil {
			if file, ok := filesByID[*row.RelayFileID]; ok {
				message.File = &file
			}
		}
		out = append(out, message)
	}
	return out, nil
}

func loadExistingRelayMessageByFileID(db *gorm.DB, roomID, fileID string) (*protocol.ChatMessage, error) {
	var rows []repository.MessageRecord
	if err := db.Where("room_id = ? AND relay_file_id = ?", roomID, fileID).Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	store := Store{}
	messages, err := store.inflateMessages(context.Background(), db, rows)
	if err != nil {
		return nil, err
	}
	if len(messages) == 0 {
		return nil, nil
	}
	return &messages[0], nil
}

func collectOrphanedFiles(db *gorm.DB, roomID string, removedRows []repository.MessageRecord) ([]protocol.RelayFileDescriptor, error) {
	removedIDs := map[string]struct{}{}
	for _, row := range removedRows {
		if row.RelayFileID != nil {
			removedIDs[*row.RelayFileID] = struct{}{}
		}
	}
	if len(removedIDs) == 0 {
		return nil, nil
	}
	ids := make([]string, 0, len(removedIDs))
	for id := range removedIDs {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var stillReferenced []string
	if err := db.Model(&repository.MessageRecord{}).
		Where("room_id = ? AND relay_file_id IN ?", roomID, ids).
		Distinct().
		Pluck("relay_file_id", &stillReferenced).Error; err != nil {
		return nil, err
	}
	referenced := map[string]struct{}{}
	for _, id := range stillReferenced {
		referenced[id] = struct{}{}
	}
	orphanIDs := make([]string, 0)
	for _, id := range ids {
		if _, ok := referenced[id]; !ok {
			orphanIDs = append(orphanIDs, id)
		}
	}
	if len(orphanIDs) == 0 {
		return nil, nil
	}
	var files []repository.RelayFileRecord
	if err := db.Where("room_id = ? AND file_id IN ?", roomID, orphanIDs).Find(&files).Error; err != nil {
		return nil, err
	}
	if err := db.Where("room_id = ? AND file_id IN ?", roomID, orphanIDs).Delete(&repository.RelayFileRecord{}).Error; err != nil {
		return nil, err
	}
	out := make([]protocol.RelayFileDescriptor, 0, len(files))
	for _, file := range files {
		out = append(out, relayFileRecordToDescriptor(file))
	}
	return out, nil
}

func relayFileRecordToDescriptor(row repository.RelayFileRecord) protocol.RelayFileDescriptor {
	return protocol.RelayFileDescriptor{
		FileID:      row.FileID,
		FileName:    row.FileName,
		Size:        uint64(row.Size),
		ContentType: row.ContentType,
		ObjectKey:   row.ObjectKey,
		FromID:      row.FromID,
		FromName:    row.FromName,
		CreatedAt:   uint64(row.CreatedAt),
		TargetID:    row.TargetID,
		Previewable: row.Previewable,
	}
}

func validatePendingRelayUpload(roomID, fromID string, pending repository.PendingRelayUpload, file protocol.RelayFileAnnouncement) error {
	if pending.FileID != file.FileID ||
		pending.RoomID != roomID ||
		pending.FromID != fromID ||
		!sameStringPtr(pending.TargetID, file.TargetID) ||
		pending.FileName != file.FileName ||
		uint64(pending.Size) != file.Size ||
		pending.ContentType != file.ContentType ||
		pending.ObjectKey != file.ObjectKey {
		return fmt.Errorf("%w: relay file announcement does not match completed upload", ErrConflict)
	}
	return nil
}

func validateExistingRelayMessage(roomID, fromID string, existing protocol.ChatMessage, file protocol.RelayFileAnnouncement) error {
	if existing.RoomID != roomID ||
		existing.FromID != fromID ||
		existing.Kind != protocol.MessageKindRelayFile ||
		existing.Transport != protocol.MessageTransportServerRelay ||
		existing.File == nil ||
		existing.File.FileID != file.FileID ||
		existing.File.FileName != file.FileName ||
		existing.File.ObjectKey != file.ObjectKey ||
		existing.File.Size != file.Size ||
		existing.File.ContentType != file.ContentType {
		return fmt.Errorf("%w: relay file announcement conflicts with existing message", ErrConflict)
	}
	return nil
}

func sameStringPtr(left, right *string) bool {
	if left == nil || *left == "" {
		return right == nil || *right == ""
	}
	return right != nil && *left == *right
}

func trimQuotes(value string) string {
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return value[1 : len(value)-1]
	}
	return value
}
