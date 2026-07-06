package protocol

import "encoding/json"

const MaxChatTextBytes = 1024 * 1024

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   *string  `json:"username,omitempty"`
	Credential *string  `json:"credential,omitempty"`
}

type SessionResponse struct {
	ClientID                 string      `json:"clientId"`
	Nickname                 string      `json:"nickname"`
	IceServers               []IceServer `json:"iceServers"`
	RelayFileLimitBytes      uint64      `json:"relayFileLimitBytes"`
	DirectFileSoftLimitBytes uint64      `json:"directFileSoftLimitBytes"`
	RecommendedTransferMode  string      `json:"recommendedTransferMode"`
}

type RoomPeer struct {
	ClientID string `json:"clientId"`
	Nickname string `json:"nickname"`
	JoinedAt uint64 `json:"joinedAt"`
}

type RelayFileDescriptor struct {
	FileID      string  `json:"fileId"`
	FileName    string  `json:"fileName"`
	Size        uint64  `json:"size"`
	ContentType string  `json:"contentType"`
	ObjectKey   string  `json:"objectKey"`
	FromID      string  `json:"fromId"`
	FromName    string  `json:"fromName"`
	CreatedAt   uint64  `json:"createdAt"`
	TargetID    *string `json:"targetId"`
	Previewable bool    `json:"previewable"`
}

type RelayFileAnnouncement struct {
	FileID      string  `json:"fileId"`
	FileName    string  `json:"fileName"`
	Size        uint64  `json:"size"`
	ContentType string  `json:"contentType"`
	ObjectKey   string  `json:"objectKey"`
	TargetID    *string `json:"targetId"`
	Previewable bool    `json:"previewable"`
}

type MessageKind string

const (
	MessageKindText      MessageKind = "text"
	MessageKindRelayFile MessageKind = "relay-file"
)

type MessageTransport string

const (
	MessageTransportServerSync  MessageTransport = "server-sync"
	MessageTransportServerRelay MessageTransport = "server-relay"
)

type ChatMessage struct {
	ID        string               `json:"id"`
	RoomID    string               `json:"roomId"`
	Kind      MessageKind          `json:"kind"`
	FromID    string               `json:"fromId"`
	FromName  string               `json:"fromName"`
	TargetID  *string              `json:"targetId"`
	CreatedAt uint64               `json:"createdAt"`
	Transport MessageTransport     `json:"transport"`
	Text      *string              `json:"text,omitempty"`
	File      *RelayFileDescriptor `json:"file,omitempty"`
}

type SignalEnvelope struct {
	Description json.RawMessage `json:"description,omitempty"`
	Candidate   json.RawMessage `json:"candidate,omitempty"`
}

type ThreadClearedPayload struct {
	TargetID          *string `json:"targetId"`
	ActorID           string  `json:"actorId"`
	ActorName         string  `json:"actorName"`
	RemovedMessages   int     `json:"removedMessages"`
	RemovedRelayFiles int     `json:"removedRelayFiles"`
}

type ClearThreadRequest struct {
	TargetID *string `json:"targetId"`
}

type ClearThreadResponse struct {
	TargetID          *string `json:"targetId"`
	RemovedMessages   int     `json:"removedMessages"`
	RemovedRelayFiles int     `json:"removedRelayFiles"`
}

type RelayUploadRequest struct {
	ClientRequestID *string `json:"clientRequestId"`
	RoomID          string  `json:"roomId"`
	FileName        string  `json:"fileName"`
	ContentType     string  `json:"contentType"`
	Size            uint64  `json:"size"`
	TargetID        *string `json:"targetId"`
}

type RelayUploadResponse struct {
	FileID         string              `json:"fileId"`
	ObjectKey      string              `json:"objectKey"`
	UploadToken    string              `json:"uploadToken"`
	ChunkSizeBytes uint64              `json:"chunkSizeBytes"`
	UploadedParts  []RelayUploadedPart `json:"uploadedParts"`
	Parts          []RelayUploadPart   `json:"parts"`
}

type RelayUploadedPart struct {
	PartNumber int    `json:"partNumber"`
	Etag       string `json:"etag"`
}

type RelayUploadPart struct {
	PartNumber int    `json:"partNumber"`
	UploadURL  string `json:"uploadUrl"`
}

type RelayUploadPartResponse struct {
	PartNumber int    `json:"partNumber"`
	Etag       string `json:"etag"`
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

type RelayUploadStoredResponse struct {
	FileID    string `json:"fileId"`
	ObjectKey string `json:"objectKey"`
}

type RelayAbortUploadRequest struct {
	UploadToken string `json:"uploadToken"`
}

type RelayDiscardUploadRequest struct {
	UploadToken string `json:"uploadToken"`
}

type ServerToClientMessage struct {
	Type              string          `json:"type"`
	RoomID            string          `json:"roomId,omitempty"`
	Peers             []RoomPeer      `json:"peers,omitempty"`
	Messages          []ChatMessage   `json:"messages,omitempty"`
	ServerTime        uint64          `json:"serverTime,omitempty"`
	Peer              *RoomPeer       `json:"peer,omitempty"`
	ClientID          string          `json:"clientId,omitempty"`
	Message           *ChatMessage    `json:"message,omitempty"`
	TargetID          *string         `json:"targetId,omitempty"`
	ActorID           string          `json:"actorId,omitempty"`
	ActorName         string          `json:"actorName,omitempty"`
	RemovedMessages   int             `json:"removedMessages,omitempty"`
	RemovedRelayFiles int             `json:"removedRelayFiles,omitempty"`
	FromID            string          `json:"fromId,omitempty"`
	Payload           *SignalEnvelope `json:"payload,omitempty"`
	Code              string          `json:"code,omitempty"`
	ErrorMessage      string          `json:"message,omitempty"`
}

type ClientToServerMessage struct {
	Type     string                 `json:"type"`
	Nickname string                 `json:"nickname,omitempty"`
	Text     string                 `json:"text,omitempty"`
	TargetID string                 `json:"targetId,omitempty"`
	Payload  *SignalEnvelope        `json:"payload,omitempty"`
	File     *RelayFileAnnouncement `json:"file,omitempty"`
}

func IsPreviewableImage(contentType string) bool {
	return len(contentType) >= 6 && contentType[:6] == "image/"
}
