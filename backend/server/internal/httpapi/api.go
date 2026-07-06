package httpapi

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/baisuipingan/patrick-im/backend/server/internal/config"
	"github.com/baisuipingan/patrick-im/backend/server/internal/messages"
	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/realtime"
	"github.com/baisuipingan/patrick-im/backend/server/internal/relay"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
	"github.com/baisuipingan/patrick-im/backend/server/internal/staticweb"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

type API struct {
	cfg      config.Config
	logger   *slog.Logger
	hub      *realtime.Hub
	messages *messages.Store
	relay    *relay.Service
	static   staticweb.Handler
}

func New(cfg config.Config, logger *slog.Logger, hub *realtime.Hub, messageStore *messages.Store, relayService *relay.Service) *API {
	return &API{
		cfg:      cfg,
		logger:   logger,
		hub:      hub,
		messages: messageStore,
		relay:    relayService,
		static:   staticweb.New(cfg.WebDistPath),
	}
}

func Router(api *API) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.MaxMultipartMemory = 8 << 20
	_ = r.SetTrustedProxies([]string{"127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"})
	r.Use(requestLogger(api.logger), gin.Recovery())

	r.GET("/api/healthz", api.healthz)
	r.GET("/api/session", api.sessionInfo)
	r.POST("/api/files/relay-upload", api.relayUpload)
	r.POST("/api/files/upload-request", api.uploadRequest)
	r.POST("/api/files/upload-part/:part_number", api.uploadPart)
	r.POST("/api/files/complete", api.completeUpload)
	r.POST("/api/files/abort", api.abortUpload)
	r.POST("/api/files/discard", api.discardUpload)
	r.GET("/api/files/:room_id/:file_id/access", api.fileAccess)
	r.GET("/api/rooms/:room_id/ws", api.roomWS)
	r.POST("/api/rooms/:room_id/threads/clear", api.clearThread)
	r.GET("/", api.static.Serve)
	r.NoRoute(api.static.Serve)
	return r
}

func (api *API) healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "patrick-im-server"})
}

func (api *API) sessionInfo(c *gin.Context) {
	payload, err := session.GetOrCreate(c.Request, c.Writer, shouldUseSecureCookie(c.Request, api.cfg.SecureCookies), api.cfg.SessionSecret)
	if err != nil {
		api.fail(c, http.StatusInternalServerError, "session error")
		return
	}
	sessionToken, err := session.CreateSignedToken(api.cfg.SessionSecret, payload)
	if err != nil {
		api.fail(c, http.StatusInternalServerError, "session error")
		return
	}
	response := protocol.SessionResponse{
		ClientID:                 payload.ClientID,
		Nickname:                 payload.Nickname,
		SessionToken:             sessionToken,
		IceServers:               api.iceServers(),
		RelayFileLimitBytes:      relay.FileLimitBytes,
		DirectFileSoftLimitBytes: ^uint64(0),
		RecommendedTransferMode:  "auto",
	}
	c.JSON(http.StatusOK, response)
}

func (api *API) uploadRequest(c *gin.Context) {
	sess, ok := api.requireSession(c)
	if !ok {
		return
	}
	var payload protocol.RelayUploadRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid upload request")
		return
	}
	if strings.TrimSpace(payload.FileName) == "" || strings.TrimSpace(payload.RoomID) == "" || payload.Size == 0 {
		api.fail(c, http.StatusBadRequest, "file metadata is incomplete")
		return
	}
	if payload.Size > relay.FileLimitBytes {
		api.fail(c, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large for relay mode (%d bytes max)", relay.FileLimitBytes))
		return
	}
	normalized := normalizeUploadRequest(payload)
	if existing, err := api.messages.FindRelayUploadRequest(c.Request.Context(), sess.ClientID, normalized.ClientRequestID); err != nil {
		api.internal(c, err)
		return
	} else if existing != nil {
		if err := validateRelayUploadRequestRecord(*existing, sess.ClientID, normalized); err != nil {
			api.fail(c, http.StatusConflict, err.Error())
			return
		}
		parts, err := api.messages.ListRelayUploadParts(c.Request.Context(), existing.FileID)
		if err != nil {
			api.internal(c, err)
			return
		}
		response, err := api.relay.ResumeUpload(relay.ResumeInput{
			FileID:      existing.FileID,
			ObjectKey:   existing.ObjectKey,
			UploadID:    existing.UploadID,
			RoomID:      existing.RoomID,
			FileName:    existing.FileName,
			ContentType: existing.ContentType,
			Size:        uint64(existing.Size),
			TargetID:    existing.TargetID,
			FromID:      existing.FromID,
		}, parts)
		if err != nil {
			api.internal(c, err)
			return
		}
		c.JSON(http.StatusOK, response)
		return
	}

	created, err := api.relay.CreateUpload(sess, payload)
	if err != nil {
		api.internal(c, err)
		return
	}
	record := repository.RelayUploadRequestRecord{
		FromID:      sess.ClientID,
		RequestID:   normalized.ClientRequestID,
		FileID:      created.TokenPayload.FileID,
		RoomID:      created.TokenPayload.RoomID,
		TargetID:    created.TokenPayload.TargetID,
		FileName:    created.TokenPayload.FileName,
		Size:        int64(created.TokenPayload.Size),
		ContentType: created.TokenPayload.ContentType,
		ObjectKey:   created.TokenPayload.ObjectKey,
		UploadID:    created.TokenPayload.UploadID,
		CreatedAt:   int64(created.TokenPayload.IssuedAt),
	}
	existing, inserted, err := api.messages.StoreRelayUploadRequest(c.Request.Context(), record)
	if err != nil {
		api.internal(c, err)
		return
	}
	if inserted {
		c.JSON(http.StatusOK, created.Response)
		return
	}
	_, _ = api.relay.AbortUpload(sess, protocol.RelayAbortUploadRequest{UploadToken: created.Response.UploadToken})
	if err := validateRelayUploadRequestRecord(*existing, sess.ClientID, normalized); err != nil {
		api.fail(c, http.StatusConflict, err.Error())
		return
	}
	parts, err := api.messages.ListRelayUploadParts(c.Request.Context(), existing.FileID)
	if err != nil {
		api.internal(c, err)
		return
	}
	response, err := api.relay.ResumeUpload(relay.ResumeInput{
		FileID:      existing.FileID,
		ObjectKey:   existing.ObjectKey,
		UploadID:    existing.UploadID,
		RoomID:      existing.RoomID,
		FileName:    existing.FileName,
		ContentType: existing.ContentType,
		Size:        uint64(existing.Size),
		TargetID:    existing.TargetID,
		FromID:      existing.FromID,
	}, parts)
	if err != nil {
		api.internal(c, err)
		return
	}
	c.JSON(http.StatusOK, response)
}

func (api *API) relayUpload(c *gin.Context) {
	sess, ok := api.requireSession(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, int64(relay.FileLimitBytes+relay.ChunkSizeBytes))
	roomID := c.PostForm("roomId")
	targetID := optionalString(c.PostForm("targetId"))
	size, err := strconv.ParseUint(strings.TrimSpace(c.PostForm("size")), 10, 64)
	if err != nil || roomID == "" || size == 0 {
		api.fail(c, http.StatusBadRequest, "file metadata is incomplete")
		return
	}
	if size > relay.FileLimitBytes {
		api.fail(c, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large for relay mode (%d bytes max)", relay.FileLimitBytes))
		return
	}
	header, err := c.FormFile("file")
	if err != nil {
		api.fail(c, http.StatusBadRequest, "missing file")
		return
	}
	contentType := header.Header.Get("content-type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	completed, err := api.relay.StoreMultipartFile(c.Request.Context(), sess, roomID, header.Filename, contentType, size, targetID, header)
	if err != nil {
		api.internal(c, err)
		return
	}
	if _, err := api.persistCompletedRelayUpload(c, completed); err != nil {
		return
	}
	c.JSON(http.StatusOK, protocol.RelayUploadStoredResponse{FileID: completed.FileID, ObjectKey: completed.ObjectKey})
}

func (api *API) uploadPart(c *gin.Context) {
	sess, ok := api.requireSession(c)
	if !ok {
		return
	}
	partNumber, err := strconv.Atoi(c.Param("part_number"))
	if err != nil {
		api.fail(c, http.StatusBadRequest, "invalid relay upload part number")
		return
	}
	uploadToken := strings.TrimSpace(c.GetHeader("x-patrick-im-upload-token"))
	if uploadToken == "" {
		api.fail(c, http.StatusBadRequest, "missing upload token")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, int64(relay.ChunkSizeBytes)+1)
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		api.fail(c, http.StatusBadRequest, "invalid upload body")
		return
	}
	part, payload, err := api.relay.UploadPart(c.Request.Context(), sess, uploadToken, partNumber, body)
	if err != nil {
		api.fail(c, http.StatusBadRequest, err.Error())
		return
	}
	if err := api.messages.StoreRelayUploadPart(c.Request.Context(), payload.FileID, protocol.RelayUploadedPart{
		PartNumber: part.PartNumber,
		Etag:       part.Etag,
	}); err != nil {
		api.internal(c, err)
		return
	}
	c.JSON(http.StatusOK, part)
}

func (api *API) completeUpload(c *gin.Context) {
	sess, ok := api.requireSession(c)
	if !ok {
		return
	}
	var payload protocol.RelayCompleteUploadRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid complete upload request")
		return
	}
	tokenPayload, err := api.relay.DescribeUploadToken(sess, payload.UploadToken)
	if err != nil {
		api.fail(c, http.StatusBadRequest, err.Error())
		return
	}
	if existing, err := api.messages.FindPendingRelayUpload(c.Request.Context(), tokenPayload.FileID); err != nil {
		api.internal(c, err)
		return
	} else if existing != nil {
		if err := validatePendingUploadMatchesToken(*existing, tokenPayload); err != nil {
			api.fail(c, http.StatusConflict, err.Error())
			return
		}
		c.JSON(http.StatusOK, protocol.RelayCompleteUploadResponse{FileID: existing.FileID, ObjectKey: existing.ObjectKey})
		return
	}
	completed, err := api.relay.CompleteUpload(c.Request.Context(), sess, payload)
	if err != nil {
		if existing, findErr := api.messages.FindPendingRelayUpload(c.Request.Context(), tokenPayload.FileID); findErr == nil && existing != nil {
			if validatePendingUploadMatchesToken(*existing, tokenPayload) == nil {
				c.JSON(http.StatusOK, protocol.RelayCompleteUploadResponse{FileID: existing.FileID, ObjectKey: existing.ObjectKey})
				return
			}
		}
		api.fail(c, http.StatusBadRequest, err.Error())
		return
	}
	if existing, err := api.persistCompletedRelayUpload(c, completed); err != nil {
		return
	} else if existing != nil {
		c.JSON(http.StatusOK, *existing)
		return
	}
	c.JSON(http.StatusOK, protocol.RelayCompleteUploadResponse{FileID: completed.FileID, ObjectKey: completed.ObjectKey})
}

func (api *API) abortUpload(c *gin.Context) {
	sess, ok := api.requireSession(c)
	if !ok {
		return
	}
	var payload protocol.RelayAbortUploadRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid abort upload request")
		return
	}
	tokenPayload, err := api.relay.AbortUpload(sess, payload)
	if err != nil {
		api.fail(c, http.StatusBadRequest, err.Error())
		return
	}
	_, _ = api.messages.RemoveRelayUploadRequestByFileID(c.Request.Context(), tokenPayload.FileID)
	c.JSON(http.StatusOK, gin.H{"aborted": true})
}

func (api *API) discardUpload(c *gin.Context) {
	sess, ok := api.requireSession(c)
	if !ok {
		return
	}
	var payload protocol.RelayDiscardUploadRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid discard upload request")
		return
	}
	tokenPayload, err := api.relay.VerifyUploadToken(sess, payload.UploadToken)
	if err != nil {
		api.fail(c, http.StatusBadRequest, err.Error())
		return
	}
	if _, err := api.messages.RemovePendingRelayUpload(c.Request.Context(), tokenPayload.FileID); err != nil {
		api.internal(c, err)
		return
	}
	if _, err := api.messages.RemoveRelayUploadRequestByFileID(c.Request.Context(), tokenPayload.FileID); err != nil {
		api.internal(c, err)
		return
	}
	if err := api.relay.DeleteObjectByKey(tokenPayload.ObjectKey); err != nil {
		api.internal(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"discarded": true})
}

func (api *API) fileAccess(c *gin.Context) {
	sess, ok := api.requireSession(c)
	if !ok {
		return
	}
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	fileID := c.Param("file_id")
	descriptor, err := api.messages.LookupFileForClient(c.Request.Context(), roomID, fileID, sess.ClientID)
	if errors.Is(err, messages.ErrFileNotFound) {
		api.fail(c, http.StatusNotFound, "file not found")
		return
	}
	if errors.Is(err, messages.ErrFileForbidden) {
		api.fail(c, http.StatusForbidden, "file not accessible")
		return
	}
	if err != nil {
		api.internal(c, err)
		return
	}
	object, err := api.relay.GetObject(descriptor.ObjectKey)
	if err != nil {
		api.internal(c, err)
		return
	}
	disposition := "attachment"
	if descriptor.Previewable {
		disposition = "inline"
	}
	c.Header("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disposition, util.EncodeContentDispositionName(descriptor.FileName)))
	c.Header("Content-Type", descriptor.ContentType)
	c.Header("Content-Length", strconv.FormatUint(object.Size, 10))
	c.File(object.Path)
}

func (api *API) clearThread(c *gin.Context) {
	sess, ok := api.requireSession(c)
	if !ok {
		return
	}
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	var payload protocol.ClearThreadRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid clear thread request")
		return
	}
	if !api.hub.IsClientConnected(roomID, sess.ClientID) {
		api.fail(c, http.StatusForbidden, "client is not connected to this room")
		return
	}
	actorName, ok := api.hub.DisplayNameFor(roomID, sess.ClientID)
	if !ok {
		actorName = sess.Nickname
	}
	outcome, err := api.messages.ClearThread(c.Request.Context(), roomID, sess.ClientID, actorName, payload.TargetID)
	if err != nil {
		api.internal(c, err)
		return
	}
	if err := api.relay.DeleteOrphanedFiles(outcome.OrphanedFiles); err != nil {
		api.logger.Warn("delete orphaned relay files failed", "error", err)
	}
	if outcome.Event != nil {
		recipients := recipientsFor(outcome.Event.TargetID, sess.ClientID)
		api.hub.Broadcast(roomID, nil, recipients, protocol.ServerToClientMessage{
			Type:              "thread-cleared",
			TargetID:          outcome.Event.TargetID,
			ActorID:           outcome.Event.ActorID,
			ActorName:         outcome.Event.ActorName,
			RemovedMessages:   outcome.Event.RemovedMessages,
			RemovedRelayFiles: outcome.Event.RemovedRelayFiles,
		})
	}
	c.JSON(http.StatusOK, outcome.Response)
}

func (api *API) persistCompletedRelayUpload(c *gin.Context, completed relay.CompletedUpload) (*protocol.RelayCompleteUploadResponse, error) {
	existing, inserted, err := api.messages.StoreCompletedRelayUpload(c.Request.Context(), repository.PendingRelayUpload{
		FileID:      completed.FileID,
		RoomID:      completed.RoomID,
		FromID:      completed.FromID,
		TargetID:    completed.TargetID,
		FileName:    completed.FileName,
		Size:        int64(completed.Size),
		ContentType: completed.ContentType,
		ObjectKey:   completed.ObjectKey,
		CreatedAt:   int64(completed.CreatedAt),
	})
	if err != nil {
		_ = api.relay.DeleteObjectByKey(completed.ObjectKey)
		_, _ = api.messages.RemoveRelayUploadRequestByFileID(c.Request.Context(), completed.FileID)
		api.internal(c, err)
		return nil, err
	}
	if !inserted {
		if err := validatePendingUploadMatchesCompleted(*existing, completed); err != nil {
			api.fail(c, http.StatusConflict, err.Error())
			return nil, err
		}
		return &protocol.RelayCompleteUploadResponse{FileID: existing.FileID, ObjectKey: existing.ObjectKey}, nil
	}
	return nil, nil
}

func (api *API) requireSession(c *gin.Context) (session.Payload, bool) {
	payload, err := session.Require(c.Request, api.cfg.SessionSecret)
	if err != nil {
		api.fail(c, http.StatusUnauthorized, "missing session")
		return session.Payload{}, false
	}
	return payload, true
}

func (api *API) internal(c *gin.Context, err error) {
	api.logger.Error("request failed", "error", err)
	api.fail(c, http.StatusInternalServerError, "internal server error")
}

func (api *API) fail(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message})
}

func (api *API) iceServers() []protocol.IceServer {
	servers := make([]protocol.IceServer, 0, 2)
	if len(api.cfg.STUNURLs) > 0 {
		servers = append(servers, protocol.IceServer{URLs: api.cfg.STUNURLs})
	}
	if len(api.cfg.TURNURLs) > 0 {
		servers = append(servers, protocol.IceServer{URLs: api.cfg.TURNURLs, Username: api.cfg.TURNUsername, Credential: api.cfg.TURNCredential})
	}
	return servers
}

func requestLogger(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		logger.Info("http request", "method", c.Request.Method, "path", c.Request.URL.Path, "status", c.Writer.Status(), "latency", time.Since(start).String())
	}
}

func shouldUseSecureCookie(r *http.Request, configured bool) bool {
	if configured {
		return true
	}
	for _, proto := range strings.Split(r.Header.Get("x-forwarded-proto"), ",") {
		if strings.EqualFold(strings.TrimSpace(proto), "https") {
			return true
		}
	}
	return false
}

type normalizedRelayUploadRequest struct {
	ClientRequestID string
	RoomID          string
	FileName        string
	ContentType     string
	Size            uint64
	TargetID        *string
}

func normalizeUploadRequest(request protocol.RelayUploadRequest) normalizedRelayUploadRequest {
	clientRequestID := ""
	if request.ClientRequestID != nil {
		clientRequestID = strings.TrimSpace(*request.ClientRequestID)
	}
	if clientRequestID == "" {
		clientRequestID = util.SanitizeFileName(request.FileName) + "-" + strconv.FormatUint(util.NowMS(), 10)
	}
	contentType := strings.TrimSpace(request.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return normalizedRelayUploadRequest{
		ClientRequestID: clientRequestID,
		RoomID:          util.SanitizeRoomID(request.RoomID),
		FileName:        util.SanitizeFileName(request.FileName),
		ContentType:     contentType,
		Size:            request.Size,
		TargetID:        request.TargetID,
	}
}

func validateRelayUploadRequestRecord(record repository.RelayUploadRequestRecord, fromID string, normalized normalizedRelayUploadRequest) error {
	if record.FromID != fromID ||
		record.RequestID != normalized.ClientRequestID ||
		record.RoomID != normalized.RoomID ||
		record.FileName != normalized.FileName ||
		uint64(record.Size) != normalized.Size ||
		record.ContentType != normalized.ContentType ||
		!sameStringPtr(record.TargetID, normalized.TargetID) {
		return fmt.Errorf("relay upload request id conflicts with different file metadata")
	}
	return nil
}

func validatePendingUploadMatchesToken(record repository.PendingRelayUpload, token relay.UploadTokenPayload) error {
	if record.FileID != token.FileID ||
		record.RoomID != token.RoomID ||
		record.FromID != token.FromID ||
		!sameStringPtr(record.TargetID, token.TargetID) ||
		record.FileName != token.FileName ||
		uint64(record.Size) != token.Size ||
		record.ContentType != token.ContentType ||
		record.ObjectKey != token.ObjectKey {
		return fmt.Errorf("completed relay upload conflicts with stored pending upload")
	}
	return nil
}

func validatePendingUploadMatchesCompleted(record repository.PendingRelayUpload, completed relay.CompletedUpload) error {
	if record.FileID != completed.FileID ||
		record.RoomID != completed.RoomID ||
		record.FromID != completed.FromID ||
		!sameStringPtr(record.TargetID, completed.TargetID) ||
		record.FileName != completed.FileName ||
		uint64(record.Size) != completed.Size ||
		record.ContentType != completed.ContentType ||
		record.ObjectKey != completed.ObjectKey {
		return fmt.Errorf("completed relay upload conflicts with stored pending upload")
	}
	return nil
}

func sameStringPtr(left, right *string) bool {
	if left == nil || *left == "" {
		return right == nil || *right == ""
	}
	return right != nil && *left == *right
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func recipientsFor(targetID *string, actorID string) []string {
	if targetID == nil {
		return nil
	}
	return []string{actorID, *targetID}
}
