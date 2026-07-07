package protocol

import "encoding/json"

type TransferMode string

const (
	TransferModeAuto      TransferMode = "auto"
	TransferModeRelayOnly TransferMode = "relay-only"
)

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

	RelayFileLimitBytes      int64        `json:"relayFileLimitBytes"`
	DirectFileSoftLimitBytes int64        `json:"directFileSoftLimitBytes"`
	RecommendedTransferMode  TransferMode `json:"recommendedTransferMode"`
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

type MessageTransport string

const (
	MessageTransportServerSync  MessageTransport = "server-sync"
	MessageTransportServerRelay MessageTransport = "server-relay"
	MessageTransportDirectP2P   MessageTransport = "direct-p2p"
)

type RelayFileDescriptor struct {
	FileID      string  `json:"fileId"`
	FileName    string  `json:"fileName"`
	Size        int64   `json:"size"`
	ContentType string  `json:"contentType"`
	ObjectKey   string  `json:"objectKey"`
	FromID      string  `json:"fromId"`
	FromName    string  `json:"fromName"`
	CreatedAt   int64   `json:"createdAt"`
	TargetID    *string `json:"targetId"`
	Previewable bool    `json:"previewable"`
}

type LegacyMessage struct {
	ID        string               `json:"id"`
	RoomID    string               `json:"roomId"`
	Kind      string               `json:"kind"`
	FromID    string               `json:"fromId"`
	FromName  string               `json:"fromName"`
	TargetID  *string              `json:"targetId"`
	CreatedAt int64                `json:"createdAt"`
	Transport MessageTransport     `json:"transport"`
	Text      *string              `json:"text,omitempty"`
	File      *RelayFileDescriptor `json:"file,omitempty"`
}

func LegacyMessageFromMessage(message Message) LegacyMessage {
	legacy := LegacyMessage{
		ID:        message.ID,
		RoomID:    message.RoomID,
		Kind:      string(message.Kind),
		FromID:    message.SenderID,
		FromName:  message.SenderName,
		TargetID:  message.TargetID,
		CreatedAt: message.CreatedAt,
		Transport: MessageTransportServerSync,
		Text:      message.Text,
	}
	if message.Kind == MessageKindFile {
		legacy.Kind = "relay-file"
		legacy.Transport = MessageTransportServerRelay
	}
	if message.File != nil {
		legacy.File = &RelayFileDescriptor{
			FileID:      message.File.ID,
			FileName:    message.File.FileName,
			Size:        message.File.Size,
			ContentType: message.File.ContentType,
			ObjectKey:   message.File.ID,
			FromID:      message.SenderID,
			FromName:    message.SenderName,
			CreatedAt:   message.CreatedAt,
			TargetID:    message.TargetID,
			Previewable: message.File.Previewable,
		}
	}
	return legacy
}

func LegacyMessagesFromMessages(messages []Message) []LegacyMessage {
	legacy := make([]LegacyMessage, 0, len(messages))
	for _, message := range messages {
		legacy = append(legacy, LegacyMessageFromMessage(message))
	}
	return legacy
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
	Type     string                 `json:"type"`
	Nickname string                 `json:"nickname,omitempty"`
	Text     string                 `json:"text,omitempty"`
	TargetID string                 `json:"targetId,omitempty"`
	Payload  *SignalEnvelope        `json:"payload,omitempty"`
	File     *RelayFileAnnouncement `json:"file,omitempty"`
}

type ServerToClientMessage struct {
	Type              string          `json:"type"`
	RoomID            string          `json:"roomId,omitempty"`
	Peers             []Peer          `json:"peers"`
	Messages          []LegacyMessage `json:"messages,omitempty"`
	Peer              *Peer           `json:"peer,omitempty"`
	ClientID          string          `json:"clientId,omitempty"`
	Message           any             `json:"message,omitempty"`
	FromID            string          `json:"fromId,omitempty"`
	Payload           *SignalEnvelope `json:"payload,omitempty"`
	ActorID           string          `json:"actorId,omitempty"`
	ActorName         string          `json:"actorName,omitempty"`
	TargetID          *string         `json:"targetId,omitempty"`
	Removed           int             `json:"removed,omitempty"`
	RemovedMessages   int             `json:"removedMessages,omitempty"`
	RemovedRelayFiles int             `json:"removedRelayFiles,omitempty"`
	ServerTime        int64           `json:"serverTime,omitempty"`
	Code              string          `json:"code,omitempty"`
	Error             string          `json:"error,omitempty"`
}

type ClearMessagesResponse struct {
	TargetID *string `json:"targetId"`
	Removed  int     `json:"removed"`
}

type ClearThreadResponse struct {
	TargetID          *string `json:"targetId"`
	RemovedMessages   int     `json:"removedMessages"`
	RemovedRelayFiles int     `json:"removedRelayFiles"`
}

type ClearThreadRequest struct {
	TargetID *string `json:"targetId"`
}

type RelayFileAnnouncement struct {
	FileID      string  `json:"fileId"`
	FileName    string  `json:"fileName"`
	Size        int64   `json:"size"`
	ContentType string  `json:"contentType"`
	ObjectKey   string  `json:"objectKey"`
	TargetID    *string `json:"targetId"`
	Previewable bool    `json:"previewable"`
}

type RelayUploadRequest struct {
	ClientRequestID *string `json:"clientRequestId"`
	RoomID          string  `json:"roomId"`
	FileName        string  `json:"fileName"`
	ContentType     string  `json:"contentType"`
	Size            int64   `json:"size"`
	TargetID        *string `json:"targetId"`
}

type RelayUploadResponse struct {
	FileID         string               `json:"fileId"`
	ObjectKey      string               `json:"objectKey"`
	UploadToken    string               `json:"uploadToken"`
	ChunkSizeBytes int64                `json:"chunkSizeBytes"`
	UploadedParts  []RelayUploadedPart  `json:"uploadedParts"`
	PartURLs       []RelayPresignedPart `json:"partUrls"`
}

type RelayUploadedPart struct {
	PartNumber int    `json:"partNumber"`
	ETag       string `json:"etag"`
}

type RelayPresignedPart struct {
	PartNumber int                    `json:"partNumber"`
	URL        string                 `json:"url"`
	Headers    []RelayPresignedHeader `json:"headers"`
}

type RelayPresignedHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type RelayUploadPartAckRequest struct {
	UploadToken string            `json:"uploadToken"`
	Part        RelayUploadedPart `json:"part"`
}

type RelayCompleteUploadRequest struct {
	UploadToken string              `json:"uploadToken"`
	Parts       []RelayUploadedPart `json:"parts"`
}

type RelayCompleteUploadResponse struct {
	FileID    string `json:"fileId"`
	ObjectKey string `json:"objectKey"`
}

type RelayAbortUploadRequest struct {
	UploadToken string `json:"uploadToken"`
}

type RelayDiscardUploadRequest struct {
	UploadToken string `json:"uploadToken"`
}
