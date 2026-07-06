package relay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

const (
	FileLimitBytes = 5 * 1024 * 1024 * 1024
	ChunkSizeBytes = 5 * 1024 * 1024
)

type UploadTokenPayload struct {
	FileID      string  `json:"fileId"`
	ObjectKey   string  `json:"objectKey"`
	UploadID    string  `json:"uploadId"`
	RoomID      string  `json:"roomId"`
	FileName    string  `json:"fileName"`
	ContentType string  `json:"contentType"`
	Size        uint64  `json:"size"`
	TargetID    *string `json:"targetId"`
	FromID      string  `json:"fromId"`
	IssuedAt    uint64  `json:"issuedAt"`
}

type CompletedUpload struct {
	FileID      string
	RoomID      string
	FileName    string
	Size        uint64
	ContentType string
	ObjectKey   string
	TargetID    *string
	FromID      string
	CreatedAt   uint64
}

type CreatedUpload struct {
	TokenPayload UploadTokenPayload
	Response     protocol.RelayUploadResponse
}

type ResumeInput struct {
	FileID      string
	ObjectKey   string
	UploadID    string
	RoomID      string
	FileName    string
	ContentType string
	Size        uint64
	TargetID    *string
	FromID      string
}

type Object struct {
	Path string
	Size uint64
}

type Service struct {
	root          string
	signingSecret string
}

func NewService(root, signingSecret string) (*Service, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	canonical, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Service{root: canonical, signingSecret: signingSecret}, nil
}

func (s *Service) CreateUpload(sess session.Payload, request protocol.RelayUploadRequest) (CreatedUpload, error) {
	roomID := util.SanitizeRoomID(request.RoomID)
	fileName := util.SanitizeFileName(request.FileName)
	contentType := normalizeContentType(request.ContentType)
	fileID := uuid.NewString()
	uploadID := uuid.NewString()
	payload := UploadTokenPayload{
		FileID:      fileID,
		ObjectKey:   util.BuildObjectKey(roomID, fileID, fileName),
		UploadID:    uploadID,
		RoomID:      roomID,
		FileName:    fileName,
		ContentType: contentType,
		Size:        request.Size,
		TargetID:    request.TargetID,
		FromID:      sess.ClientID,
		IssuedAt:    util.NowMS(),
	}
	response, err := s.buildUploadResponse(payload, nil)
	if err != nil {
		return CreatedUpload{}, err
	}
	return CreatedUpload{TokenPayload: payload, Response: response}, nil
}

func (s *Service) ResumeUpload(input ResumeInput, uploadedParts []protocol.RelayUploadedPart) (protocol.RelayUploadResponse, error) {
	return s.buildUploadResponse(UploadTokenPayload{
		FileID:      input.FileID,
		ObjectKey:   input.ObjectKey,
		UploadID:    input.UploadID,
		RoomID:      input.RoomID,
		FileName:    input.FileName,
		ContentType: input.ContentType,
		Size:        input.Size,
		TargetID:    input.TargetID,
		FromID:      input.FromID,
		IssuedAt:    util.NowMS(),
	}, uploadedParts)
}

func (s *Service) UploadPart(ctx context.Context, sess session.Payload, uploadToken string, partNumber int, bytes []byte) (protocol.RelayUploadPartResponse, UploadTokenPayload, error) {
	payload, err := s.DescribeUploadToken(sess, uploadToken)
	if err != nil {
		return protocol.RelayUploadPartResponse{}, UploadTokenPayload{}, err
	}
	if err := validatePartNumber(payload, partNumber); err != nil {
		return protocol.RelayUploadPartResponse{}, UploadTokenPayload{}, err
	}
	if err := validatePartSize(payload, partNumber, uint64(len(bytes))); err != nil {
		return protocol.RelayUploadPartResponse{}, UploadTokenPayload{}, err
	}
	etag := sha256Hex(bytes)
	path, err := s.uploadPartPath(payload, partNumber)
	if err != nil {
		return protocol.RelayUploadPartResponse{}, UploadTokenPayload{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return protocol.RelayUploadPartResponse{}, UploadTokenPayload{}, err
	}
	if err := os.WriteFile(path, bytes, 0o644); err != nil {
		return protocol.RelayUploadPartResponse{}, UploadTokenPayload{}, err
	}
	_ = ctx
	return protocol.RelayUploadPartResponse{PartNumber: partNumber, Etag: etag}, payload, nil
}

func (s *Service) StoreMultipartFile(ctx context.Context, sess session.Payload, roomID, fileName, contentType string, size uint64, targetID *string, header *multipart.FileHeader) (CompletedUpload, error) {
	file, err := header.Open()
	if err != nil {
		return CompletedUpload{}, err
	}
	defer file.Close()
	return s.StoreFileStream(ctx, sess.ClientID, roomID, fileName, contentType, size, targetID, file)
}

func (s *Service) StoreFileStream(ctx context.Context, fromID, roomID, fileName, contentType string, size uint64, targetID *string, reader io.Reader) (CompletedUpload, error) {
	roomID = util.SanitizeRoomID(roomID)
	fileName = util.SanitizeFileName(fileName)
	contentType = normalizeContentType(contentType)
	fileID := uuid.NewString()
	objectKey := util.BuildObjectKey(roomID, fileID, fileName)
	finalPath, err := s.objectPath(objectKey)
	if err != nil {
		return CompletedUpload{}, err
	}
	if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
		return CompletedUpload{}, err
	}
	tempPath := filepath.Join(filepath.Dir(finalPath), "."+fileID+".uploading")
	output, err := os.Create(tempPath)
	if err != nil {
		return CompletedUpload{}, err
	}
	defer output.Close()

	written, err := copyBounded(ctx, output, reader, size)
	if err != nil {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, err
	}
	if written != size {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, fmt.Errorf("relay upload size mismatch: expected %d, got %d", size, written)
	}
	if err := output.Sync(); err != nil {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, err
	}
	if err := output.Close(); err != nil {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, err
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, err
	}
	return CompletedUpload{
		FileID:      fileID,
		RoomID:      roomID,
		FileName:    fileName,
		Size:        size,
		ContentType: contentType,
		ObjectKey:   objectKey,
		TargetID:    targetID,
		FromID:      fromID,
		CreatedAt:   util.NowMS(),
	}, nil
}

func (s *Service) CompleteUpload(ctx context.Context, sess session.Payload, request protocol.RelayCompleteUploadRequest) (CompletedUpload, error) {
	payload, err := s.DescribeUploadToken(sess, request.UploadToken)
	if err != nil {
		return CompletedUpload{}, err
	}
	if len(request.Parts) == 0 {
		return CompletedUpload{}, errors.New("missing uploaded parts")
	}
	totalParts := partCount(payload.Size)
	if len(request.Parts) != totalParts {
		return CompletedUpload{}, errors.New("uploaded part count mismatch")
	}
	parts := append([]protocol.RelayUploadedPart(nil), request.Parts...)
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })

	finalPath, err := s.objectPath(payload.ObjectKey)
	if err != nil {
		return CompletedUpload{}, err
	}
	if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
		return CompletedUpload{}, err
	}
	tempPath := filepath.Join(filepath.Dir(finalPath), "."+payload.FileID+"."+payload.UploadID+".assembling")
	output, err := os.Create(tempPath)
	if err != nil {
		return CompletedUpload{}, err
	}
	defer output.Close()

	var totalSize uint64
	for expected := 1; expected <= totalParts; expected++ {
		part := parts[expected-1]
		if part.PartNumber != expected {
			_ = os.Remove(tempPath)
			return CompletedUpload{}, errors.New("uploaded part sequence mismatch")
		}
		if err := validatePartNumber(payload, part.PartNumber); err != nil {
			_ = os.Remove(tempPath)
			return CompletedUpload{}, err
		}
		partPath, err := s.uploadPartPath(payload, part.PartNumber)
		if err != nil {
			_ = os.Remove(tempPath)
			return CompletedUpload{}, err
		}
		bytes, err := os.ReadFile(partPath)
		if err != nil {
			_ = os.Remove(tempPath)
			return CompletedUpload{}, err
		}
		if err := validatePartSize(payload, part.PartNumber, uint64(len(bytes))); err != nil {
			_ = os.Remove(tempPath)
			return CompletedUpload{}, err
		}
		if sha256Hex(bytes) != part.Etag {
			_ = os.Remove(tempPath)
			return CompletedUpload{}, errors.New("uploaded part checksum mismatch")
		}
		n, err := output.Write(bytes)
		if err != nil {
			_ = os.Remove(tempPath)
			return CompletedUpload{}, err
		}
		totalSize += uint64(n)
	}
	if totalSize != payload.Size {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, errors.New("completed relay upload size mismatch")
	}
	if err := output.Sync(); err != nil {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, err
	}
	if err := output.Close(); err != nil {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, err
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		_ = os.Remove(tempPath)
		return CompletedUpload{}, err
	}
	if err := s.deleteUploadParts(payload); err != nil {
		return CompletedUpload{}, err
	}
	_ = ctx
	return CompletedUpload{
		FileID:      payload.FileID,
		RoomID:      payload.RoomID,
		FileName:    payload.FileName,
		Size:        payload.Size,
		ContentType: payload.ContentType,
		ObjectKey:   payload.ObjectKey,
		TargetID:    payload.TargetID,
		FromID:      payload.FromID,
		CreatedAt:   util.NowMS(),
	}, nil
}

func (s *Service) AbortUpload(sess session.Payload, request protocol.RelayAbortUploadRequest) (UploadTokenPayload, error) {
	payload, err := s.DescribeUploadToken(sess, request.UploadToken)
	if err != nil {
		return UploadTokenPayload{}, err
	}
	return payload, s.deleteUploadParts(payload)
}

func (s *Service) VerifyUploadToken(sess session.Payload, uploadToken string) (UploadTokenPayload, error) {
	return s.DescribeUploadToken(sess, uploadToken)
}

func (s *Service) DescribeUploadToken(sess session.Payload, uploadToken string) (UploadTokenPayload, error) {
	var payload UploadTokenPayload
	if err := session.ReadSignedToken(s.signingSecret, uploadToken, &payload); err != nil {
		return UploadTokenPayload{}, err
	}
	if payload.FromID != sess.ClientID {
		return UploadTokenPayload{}, errors.New("invalid upload token owner")
	}
	return payload, nil
}

func (s *Service) DeleteObjectByKey(objectKey string) error {
	path, err := s.objectPath(objectKey)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *Service) DeleteOrphanedFiles(files []protocol.RelayFileDescriptor) error {
	for _, file := range files {
		if err := s.DeleteObjectByKey(file.ObjectKey); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) GetObject(objectKey string) (Object, error) {
	path, err := s.objectPath(objectKey)
	if err != nil {
		return Object{}, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		return Object{}, err
	}
	return Object{Path: path, Size: uint64(stat.Size())}, nil
}

func (s *Service) buildUploadResponse(payload UploadTokenPayload, uploadedParts []protocol.RelayUploadedPart) (protocol.RelayUploadResponse, error) {
	token, err := session.CreateSignedToken(s.signingSecret, payload)
	if err != nil {
		return protocol.RelayUploadResponse{}, err
	}
	totalParts := partCount(payload.Size)
	parts := make([]protocol.RelayUploadPart, 0, totalParts)
	for partNumber := 1; partNumber <= totalParts; partNumber++ {
		parts = append(parts, protocol.RelayUploadPart{
			PartNumber: partNumber,
			UploadURL:  fmt.Sprintf("/api/files/upload-part/%d", partNumber),
		})
	}
	if uploadedParts == nil {
		uploadedParts = []protocol.RelayUploadedPart{}
	}
	return protocol.RelayUploadResponse{
		FileID:         payload.FileID,
		ObjectKey:      payload.ObjectKey,
		UploadToken:    token,
		ChunkSizeBytes: ChunkSizeBytes,
		UploadedParts:  uploadedParts,
		Parts:          parts,
	}, nil
}

func (s *Service) objectPath(objectKey string) (string, error) {
	cleaned := filepath.Clean(filepath.FromSlash(objectKey))
	if strings.HasPrefix(cleaned, "..") || filepath.IsAbs(cleaned) {
		return "", errors.New("relay object path escapes file store root")
	}
	path := filepath.Join(s.root, cleaned)
	if !strings.HasPrefix(path, s.root+string(os.PathSeparator)) && path != s.root {
		return "", errors.New("relay object path escapes file store root")
	}
	return path, nil
}

func (s *Service) uploadPartPath(payload UploadTokenPayload, partNumber int) (string, error) {
	uploadKey := filepath.ToSlash(filepath.Join(".uploads", payload.UploadID, filepath.FromSlash(payload.ObjectKey), fmt.Sprintf("%d.part", partNumber)))
	return s.objectPath(uploadKey)
}

func (s *Service) deleteUploadParts(payload UploadTokenPayload) error {
	path, err := s.objectPath(filepath.ToSlash(filepath.Join(".uploads", payload.UploadID)))
	if err != nil {
		return err
	}
	err = os.RemoveAll(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func validatePartNumber(payload UploadTokenPayload, partNumber int) error {
	if partNumber <= 0 {
		return errors.New("invalid relay upload part number")
	}
	if partNumber > partCount(payload.Size) {
		return errors.New("relay upload part number out of range")
	}
	return nil
}

func validatePartSize(payload UploadTokenPayload, partNumber int, actualSize uint64) error {
	totalParts := partCount(payload.Size)
	var expected uint64 = ChunkSizeBytes
	if partNumber == totalParts {
		remaining := payload.Size % ChunkSizeBytes
		if remaining != 0 {
			expected = remaining
		}
	}
	if actualSize != expected {
		return fmt.Errorf("relay upload part size mismatch: expected %d, got %d", expected, actualSize)
	}
	return nil
}

func partCount(size uint64) int {
	if size == 0 {
		return 0
	}
	return int((size + ChunkSizeBytes - 1) / ChunkSizeBytes)
}

func sha256Hex(bytes []byte) string {
	sum := sha256.Sum256(bytes)
	return hex.EncodeToString(sum[:])
}

func normalizeContentType(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "application/octet-stream"
	}
	return value
}

func copyBounded(ctx context.Context, dst io.Writer, src io.Reader, expected uint64) (uint64, error) {
	buffer := make([]byte, 256*1024)
	var written uint64
	for {
		select {
		case <-ctx.Done():
			return written, ctx.Err()
		default:
		}
		n, readErr := src.Read(buffer)
		if n > 0 {
			written += uint64(n)
			if written > expected {
				return written, fmt.Errorf("relay upload exceeded declared size: expected %d, got at least %d", expected, written)
			}
			if _, err := dst.Write(buffer[:n]); err != nil {
				return written, err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}
