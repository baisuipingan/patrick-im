package chat

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

const relayChunkSizeBytes int64 = 5 * 1024 * 1024

var relayUploadMu sync.Mutex

type RelayUploadTokenPayload struct {
	FileID          string  `json:"fileId"`
	ObjectKey       string  `json:"objectKey"`
	UploadID        string  `json:"uploadId"`
	RoomID          string  `json:"roomId"`
	FileName        string  `json:"fileName"`
	ContentType     string  `json:"contentType"`
	Size            int64   `json:"size"`
	TargetID        *string `json:"targetId"`
	FromID          string  `json:"fromId"`
	ClientRequestID string  `json:"clientRequestId"`
	IssuedAt        int64   `json:"issuedAt"`
}

type relayUploadManifest struct {
	RelayUploadTokenPayload
	UploadedParts []protocol.RelayUploadedPart `json:"uploadedParts"`
	Completed     bool                         `json:"completed"`
	StoragePath   string                       `json:"storagePath"`
}

func ReadRelayUploadToken(secret, token string) (RelayUploadTokenPayload, error) {
	var payload RelayUploadTokenPayload
	if err := session.ReadSignedToken(secret, token, &payload); err != nil {
		return RelayUploadTokenPayload{}, err
	}
	if payload.FileID == "" || payload.UploadID == "" || payload.FromID == "" {
		return RelayUploadTokenPayload{}, ErrValidation
	}
	return payload, nil
}

func (s *Store) CreateOrResumeRelayUpload(
	_ context.Context,
	author session.Payload,
	secret string,
	request protocol.RelayUploadRequest,
) (protocol.RelayUploadResponse, error) {
	normalized, err := s.normalizeRelayUploadRequest(author, request)
	if err != nil {
		return protocol.RelayUploadResponse{}, err
	}

	relayUploadMu.Lock()
	defer relayUploadMu.Unlock()

	manifest, err := s.findRelayManifestByRequestLocked(author.ClientID, normalized.ClientRequestID)
	if err != nil {
		return protocol.RelayUploadResponse{}, err
	}
	if manifest != nil {
		if !sameRelayUploadRequest(*manifest, normalized) {
			return protocol.RelayUploadResponse{}, ErrValidation
		}
		return buildRelayUploadResponse(secret, *manifest)
	}

	fileID := uuid.NewString()
	normalized.FileID = fileID
	normalized.UploadID = uuid.NewString()
	normalized.ObjectKey = buildRelayObjectKey(normalized.RoomID, normalized.FileID, normalized.FileName)
	manifest = &relayUploadManifest{RelayUploadTokenPayload: normalized}
	if err := s.writeRelayManifestLocked(*manifest); err != nil {
		return protocol.RelayUploadResponse{}, err
	}
	return buildRelayUploadResponse(secret, *manifest)
}

func (s *Store) SaveRelayUploadPart(
	payload RelayUploadTokenPayload,
	partNumber int,
	body io.Reader,
) (protocol.RelayUploadedPart, error) {
	if err := validateRelayPartNumber(payload.Size, partNumber); err != nil {
		return protocol.RelayUploadedPart{}, err
	}

	relayUploadMu.Lock()
	manifest, err := s.readRelayManifestLocked(payload.FileID)
	relayUploadMu.Unlock()
	if err != nil {
		return protocol.RelayUploadedPart{}, err
	}
	if !manifestMatchesToken(manifest, payload) || manifest.Completed {
		return protocol.RelayUploadedPart{}, ErrValidation
	}

	partPath := s.relayPartPath(payload.FileID, partNumber)
	if err := os.MkdirAll(filepath.Dir(partPath), 0o755); err != nil {
		return protocol.RelayUploadedPart{}, err
	}
	tmpPath := partPath + ".uploading"
	dst, err := os.Create(tmpPath)
	if err != nil {
		return protocol.RelayUploadedPart{}, err
	}
	hasher := sha256.New()
	written, copyErr := copyHashLimited(dst, hasher, body, relayChunkSizeBytes+1)
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return protocol.RelayUploadedPart{}, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return protocol.RelayUploadedPart{}, closeErr
	}
	if written <= 0 || written > relayChunkSizeBytes {
		_ = os.Remove(tmpPath)
		return protocol.RelayUploadedPart{}, ErrValidation
	}
	if err := os.Rename(tmpPath, partPath); err != nil {
		_ = os.Remove(tmpPath)
		return protocol.RelayUploadedPart{}, err
	}

	part := protocol.RelayUploadedPart{PartNumber: partNumber, ETag: hex.EncodeToString(hasher.Sum(nil))}
	relayUploadMu.Lock()
	defer relayUploadMu.Unlock()
	manifest, err = s.readRelayManifestLocked(payload.FileID)
	if err != nil {
		return protocol.RelayUploadedPart{}, err
	}
	if !manifestMatchesToken(manifest, payload) || manifest.Completed {
		return protocol.RelayUploadedPart{}, ErrValidation
	}
	upsertRelayPart(&manifest, part)
	if err := s.writeRelayManifestLocked(manifest); err != nil {
		return protocol.RelayUploadedPart{}, err
	}
	return part, nil
}

func (s *Store) AckRelayUploadPart(payload RelayUploadTokenPayload, part protocol.RelayUploadedPart) error {
	if err := validateRelayPartNumber(payload.Size, part.PartNumber); err != nil {
		return err
	}
	if strings.TrimSpace(part.ETag) == "" {
		return ErrValidation
	}
	relayUploadMu.Lock()
	defer relayUploadMu.Unlock()
	manifest, err := s.readRelayManifestLocked(payload.FileID)
	if err != nil {
		return err
	}
	if !manifestMatchesToken(manifest, payload) || manifest.Completed {
		return ErrValidation
	}
	partPath := s.relayPartPath(payload.FileID, part.PartNumber)
	if _, err := os.Stat(partPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	upsertRelayPart(&manifest, part)
	return s.writeRelayManifestLocked(manifest)
}

func (s *Store) CompleteRelayUpload(
	payload RelayUploadTokenPayload,
	parts []protocol.RelayUploadedPart,
) (protocol.RelayCompleteUploadResponse, error) {
	relayUploadMu.Lock()
	defer relayUploadMu.Unlock()

	manifest, err := s.readRelayManifestLocked(payload.FileID)
	if err != nil {
		return protocol.RelayCompleteUploadResponse{}, err
	}
	if !manifestMatchesToken(manifest, payload) {
		return protocol.RelayCompleteUploadResponse{}, ErrValidation
	}
	if manifest.Completed {
		return protocol.RelayCompleteUploadResponse{FileID: manifest.FileID, ObjectKey: manifest.ObjectKey}, nil
	}
	if len(parts) == 0 {
		parts = manifest.UploadedParts
	}
	if err := validateRelayCompletionParts(payload.Size, parts); err != nil {
		return protocol.RelayCompleteUploadResponse{}, err
	}
	if err := s.ensureRelayPartsExistLocked(payload, parts); err != nil {
		return protocol.RelayCompleteUploadResponse{}, err
	}

	storagePath, err := s.storagePath(payload.RoomID, payload.FileID, payload.FileName)
	if err != nil {
		return protocol.RelayCompleteUploadResponse{}, err
	}
	if err := os.MkdirAll(filepath.Dir(storagePath), 0o755); err != nil {
		return protocol.RelayCompleteUploadResponse{}, err
	}
	tmpPath := storagePath + ".uploading"
	dst, err := os.Create(tmpPath)
	if err != nil {
		return protocol.RelayCompleteUploadResponse{}, err
	}
	for partNumber := 1; partNumber <= relayPartCount(payload.Size); partNumber++ {
		if err := appendRelayPart(dst, s.relayPartPath(payload.FileID, partNumber)); err != nil {
			_ = dst.Close()
			_ = os.Remove(tmpPath)
			return protocol.RelayCompleteUploadResponse{}, err
		}
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return protocol.RelayCompleteUploadResponse{}, err
	}
	if err := os.Rename(tmpPath, storagePath); err != nil {
		_ = os.Remove(tmpPath)
		return protocol.RelayCompleteUploadResponse{}, err
	}
	manifest.Completed = true
	manifest.StoragePath = storagePath
	if err := s.writeRelayManifestLocked(manifest); err != nil {
		return protocol.RelayCompleteUploadResponse{}, err
	}
	return protocol.RelayCompleteUploadResponse{FileID: payload.FileID, ObjectKey: payload.ObjectKey}, nil
}

func (s *Store) AbortRelayUpload(payload RelayUploadTokenPayload, discardCompleted bool) error {
	relayUploadMu.Lock()
	defer relayUploadMu.Unlock()

	manifest, err := s.readRelayManifestLocked(payload.FileID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	if err == nil && !manifestMatchesToken(manifest, payload) {
		return ErrValidation
	}
	if err == nil && discardCompleted && manifest.StoragePath != "" {
		_ = os.Remove(manifest.StoragePath)
	}
	return os.RemoveAll(s.relayUploadDir(payload.FileID))
}

func (s *Store) CreateRelayFileMessage(
	ctx context.Context,
	roomID string,
	author session.Payload,
	file protocol.RelayFileAnnouncement,
) (protocol.Message, bool, error) {
	fileID := strings.TrimSpace(file.FileID)
	if fileID == "" || file.Size <= 0 || file.Size > s.uploadLimit {
		return protocol.Message{}, false, ErrValidation
	}
	relayUploadMu.Lock()
	manifest, manifestErr := s.readRelayManifestLocked(fileID)
	relayUploadMu.Unlock()
	if manifestErr != nil && !errors.Is(manifestErr, ErrNotFound) {
		return protocol.Message{}, false, manifestErr
	}

	var existing repository.MessageRecord
	err := s.db.WithContext(ctx).Where("file_id = ?", fileID).First(&existing).Error
	if err == nil {
		return recordToMessage(existing), true, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return protocol.Message{}, false, err
	}

	roomID = util.SanitizeRoomID(roomID)
	fileName := util.SanitizeFileName(file.FileName)
	contentType := strings.TrimSpace(file.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	storagePath := ""
	createdAt := util.NowMillisInt64()
	if manifestErr == nil {
		if manifest.FromID != author.ClientID || manifest.RoomID != roomID || !manifest.Completed || manifest.StoragePath == "" {
			return protocol.Message{}, false, ErrValidation
		}
		storagePath = manifest.StoragePath
		fileName = manifest.FileName
		contentType = manifest.ContentType
		createdAt = manifest.IssuedAt
	} else {
		var pathErr error
		storagePath, pathErr = s.storagePath(roomID, fileID, fileName)
		if pathErr != nil {
			return protocol.Message{}, false, pathErr
		}
	}
	if _, err := os.Stat(storagePath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return protocol.Message{}, false, ErrNotFound
		}
		return protocol.Message{}, false, err
	}
	targetID := normalizeTargetID(author.ClientID, file.TargetID)
	row := repository.MessageRecord{
		ID:          uuid.NewString(),
		RoomID:      roomID,
		SenderID:    author.ClientID,
		SenderName:  author.Nickname,
		TargetID:    targetID,
		Kind:        string(protocol.MessageKindFile),
		FileID:      &fileID,
		FileName:    &fileName,
		FileSize:    file.Size,
		ContentType: &contentType,
		StoragePath: &storagePath,
		CreatedAt:   createdAt,
	}
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return protocol.Message{}, false, err
	}
	return recordToMessage(row), false, nil
}

func (s *Store) normalizeRelayUploadRequest(author session.Payload, request protocol.RelayUploadRequest) (RelayUploadTokenPayload, error) {
	roomID := util.SanitizeRoomID(request.RoomID)
	fileName := util.SanitizeFileName(request.FileName)
	contentType := strings.TrimSpace(request.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if request.Size <= 0 || request.Size > s.uploadLimit {
		return RelayUploadTokenPayload{}, ErrValidation
	}
	clientRequestID := ""
	if request.ClientRequestID != nil {
		clientRequestID = strings.TrimSpace(*request.ClientRequestID)
	}
	if clientRequestID == "" {
		clientRequestID = uuid.NewString()
	}
	return RelayUploadTokenPayload{
		RoomID:          roomID,
		FileName:        fileName,
		ContentType:     contentType,
		Size:            request.Size,
		TargetID:        normalizeTargetID(author.ClientID, request.TargetID),
		FromID:          author.ClientID,
		ClientRequestID: clientRequestID,
		IssuedAt:        util.NowMillisInt64(),
	}, nil
}

func (s *Store) relayUploadsRoot() string {
	return filepath.Join(s.fileRoot, ".uploads")
}

func (s *Store) relayUploadDir(fileID string) string {
	return filepath.Join(s.relayUploadsRoot(), util.SanitizeFileName(fileID))
}

func (s *Store) relayManifestPath(fileID string) string {
	return filepath.Join(s.relayUploadDir(fileID), "manifest.json")
}

func (s *Store) relayPartPath(fileID string, partNumber int) string {
	return filepath.Join(s.relayUploadDir(fileID), "parts", fmt.Sprintf("%06d.part", partNumber))
}

func (s *Store) findRelayManifestByRequestLocked(clientID, clientRequestID string) (*relayUploadManifest, error) {
	pattern := filepath.Join(s.relayUploadsRoot(), "*", "manifest.json")
	paths, err := filepath.Glob(pattern)
	if err != nil {
		return nil, err
	}
	for _, path := range paths {
		manifest, err := readRelayManifestFile(path)
		if err != nil {
			continue
		}
		if manifest.FromID == clientID && manifest.ClientRequestID == clientRequestID {
			return &manifest, nil
		}
	}
	return nil, nil
}

func (s *Store) readRelayManifestLocked(fileID string) (relayUploadManifest, error) {
	path := s.relayManifestPath(fileID)
	manifest, err := readRelayManifestFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return relayUploadManifest{}, ErrNotFound
	}
	return manifest, err
}

func (s *Store) writeRelayManifestLocked(manifest relayUploadManifest) error {
	path := s.relayManifestPath(manifest.FileID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func readRelayManifestFile(path string) (relayUploadManifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return relayUploadManifest{}, err
	}
	var manifest relayUploadManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return relayUploadManifest{}, err
	}
	return manifest, nil
}

func buildRelayUploadResponse(secret string, manifest relayUploadManifest) (protocol.RelayUploadResponse, error) {
	token, err := session.CreateSignedToken(secret, manifest.RelayUploadTokenPayload)
	if err != nil {
		return protocol.RelayUploadResponse{}, err
	}
	partCount := relayPartCount(manifest.Size)
	partURLs := make([]protocol.RelayPresignedPart, 0, partCount)
	for partNumber := 1; partNumber <= partCount; partNumber++ {
		partURLs = append(partURLs, protocol.RelayPresignedPart{
			PartNumber: partNumber,
			URL:        fmt.Sprintf("/api/relay/upload-part-data?uploadToken=%s&partNumber=%d", token, partNumber),
			Headers:    []protocol.RelayPresignedHeader{},
		})
	}
	sort.Slice(manifest.UploadedParts, func(i, j int) bool {
		return manifest.UploadedParts[i].PartNumber < manifest.UploadedParts[j].PartNumber
	})
	return protocol.RelayUploadResponse{
		FileID:         manifest.FileID,
		ObjectKey:      manifest.ObjectKey,
		UploadToken:    token,
		ChunkSizeBytes: relayChunkSizeBytes,
		UploadedParts:  manifest.UploadedParts,
		PartURLs:       partURLs,
	}, nil
}

func buildRelayObjectKey(roomID, fileID, fileName string) string {
	return filepath.ToSlash(filepath.Join(roomID, fileID+"-"+fileName))
}

func sameRelayUploadRequest(manifest relayUploadManifest, request RelayUploadTokenPayload) bool {
	return manifest.FromID == request.FromID &&
		manifest.ClientRequestID == request.ClientRequestID &&
		manifest.RoomID == request.RoomID &&
		manifest.FileName == request.FileName &&
		manifest.ContentType == request.ContentType &&
		manifest.Size == request.Size &&
		sameOptionalString(manifest.TargetID, request.TargetID)
}

func manifestMatchesToken(manifest relayUploadManifest, payload RelayUploadTokenPayload) bool {
	return manifest.FileID == payload.FileID &&
		manifest.UploadID == payload.UploadID &&
		manifest.ObjectKey == payload.ObjectKey &&
		manifest.FromID == payload.FromID
}

func sameOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func relayPartCount(size int64) int {
	if size <= 0 {
		return 0
	}
	return int((size + relayChunkSizeBytes - 1) / relayChunkSizeBytes)
}

func validateRelayPartNumber(size int64, partNumber int) error {
	if partNumber <= 0 || partNumber > relayPartCount(size) {
		return ErrValidation
	}
	return nil
}

func validateRelayCompletionParts(size int64, parts []protocol.RelayUploadedPart) error {
	partCount := relayPartCount(size)
	if len(parts) != partCount {
		return ErrValidation
	}
	seen := map[int]bool{}
	for _, part := range parts {
		if err := validateRelayPartNumber(size, part.PartNumber); err != nil {
			return err
		}
		if seen[part.PartNumber] || strings.TrimSpace(part.ETag) == "" {
			return ErrValidation
		}
		seen[part.PartNumber] = true
	}
	return nil
}

func (s *Store) ensureRelayPartsExistLocked(payload RelayUploadTokenPayload, parts []protocol.RelayUploadedPart) error {
	for _, part := range parts {
		path := s.relayPartPath(payload.FileID, part.PartNumber)
		info, err := os.Stat(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return ErrNotFound
			}
			return err
		}
		if info.Size() <= 0 || info.Size() > relayChunkSizeBytes {
			return ErrValidation
		}
	}
	return nil
}

func upsertRelayPart(manifest *relayUploadManifest, part protocol.RelayUploadedPart) {
	for index, existing := range manifest.UploadedParts {
		if existing.PartNumber == part.PartNumber {
			manifest.UploadedParts[index] = part
			sort.Slice(manifest.UploadedParts, func(i, j int) bool {
				return manifest.UploadedParts[i].PartNumber < manifest.UploadedParts[j].PartNumber
			})
			return
		}
	}
	manifest.UploadedParts = append(manifest.UploadedParts, part)
	sort.Slice(manifest.UploadedParts, func(i, j int) bool {
		return manifest.UploadedParts[i].PartNumber < manifest.UploadedParts[j].PartNumber
	})
}

func copyHashLimited(dst io.Writer, hasher hash.Hash, src io.Reader, limit int64) (int64, error) {
	return io.Copy(io.MultiWriter(dst, hasher), io.LimitReader(src, limit))
}

func appendRelayPart(dst io.Writer, path string) error {
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	defer src.Close()
	_, err = io.Copy(dst, src)
	return err
}
