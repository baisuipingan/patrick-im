package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/baisuipingan/patrick-im/backend/server/internal/messages"
	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/realtime"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = protocol.MaxChatTextBytes + 128*1024
)

const (
	wsProtocolName          = "patrick-im"
	wsSessionProtocolPrefix = "patrick-im-session."
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func (api *API) roomWS(c *gin.Context) {
	roomID := util.SanitizeRoomID(c.Param("room_id"))
	if strings.TrimSpace(roomID) == "" {
		api.fail(c, http.StatusBadRequest, "missing room_id")
		return
	}
	sess, err := api.requireWebSocketSession(c.Request)
	if err != nil {
		api.fail(c, http.StatusUnauthorized, "missing session")
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
	nickname := sess.Nickname
	if queryName := strings.TrimSpace(c.Query("nickname")); queryName != "" {
		nickname = queryName
	}
	go api.handleSocket(roomID, sess.ClientID, nickname, conn)
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

func (api *API) handleSocket(roomID, clientID, nickname string, conn *websocket.Conn) {
	tx := realtime.NewClientTx()
	joined := api.hub.JoinRoom(roomID, clientID, nickname, tx)
	if joined.ReplacedTx != nil {
		joined.ReplacedTx.Close()
	}

	go writePump(conn, tx, api.logger)
	api.sendRoomSnapshot(roomID, clientID, tx, joined.Peers)
	api.hub.Broadcast(roomID, &clientID, nil, protocol.ServerToClientMessage{
		Type: "peer-joined",
		Peer: &joined.JoinedPeer,
	})

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		api.readPump(roomID, clientID, joined.ConnectionID, tx, conn)
	}()
	<-readDone
	tx.Close()
	_ = conn.Close()
	api.removePeer(roomID, clientID, joined.ConnectionID)
}

func (api *API) readPump(roomID, clientID, connectionID string, tx *realtime.ClientTx, conn *websocket.Conn) {
	conn.SetReadLimit(maxMessageSize)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		messageType, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.TextMessage {
			continue
		}
		if !api.hub.IsCurrentConnection(roomID, clientID, connectionID) {
			return
		}
		api.hub.Touch(roomID, clientID, connectionID)
		var message protocol.ClientToServerMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			api.hub.SendJSON(tx, protocol.ServerToClientMessage{
				Type:         "error",
				Code:         "invalid_json",
				ErrorMessage: "消息解析失败。",
			})
			continue
		}
		api.handleClientMessage(roomID, clientID, connectionID, tx, message)
	}
}

func writePump(conn *websocket.Conn, tx *realtime.ClientTx, logger *slog.Logger) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = conn.Close()
	}()
	for {
		select {
		case payload, ok := <-tx.C():
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				logger.Warn("websocket write failed", "error", err)
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (api *API) sendRoomSnapshot(roomID, clientID string, tx *realtime.ClientTx, peers []protocol.RoomPeer) {
	history, err := api.messages.ListVisibleMessages(context.Background(), roomID, clientID)
	if err != nil {
		api.logger.Error("load visible messages failed", "room_id", roomID, "client_id", clientID, "error", err)
		history = []protocol.ChatMessage{}
	}
	api.hub.SendJSON(tx, protocol.ServerToClientMessage{
		Type:       "room-snapshot",
		RoomID:     roomID,
		Peers:      peers,
		Messages:   history,
		ServerTime: util.NowMS(),
	})
}

func (api *API) removePeer(roomID, clientID, connectionID string) {
	removed := api.hub.LeaveRoom(roomID, clientID, connectionID)
	if removed {
		api.hub.Broadcast(roomID, &clientID, nil, protocol.ServerToClientMessage{
			Type:     "peer-left",
			ClientID: clientID,
		})
	}
}

func (api *API) handleClientMessage(roomID, clientID, connectionID string, tx *realtime.ClientTx, payload protocol.ClientToServerMessage) {
	switch payload.Type {
	case "ping":
		api.hub.SendJSON(tx, protocol.ServerToClientMessage{Type: "pong", ServerTime: util.NowMS()})
	case "set-profile":
		api.renamePeer(roomID, clientID, connectionID, payload.Nickname)
	case "chat-send":
		api.handleChatSend(roomID, clientID, connectionID, tx, payload.Text, optionalString(payload.TargetID))
	case "signal":
		if payload.Payload != nil {
			api.forwardSignal(roomID, clientID, connectionID, payload.TargetID, *payload.Payload)
		}
	case "relay-file-announced":
		if payload.File != nil {
			api.handleRelayFile(roomID, clientID, connectionID, *payload.File, tx)
		}
	}
}

func (api *API) renamePeer(roomID, clientID, connectionID, nickname string) {
	peer, ok := api.hub.RenamePeer(roomID, clientID, connectionID, nickname)
	if !ok {
		return
	}
	api.hub.Broadcast(roomID, nil, nil, protocol.ServerToClientMessage{
		Type: "peer-joined",
		Peer: peer,
	})
}

func (api *API) handleChatSend(roomID, clientID, connectionID string, tx *realtime.ClientTx, text string, targetID *string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if len([]byte(text)) > protocol.MaxChatTextBytes {
		api.hub.SendJSON(tx, protocol.ServerToClientMessage{
			Type:         "error",
			Code:         "chat_text_too_large",
			ErrorMessage: "文字内容太长，请拆成多条发送或作为文件发送。",
		})
		return
	}
	if !api.hub.IsCurrentConnection(roomID, clientID, connectionID) {
		return
	}
	fromName, ok := api.hub.DisplayNameFor(roomID, clientID)
	if !ok {
		return
	}
	normalizedTarget := messages.NormalizeTargetID(clientID, targetID)
	if normalizedTarget != nil && !api.hub.IsClientConnected(roomID, *normalizedTarget) {
		normalizedTarget = nil
	}
	recipients := recipientsFor(normalizedTarget, clientID)
	message, err := api.messages.PersistTextMessage(context.Background(), roomID, clientID, fromName, normalizedTarget, text)
	if err != nil {
		api.logger.Error("persist text message failed", "room_id", roomID, "client_id", clientID, "error", err)
		api.hub.SendJSON(tx, protocol.ServerToClientMessage{
			Type:         "error",
			Code:         "chat_text_persist_failed",
			ErrorMessage: "文字发送失败，请稍后重试。",
		})
		return
	}
	api.hub.Broadcast(roomID, nil, recipients, protocol.ServerToClientMessage{
		Type:    "chat-event",
		Message: &message,
	})
}

func (api *API) forwardSignal(roomID, fromID, connectionID, targetID string, payload protocol.SignalEnvelope) {
	if !api.hub.IsCurrentConnection(roomID, fromID, connectionID) {
		return
	}
	target := api.hub.ResolveSignalTarget(roomID, fromID, connectionID, targetID)
	if target == nil {
		return
	}
	api.hub.SendJSON(target, protocol.ServerToClientMessage{
		Type:    "signal",
		FromID:  fromID,
		Payload: &payload,
	})
}

func (api *API) handleRelayFile(roomID, clientID, connectionID string, file protocol.RelayFileAnnouncement, tx *realtime.ClientTx) {
	if !api.hub.IsCurrentConnection(roomID, clientID, connectionID) {
		return
	}
	fromName, ok := api.hub.DisplayNameFor(roomID, clientID)
	if !ok {
		return
	}
	normalizedTarget := messages.NormalizeTargetID(clientID, file.TargetID)
	if normalizedTarget != nil && !api.hub.IsClientConnected(roomID, *normalizedTarget) {
		normalizedTarget = nil
	}
	recipients := recipientsFor(normalizedTarget, clientID)
	outcome, err := api.messages.PersistConfirmedRelayFileMessage(context.Background(), roomID, clientID, fromName, normalizedTarget, file)
	if err != nil {
		api.hub.SendJSON(tx, protocol.ServerToClientMessage{
			Type:         "error",
			Code:         "relay_file_announce_failed",
			ErrorMessage: "relay 文件确认失败。",
		})
		return
	}
	event := protocol.ServerToClientMessage{Type: "chat-event", Message: &outcome.Message}
	if outcome.Created {
		api.hub.Broadcast(roomID, nil, recipients, event)
		return
	}
	api.hub.SendJSON(tx, event)
}
