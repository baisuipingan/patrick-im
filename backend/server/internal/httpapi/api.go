package httpapi

import (
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

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			messageType, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if messageType == websocket.TextMessage {
				api.handleClientWebSocketMessage(roomID, payload, data)
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

func (api *API) handleClientWebSocketMessage(roomID string, sender session.Payload, data []byte) {
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
	api.logger.Error("request failed", "error", err)
	api.fail(c, http.StatusInternalServerError, "internal server error")
}

func (api *API) fail(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message})
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
