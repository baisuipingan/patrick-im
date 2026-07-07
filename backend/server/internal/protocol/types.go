package protocol

import "encoding/json"

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type SessionResponse struct {
	ClientID        string      `json:"clientId"`
	Nickname        string      `json:"nickname"`
	SessionToken    string      `json:"sessionToken,omitempty"`
	IceServers      []IceServer `json:"iceServers"`
	MaxUploadBytes  int64       `json:"maxUploadBytes"`
	HistoryPageSize int         `json:"historyPageSize"`
}

type RenameSessionRequest struct {
	Nickname string `json:"nickname"`
}

type Peer struct {
	ClientID string `json:"clientId"`
	Nickname string `json:"nickname"`
	JoinedAt int64  `json:"joinedAt"`
}

type FileInfo struct {
	ID          string `json:"id"`
	FileName    string `json:"fileName"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
	URL         string `json:"url"`
	Previewable bool   `json:"previewable"`
}

type MessageKind string

const (
	MessageKindText MessageKind = "text"
	MessageKindFile MessageKind = "file"
)

type Message struct {
	ID         string      `json:"id"`
	RoomID     string      `json:"roomId"`
	Kind       MessageKind `json:"kind"`
	SenderID   string      `json:"senderId"`
	SenderName string      `json:"senderName"`
	TargetID   *string     `json:"targetId"`
	Text       *string     `json:"text,omitempty"`
	File       *FileInfo   `json:"file,omitempty"`
	CreatedAt  int64       `json:"createdAt"`
}

type SendMessageRequest struct {
	Text     string  `json:"text"`
	TargetID *string `json:"targetId"`
}

type SignalEnvelope struct {
	Description json.RawMessage `json:"description,omitempty"`
	Candidate   json.RawMessage `json:"candidate,omitempty"`
}

type ClientToServerMessage struct {
	Type     string          `json:"type"`
	TargetID string          `json:"targetId,omitempty"`
	Payload  *SignalEnvelope `json:"payload,omitempty"`
}

type ServerToClientMessage struct {
	Type     string          `json:"type"`
	RoomID   string          `json:"roomId,omitempty"`
	Peers    []Peer          `json:"peers"`
	Message  *Message        `json:"message,omitempty"`
	FromID   string          `json:"fromId,omitempty"`
	Payload  *SignalEnvelope `json:"payload,omitempty"`
	ActorID  string          `json:"actorId,omitempty"`
	TargetID *string         `json:"targetId,omitempty"`
	Removed  int             `json:"removed,omitempty"`
	Error    string          `json:"error,omitempty"`
}

type ClearMessagesResponse struct {
	TargetID *string `json:"targetId"`
	Removed  int     `json:"removed"`
}
