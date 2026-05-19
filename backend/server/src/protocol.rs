#![allow(non_snake_case)]

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionResponse {
    pub clientId: String,
    pub nickname: String,
    pub iceServers: Vec<IceServer>,
    pub relayFileLimitBytes: u64,
    pub directFileSoftLimitBytes: u64,
    pub recommendedTransferMode: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomPeer {
    pub clientId: String,
    pub nickname: String,
    pub joinedAt: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayFileDescriptor {
    pub fileId: String,
    pub fileName: String,
    pub size: u64,
    pub contentType: String,
    pub objectKey: String,
    pub fromId: String,
    pub fromName: String,
    pub createdAt: u64,
    pub targetId: Option<String>,
    pub previewable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayFileAnnouncement {
    pub fileId: String,
    pub fileName: String,
    pub size: u64,
    pub contentType: String,
    pub objectKey: String,
    pub targetId: Option<String>,
    #[serde(default)]
    pub previewable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MessageKind {
    Text,
    RelayFile,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::RelayFile => "relay-file",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "text" => Ok(Self::Text),
            "relay-file" => Ok(Self::RelayFile),
            _ => bail!("unsupported message kind: {value}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MessageTransport {
    ServerSync,
    ServerRelay,
}

impl MessageTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ServerSync => "server-sync",
            Self::ServerRelay => "server-relay",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "server-sync" => Ok(Self::ServerSync),
            "server-relay" => Ok(Self::ServerRelay),
            _ => bail!("unsupported message transport: {value}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub roomId: String,
    pub kind: MessageKind,
    pub fromId: String,
    pub fromName: String,
    pub targetId: Option<String>,
    pub createdAt: u64,
    pub transport: MessageTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<RelayFileDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalEnvelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadClearedPayload {
    pub targetId: Option<String>,
    pub actorId: String,
    pub actorName: String,
    pub removedMessages: usize,
    pub removedRelayFiles: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClearThreadRequest {
    #[serde(default)]
    pub targetId: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClearThreadResponse {
    pub targetId: Option<String>,
    pub removedMessages: usize,
    pub removedRelayFiles: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayUploadRequest {
    #[serde(default)]
    pub clientRequestId: Option<String>,
    pub roomId: String,
    pub fileName: String,
    pub contentType: String,
    pub size: u64,
    #[serde(default)]
    pub targetId: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayUploadResponse {
    pub fileId: String,
    pub objectKey: String,
    pub uploadToken: String,
    pub chunkSizeBytes: u64,
    #[serde(default)]
    pub uploadedParts: Vec<RelayUploadedPart>,
    pub partUrls: Vec<RelayPresignedPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayUploadedPart {
    pub partNumber: i32,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayPresignedPart {
    pub partNumber: i32,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<RelayPresignedHeader>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayPresignedHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayUploadPartResponse {
    pub partNumber: i32,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayUploadPartAckRequest {
    pub uploadToken: String,
    pub part: RelayUploadedPart,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayCompleteUploadRequest {
    pub uploadToken: String,
    pub parts: Vec<RelayUploadedPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayCompleteUploadResponse {
    pub fileId: String,
    pub objectKey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayAbortUploadRequest {
    pub uploadToken: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayDiscardUploadRequest {
    pub uploadToken: String,
}

#[derive(Debug, Clone, Serialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "type")]
pub enum ServerToClientMessage {
    #[serde(rename = "room-snapshot")]
    RoomSnapshot {
        roomId: String,
        peers: Vec<RoomPeer>,
        messages: Vec<ChatMessage>,
        serverTime: u64,
    },
    #[serde(rename = "peer-joined")]
    PeerJoined { peer: RoomPeer },
    #[serde(rename = "peer-left")]
    PeerLeft { clientId: String },
    #[serde(rename = "chat-event")]
    ChatEvent { message: ChatMessage },
    #[serde(rename = "thread-cleared")]
    ThreadCleared {
        targetId: Option<String>,
        actorId: String,
        actorName: String,
        removedMessages: usize,
        removedRelayFiles: usize,
    },
    #[serde(rename = "signal")]
    Signal {
        fromId: String,
        payload: SignalEnvelope,
    },
    #[serde(rename = "pong")]
    Pong { serverTime: u64 },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ClientToServerMessage {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "set-profile")]
    SetProfile { nickname: String },
    #[serde(rename = "chat-send")]
    ChatSend {
        text: String,
        #[serde(default)]
        targetId: Option<String>,
    },
    #[serde(rename = "signal")]
    Signal {
        targetId: String,
        payload: SignalEnvelope,
    },
    #[serde(rename = "relay-file-announced")]
    RelayFileAnnounced { file: RelayFileAnnouncement },
}

pub fn is_previewable_image(content_type: &str) -> bool {
    content_type.starts_with("image/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_kind_serializes_as_legacy_wire_string() {
        let encoded = serde_json::to_string(&MessageKind::RelayFile).unwrap();
        assert_eq!(encoded, "\"relay-file\"");
        assert_eq!(
            serde_json::from_str::<MessageKind>(&encoded).unwrap(),
            MessageKind::RelayFile
        );
    }

    #[test]
    fn message_transport_serializes_as_legacy_wire_string() {
        let encoded = serde_json::to_string(&MessageTransport::ServerRelay).unwrap();
        assert_eq!(encoded, "\"server-relay\"");
        assert_eq!(
            serde_json::from_str::<MessageTransport>(&encoded).unwrap(),
            MessageTransport::ServerRelay
        );
    }
}
