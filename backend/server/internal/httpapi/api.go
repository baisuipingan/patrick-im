package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/baisuipingan/patrick-im/backend/server/internal/chat"
	"github.com/baisuipingan/patrick-im/backend/server/internal/config"
	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
	"github.com/baisuipingan/patrick-im/backend/server/internal/staticweb"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

const (
	wsProtocolName          = "patrick-im"
	wsSessionProtocolPrefix = "patrick-im-session."
)

type API struct {
	cfg    config.Config
	logger *slog.Logger
	store  *chat.Store
	hub    *chat.Hub
	static staticweb.Handler
}

func New(cfg config.Config, logger *slog.Logger, store *chat.Store, hub *chat.Hub) *API {
	return &API{
		cfg:    cfg,
		logger: logger,
		store:  store,
		hub:    hub,
		static: staticweb.New(cfg.WebDistPath),
	}
}

func Router(api *API) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.MaxMultipartMemory = 16 << 20
	_ = r.SetTrustedProxies([]string{"127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"})
	r.Use(requestLogger(api.logger), gin.Recovery())

	r.GET("/api/healthz", api.healthz)
	r.GET("/api/session", api.sessionInfo)
	r.PATCH("/api/session", api.renameSession)
	r.GET("/api/rooms", api.listRooms)
	r.POST("/api/rooms", api.createRoom)
	r.GET("/api/rooms/:room_id", api.roomDetail)
	r.GET("/api/rooms/:room_id/conversations", api.listConversations)
	r.POST("/api/rooms/:room_id/conversations/direct", api.createDirectConversation)
	r.GET("/api/conversations/:conversation_id/messages", api.listConversationMessages)
	r.POST("/api/conversations/:conversation_id/messages", api.createConversationMessage)
	r.POST("/api/conversations/:conversation_id/attachments", api.createConversationAttachment)
	r.POST("/api/conversations/:conversation_id/read", api.markConversationRead)
	r.GET("/api/attachments/:attachment_id", api.attachmentInfo)
	r.GET("/api/rooms/:room_id/messages", api.listMessages)
	r.POST("/api/rooms/:room_id/messages", api.createMessage)
	r.DELETE("/api/rooms/:room_id/messages", api.clearMessages)
	r.POST("/api/rooms/:room_id/files", api.createFile)
	r.GET("/api/files/:file_id", api.downloadFile)
	r.GET("/api/rooms/:room_id/ws", api.roomWS)
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
		api.internal(c, err)
		return
	}
	if err := api.store.UpsertSessionUser(c.Request.Context(), payload); err != nil {
		api.internal(c, err)
		return
	}
	api.writeSession(c, payload)
}

func (api *API) renameSession(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	var request protocol.RenameSessionRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid nickname")
		return
	}
	payload.Nickname = util.SanitizeNickname(request.Nickname, payload.Nickname)
	if err := session.Write(c.Writer, payload, shouldUseSecureCookie(c.Request, api.cfg.SecureCookies), api.cfg.SessionSecret); err != nil {
		api.internal(c, err)
		return
	}
	if err := api.store.UpsertSessionUser(c.Request.Context(), payload); err != nil {
		api.internal(c, err)
		return
	}
	api.writeSession(c, payload)
}

func (api *API) writeSession(c *gin.Context, payload session.Payload) {
	token, err := session.CreateSignedToken(api.cfg.SessionSecret, payload)
	if err != nil {
		api.internal(c, err)
		return
	}
	c.JSON(http.StatusOK, protocol.SessionResponse{
		ClientID:        payload.ClientID,
		Nickname:        payload.Nickname,
		SessionToken:    token,
		IceServers:      api.iceServers(),
		MaxUploadBytes:  api.cfg.UploadLimitBytes,
		HistoryPageSize: api.cfg.RecentMessageLimit,
	})
}

func (api *API) iceServers() []protocol.IceServer {
	servers := make([]protocol.IceServer, 0, 2)
	if len(api.cfg.STUNURLs) > 0 {
		servers = append(servers, protocol.IceServer{URLs: api.cfg.STUNURLs})
	}
	if len(api.cfg.TURNURLs) > 0 {
		servers = append(servers, protocol.IceServer{
			URLs:       api.cfg.TURNURLs,
			Username:   api.cfg.TURNUsername,
			Credential: api.cfg.TURNCredential,
		})
	}
	return servers
}

func (api *API) listRooms(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	rooms, err := api.store.ListRooms(c.Request.Context(), payload.ClientID)
	if err != nil {
		api.internal(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"rooms": rooms})
}

func (api *API) createRoom(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	var request protocol.CreateRoomRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid room")
		return
	}
	room, err := api.store.EnsureRoom(c.Request.Context(), request.RoomID, payload)
	if err != nil {
		api.handleStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, room)
}

func (api *API) roomDetail(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	room, err := api.store.EnsureRoom(c.Request.Context(), roomID, payload)
	if err != nil {
		api.handleStoreError(c, err)
		return
	}
	room.Members = markOnlineMembers(room.Members, api.hub.Peers(roomID))
	c.JSON(http.StatusOK, room)
}

func (api *API) listConversations(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	conversations, err := api.store.ListConversations(c.Request.Context(), util.SanitizeRoomID(c.Param("room_id")), payload.ClientID)
	if err != nil {
		api.handleStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversations": conversations})
}

func (api *API) createDirectConversation(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	var request protocol.CreateDirectConversationRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid conversation")
		return
	}
	conversation, err := api.store.CreateDirectConversation(c.Request.Context(), util.SanitizeRoomID(c.Param("room_id")), payload, request.PeerUserID)
	if err != nil {
		api.handleStoreError(c, err)
		return
	}
	api.publishUnreadUpdated(conversation, payload.ClientID)
	api.publishRoomUpdated(c.Request.Context(), conversation.RoomID, payload.ClientID)
	c.JSON(http.StatusOK, conversation)
}

func (api *API) listConversationMessages(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	limit := parseBoundedInt(c.Query("limit"), api.cfg.RecentMessageLimit, 1, 200)
	before := parseInt64(c.Query("before"))
	messages, err := api.store.ListConversationMessages(c.Request.Context(), c.Param("conversation_id"), payload.ClientID, limit, before)
	if err != nil {
		api.handleStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"messages": messages})
}

func (api *API) createConversationMessage(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	var request protocol.CreateConversationMessageRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid message")
		return
	}
	message, err := api.store.CreateConversationMessage(c.Request.Context(), c.Param("conversation_id"), payload, request)
	if err != nil {
		api.handleStoreError(c, err)
		return
	}
	api.publishMessageCreated(message)
	c.JSON(http.StatusOK, message)
}

func (api *API) createConversationAttachment(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, api.cfg.UploadLimitBytes+1024*1024)
	header, err := c.FormFile("file")
	if err != nil {
		api.fail(c, http.StatusBadRequest, "missing file")
		return
	}
	message, err := api.store.CreateConversationAttachment(
		c.Request.Context(),
		c.Param("conversation_id"),
		payload,
		header,
		protocol.MessageType(strings.TrimSpace(c.PostForm("messageType"))),
	)
	if err != nil {
		if errors.Is(err, chat.ErrValidation) {
			api.fail(c, http.StatusRequestEntityTooLarge, "file is empty or too large")
			return
		}
		api.handleStoreError(c, err)
		return
	}
	api.publishMessageCreated(message)
	c.JSON(http.StatusOK, message)
}

func (api *API) markConversationRead(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	var request protocol.MarkReadRequest
	if c.Request.Body != nil {
		_ = c.ShouldBindJSON(&request)
	}
	conversation, err := api.store.MarkConversationRead(c.Request.Context(), c.Param("conversation_id"), payload.ClientID, request)
	if err != nil {
		api.handleStoreError(c, err)
		return
	}
	api.publishUnreadUpdated(conversation, payload.ClientID)
	c.JSON(http.StatusOK, conversation)
}

func (api *API) attachmentInfo(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	attachment, err := api.store.AttachmentInfo(c.Request.Context(), c.Param("attachment_id"), payload.ClientID)
	if err != nil {
		api.handleStoreError(c, err)
		return
	}
	c.JSON(http.StatusOK, attachment)
}

func (api *API) listMessages(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	limit := parseBoundedInt(c.Query("limit"), api.cfg.RecentMessageLimit, 1, 200)
	before := parseInt64(c.Query("before"))
	messages, err := api.store.ListMessages(c.Request.Context(), roomID, payload.ClientID, limit, before)
	if err != nil {
		api.internal(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"messages": messages})
}

func (api *API) createMessage(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	var request protocol.SendMessageRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		api.fail(c, http.StatusBadRequest, "invalid message")
		return
	}
	message, err := api.store.CreateTextMessage(c.Request.Context(), roomID, payload, request.Text, request.TargetID)
	if errors.Is(err, chat.ErrValidation) {
		api.fail(c, http.StatusBadRequest, "message text is empty or too large")
		return
	}
	if err != nil {
		api.internal(c, err)
		return
	}
	api.publishMessage(roomID, message)
	c.JSON(http.StatusOK, message)
}

func (api *API) createFile(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, api.cfg.UploadLimitBytes+1024*1024)
	targetID := optionalString(c.PostForm("targetId"))
	header, err := c.FormFile("file")
	if err != nil {
		api.fail(c, http.StatusBadRequest, "missing file")
		return
	}
	message, err := api.store.CreateFileMessage(c.Request.Context(), roomID, payload, header, targetID)
	if errors.Is(err, chat.ErrValidation) {
		api.fail(c, http.StatusRequestEntityTooLarge, "file is empty or too large")
		return
	}
	if err != nil {
		api.internal(c, err)
		return
	}
	api.publishMessage(roomID, message)
	c.JSON(http.StatusOK, message)
}

func (api *API) downloadFile(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	file, err := api.store.FileForClient(c.Request.Context(), c.Param("file_id"), payload.ClientID)
	if errors.Is(err, chat.ErrNotFound) {
		api.fail(c, http.StatusNotFound, "file not found")
		return
	}
	if errors.Is(err, chat.ErrForbidden) {
		api.fail(c, http.StatusForbidden, "file not accessible")
		return
	}
	if err != nil {
		api.internal(c, err)
		return
	}
	disposition := "attachment"
	if file.Previewable {
		disposition = "inline"
	}
	c.Header("Content-Disposition", disposition+`; filename="`+strings.ReplaceAll(file.FileName, `"`, "")+`"`)
	c.Header("Content-Type", file.ContentType)
	c.Header("Content-Length", strconv.FormatInt(file.Size, 10))
	c.File(file.Path)
}

func (api *API) clearMessages(c *gin.Context) {
	payload, ok := api.requireSession(c)
	if !ok {
		return
	}
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	targetID := optionalString(c.Query("targetId"))
	response, files, err := api.store.ClearThread(c.Request.Context(), roomID, payload, targetID)
	if err != nil {
		api.internal(c, err)
		return
	}
	api.store.DeleteFiles(files)
	api.hub.Publish(roomID, chat.ClearRecipients(payload.ClientID, response.TargetID), protocol.ServerToClientMessage{
		Type:     "messages-cleared",
		RoomID:   roomID,
		ActorID:  payload.ClientID,
		TargetID: response.TargetID,
		Removed:  response.Removed,
	})
	c.JSON(http.StatusOK, response)
}

func (api *API) publishMessage(roomID string, message protocol.Message) {
	api.hub.Publish(roomID, chat.RecipientsFor(message), protocol.ServerToClientMessage{
		Type:    "message",
		RoomID:  roomID,
		Message: &message,
	})
}

func (api *API) publishMessageCreated(message protocol.MessageView) {
	api.hub.Publish(message.RoomID, recipientsForMessageView(message), protocol.NewEnvelope(
		"message_created",
		"",
		message.RoomID,
		message.ConversationID,
		protocol.MessageCreatedPayload{Message: message},
		util.NowMillisInt64(),
	))
}

func (api *API) publishMessageAck(requestID string, message protocol.MessageView) {
	api.hub.Publish(message.RoomID, []string{message.SenderID}, protocol.NewEnvelope(
		"message_ack",
		requestID,
		message.RoomID,
		message.ConversationID,
		protocol.MessageAckPayload{ClientMessageID: message.ClientMessageID, Message: message},
		util.NowMillisInt64(),
	))
}

func (api *API) publishUnreadUpdated(conversation protocol.ConversationView, userID string) {
	api.hub.Publish(conversation.RoomID, []string{userID}, protocol.NewEnvelope(
		"unread_updated",
		"",
		conversation.RoomID,
		conversation.ID,
		protocol.UnreadUpdatedPayload{Conversation: conversation},
		util.NowMillisInt64(),
	))
}

func (api *API) publishRoomUpdated(ctx context.Context, roomID, viewerID string) {
	room, err := api.store.RoomDetail(ctx, roomID, viewerID, onlineMap(api.hub.Peers(roomID)))
	if err != nil {
		return
	}
	api.hub.Publish(roomID, nil, protocol.NewEnvelope(
		"room_updated",
		"",
		roomID,
		"",
		protocol.RoomUpdatedPayload{Room: room},
		util.NowMillisInt64(),
	))
}

func recipientsForMessageView(message protocol.MessageView) []string {
	if message.TargetID == nil {
		return nil
	}
	return []string{message.SenderID, *message.TargetID}
}

func (api *API) roomSnapshot(ctx context.Context, roomID, viewerID string) (protocol.Envelope, error) {
	room, err := api.store.RoomDetail(ctx, roomID, viewerID, onlineMap(api.hub.Peers(roomID)))
	if err != nil {
		return protocol.Envelope{}, err
	}
	return protocol.NewEnvelope(
		"room_snapshot",
		"",
		roomID,
		"",
		protocol.RoomSnapshotPayload{Room: room, Peers: api.hub.Peers(roomID)},
		util.NowMillisInt64(),
	), nil
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  2048,
	WriteBufferSize: 2048,
	CheckOrigin: func(_ *http.Request) bool {
		return true
	},
}

func (api *API) roomWS(c *gin.Context) {
	payload, err := api.requireWebSocketSession(c.Request)
	if err != nil {
		api.fail(c, http.StatusUnauthorized, "missing session")
		return
	}
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	if _, err := api.store.EnsureRoom(c.Request.Context(), roomID, payload); err != nil {
		api.handleStoreError(c, err)
		return
	}
	responseHeader := http.Header{}
	if websocketSubprotocolRequested(c.Request, wsProtocolName) {
		responseHeader.Set("Sec-WebSocket-Protocol", wsProtocolName)
	}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, responseHeader)
	if err != nil {
		api.logger.Warn("websocket upgrade failed", "error", err)
		return
	}
	events, leave := api.hub.Join(roomID, protocol.Peer{
		ClientID: payload.ClientID,
		Nickname: payload.Nickname,
		JoinedAt: util.NowMillisInt64(),
	})
	defer leave()
	defer conn.Close()

	snapshot, err := api.roomSnapshot(c.Request.Context(), roomID, payload.ClientID)
	if err == nil {
		if err := conn.WriteJSON(snapshot); err != nil {
			return
		}
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			messageType, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if messageType == websocket.TextMessage {
				api.handleClientWebSocketMessage(c.Request.Context(), roomID, payload, data)
			}
		}
	}()

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return
			}
			if err := conn.WriteJSON(event); err != nil {
				return
			}
		case <-ticker.C:
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}

func (api *API) handleClientWebSocketMessage(ctx context.Context, roomID string, sender session.Payload, data []byte) {
	if api.handleClientEnvelope(ctx, roomID, sender, data) {
		return
	}
	var message protocol.ClientToServerMessage
	if err := json.Unmarshal(data, &message); err != nil {
		return
	}
	if message.Type != "signal" || strings.TrimSpace(message.TargetID) == "" || message.Payload == nil {
		return
	}
	if message.TargetID == sender.ClientID {
		return
	}
	api.hub.Publish(roomID, []string{message.TargetID}, protocol.ServerToClientMessage{
		Type:    "signal",
		RoomID:  roomID,
		FromID:  sender.ClientID,
		Payload: message.Payload,
	})
}

func (api *API) handleClientEnvelope(ctx context.Context, roomID string, sender session.Payload, data []byte) bool {
	var envelope protocol.Envelope
	if err := json.Unmarshal(data, &envelope); err != nil || envelope.Type == "" {
		return false
	}
	switch envelope.Type {
	case "send_message":
		api.handleSendMessageEnvelope(ctx, roomID, sender, envelope)
		return true
	case "webrtc_offer", "webrtc_answer", "webrtc_ice":
		api.handleWebRTCEnvelope(roomID, sender, envelope)
		return true
	default:
		return false
	}
}

func (api *API) handleSendMessageEnvelope(ctx context.Context, roomID string, sender session.Payload, envelope protocol.Envelope) {
	conversationID := strings.TrimSpace(envelope.ConversationID)
	if conversationID == "" {
		api.publishEnvelopeError(roomID, sender.ClientID, "message_ack", envelope.RequestID, "missing_conversation", "conversation_id is required")
		return
	}
	var request protocol.CreateConversationMessageRequest
	if len(envelope.Payload) > 0 {
		if err := json.Unmarshal(envelope.Payload, &request); err != nil {
			api.publishEnvelopeError(roomID, sender.ClientID, "message_ack", envelope.RequestID, "invalid_payload", "invalid send_message payload")
			return
		}
	}
	if request.ClientMessageID == nil && envelope.RequestID != "" {
		request.ClientMessageID = &envelope.RequestID
	}
	message, err := api.store.CreateConversationMessage(ctx, conversationID, sender, request)
	if err != nil {
		api.publishEnvelopeError(roomID, sender.ClientID, "message_ack", envelope.RequestID, "send_failed", "message was not accepted")
		return
	}
	api.publishMessageCreated(message)
	api.publishMessageAck(envelope.RequestID, message)
}

func (api *API) handleWebRTCEnvelope(roomID string, sender session.Payload, envelope protocol.Envelope) {
	var payload protocol.WebRTCSignalPayload
	if len(envelope.Payload) > 0 {
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			api.publishEnvelopeError(roomID, sender.ClientID, envelope.Type, envelope.RequestID, "invalid_payload", "invalid webrtc payload")
			return
		}
	}
	payload.TargetID = strings.TrimSpace(payload.TargetID)
	if payload.TargetID == "" || payload.TargetID == sender.ClientID {
		return
	}
	payload.FromID = sender.ClientID
	api.hub.Publish(roomID, []string{payload.TargetID}, protocol.NewEnvelope(
		envelope.Type,
		envelope.RequestID,
		roomID,
		envelope.ConversationID,
		payload,
		util.NowMillisInt64(),
	))
}

func (api *API) publishEnvelopeError(roomID, recipientID, eventType, requestID, code, message string) {
	envelope := protocol.NewEnvelope(eventType, requestID, roomID, "", nil, util.NowMillisInt64())
	envelope.Error = &protocol.EnvelopeError{Code: code, Message: message}
	api.hub.Publish(roomID, []string{recipientID}, envelope)
}

func (api *API) requireWebSocketSession(r *http.Request) (session.Payload, error) {
	if payload, err := session.Require(r, api.cfg.SessionSecret); err == nil {
		return payload, nil
	}
	token := websocketSessionToken(r)
	if token == "" {
		return session.Payload{}, http.ErrNoCookie
	}
	payload, err := session.ReadToken(token, api.cfg.SessionSecret)
	if err != nil || payload == nil {
		if err != nil {
			return session.Payload{}, err
		}
		return session.Payload{}, http.ErrNoCookie
	}
	return *payload, nil
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
	if errors.Is(err, context.Canceled) {
		c.AbortWithStatus(499)
		return
	}
	api.logger.Error("request failed", "error", err)
	api.fail(c, http.StatusInternalServerError, "internal server error")
}

func (api *API) handleStoreError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, chat.ErrValidation):
		api.fail(c, http.StatusBadRequest, "invalid request")
	case errors.Is(err, chat.ErrNotFound):
		api.fail(c, http.StatusNotFound, "not found")
	case errors.Is(err, chat.ErrForbidden):
		api.fail(c, http.StatusForbidden, "forbidden")
	default:
		api.internal(c, err)
	}
}

func (api *API) fail(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message})
}

func markOnlineMembers(members []protocol.RoomMemberView, peers []protocol.Peer) []protocol.RoomMemberView {
	online := onlineMap(peers)
	for index := range members {
		members[index].Online = online[members[index].UserID]
	}
	return members
}

func onlineMap(peers []protocol.Peer) map[string]bool {
	online := map[string]bool{}
	for _, peer := range peers {
		online[peer.ClientID] = true
	}
	return online
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

func websocketSessionToken(r *http.Request) string {
	if token := strings.TrimSpace(r.URL.Query().Get("token")); token != "" {
		return token
	}
	if value := strings.TrimSpace(r.Header.Get("authorization")); value != "" {
		if strings.HasPrefix(strings.ToLower(value), "bearer ") {
			return strings.TrimSpace(value[len("bearer "):])
		}
	}
	for _, item := range websocketSubprotocols(r) {
		if strings.HasPrefix(item, wsSessionProtocolPrefix) {
			return strings.TrimPrefix(item, wsSessionProtocolPrefix)
		}
	}
	return ""
}

func websocketSubprotocolRequested(r *http.Request, protocol string) bool {
	for _, item := range websocketSubprotocols(r) {
		if item == protocol {
			return true
		}
	}
	return false
}

func websocketSubprotocols(r *http.Request) []string {
	raw := r.Header.Values("Sec-WebSocket-Protocol")
	out := make([]string, 0)
	for _, header := range raw {
		for _, item := range strings.Split(header, ",") {
			item = strings.TrimSpace(item)
			if item != "" {
				out = append(out, item)
			}
		}
	}
	return out
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func parseBoundedInt(value string, fallback, min, max int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	if parsed < min {
		return min
	}
	if parsed > max {
		return max
	}
	return parsed
}

func parseInt64(value string) int64 {
	parsed, _ := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	return parsed
}
