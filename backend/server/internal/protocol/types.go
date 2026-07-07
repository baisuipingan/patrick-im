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

type MessageType string

const (
	MessageTypeText    MessageType = "text"
	MessageTypeImage   MessageType = "image"
	MessageTypeFile    MessageType = "file"
	MessageTypeSystem  MessageType = "system"
	MessageTypeTxtFile MessageType = "txt_file"
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

type WebRTCSignalPayload struct {
	TargetID string         `json:"targetId,omitempty"`
	FromID   string         `json:"fromId,omitempty"`
	Signal   SignalEnvelope `json:"signal"`
}

type ClientToServerMessage struct {
	Type           string          `json:"type"`
	RequestID      string          `json:"request_id,omitempty"`
	RoomID         string          `json:"room_id,omitempty"`
	ConversationID string          `json:"conversation_id,omitempty"`
	TargetID       string          `json:"targetId,omitempty"`
	Payload        *SignalEnvelope `json:"payload,omitempty"`
	RawPayload     json.RawMessage `json:"-"`
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

type UserView struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
}

type RoomSummary struct {
	ID              string  `json:"id"`
	DisplayName     string  `json:"displayName"`
	LastMessageText *string `json:"lastMessageText,omitempty"`
	LastMessageAt   int64   `json:"lastMessageAt"`
	UnreadCount     int64   `json:"unreadCount"`
	UpdatedAt       int64   `json:"updatedAt"`
}

type RoomDetail struct {
	ID            string             `json:"id"`
	DisplayName   string             `json:"displayName"`
	Members       []RoomMemberView   `json:"members"`
	Conversations []ConversationView `json:"conversations"`
	UpdatedAt     int64              `json:"updatedAt"`
}

type RoomMemberView struct {
	UserID     string `json:"userId"`
	Nickname   string `json:"nickname"`
	Role       string `json:"role"`
	JoinedAt   int64  `json:"joinedAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
	Online     bool   `json:"online"`
}

type ConversationView struct {
	ID              string  `json:"id"`
	RoomID          string  `json:"roomId"`
	Type            string  `json:"type"`
	Title           string  `json:"title"`
	PeerUserID      *string `json:"peerUserId,omitempty"`
	LastMessageID   *string `json:"lastMessageId,omitempty"`
	LastMessageText *string `json:"lastMessageText,omitempty"`
	LastMessageAt   int64   `json:"lastMessageAt"`
	UnreadCount     int64   `json:"unreadCount"`
	UpdatedAt       int64   `json:"updatedAt"`
}

type AttachmentView struct {
	ID          string `json:"id"`
	MessageID   string `json:"messageId"`
	FileName    string `json:"fileName"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
	URL         string `json:"url"`
	Previewable bool   `json:"previewable"`
	StorageKind string `json:"storageKind"`
	CreatedAt   int64  `json:"createdAt"`
}

type MessageView struct {
	ID              string          `json:"id"`
	ClientMessageID *string         `json:"clientMessageId,omitempty"`
	RoomID          string          `json:"roomId"`
	ConversationID  string          `json:"conversationId"`
	Type            MessageType     `json:"type"`
	SenderID        string          `json:"senderId"`
	SenderName      string          `json:"senderName"`
	TargetID        *string         `json:"targetId,omitempty"`
	Text            *string         `json:"text,omitempty"`
	Attachment      *AttachmentView `json:"attachment,omitempty"`
	Status          string          `json:"status"`
	CreatedAt       int64           `json:"createdAt"`
}

type CreateRoomRequest struct {
	RoomID string `json:"roomId"`
}

type CreateDirectConversationRequest struct {
	PeerUserID string `json:"peerUserId"`
}

type CreateConversationMessageRequest struct {
	ClientMessageID *string     `json:"clientMessageId"`
	Type            MessageType `json:"type"`
	Text            string      `json:"text"`
}

type MarkReadRequest struct {
	LastReadMessageID *string `json:"lastReadMessageId"`
	LastReadAt        int64   `json:"lastReadAt"`
}

type RoomSnapshotPayload struct {
	Room  RoomDetail `json:"room"`
	Peers []Peer     `json:"peers"`
}

type MemberUpdatedPayload struct {
	Peers []Peer `json:"peers"`
}

type MessageCreatedPayload struct {
	Message MessageView `json:"message"`
}

type MessageAckPayload struct {
	ClientMessageID *string     `json:"clientMessageId,omitempty"`
	Message         MessageView `json:"message"`
}

type UnreadUpdatedPayload struct {
	Conversation ConversationView `json:"conversation"`
}

type RoomUpdatedPayload struct {
	Room RoomDetail `json:"room"`
}

type EnvelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Envelope struct {
	Type           string          `json:"type"`
	RequestID      string          `json:"request_id,omitempty"`
	RoomID         string          `json:"room_id,omitempty"`
	ConversationID string          `json:"conversation_id,omitempty"`
	Payload        json.RawMessage `json:"payload,omitempty"`
	CreatedAt      int64           `json:"created_at"`
	Error          *EnvelopeError  `json:"error,omitempty"`
}

func NewEnvelope(eventType, requestID, roomID, conversationID string, payload any, createdAt int64) Envelope {
	envelope := Envelope{
		Type:           eventType,
		RequestID:      requestID,
		RoomID:         roomID,
		ConversationID: conversationID,
		CreatedAt:      createdAt,
	}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err == nil {
			envelope.Payload = raw
		}
	}
	return envelope
}
