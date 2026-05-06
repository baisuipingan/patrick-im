export type TransferMode = 'auto' | 'relay-only';
export type DirectPeerState = 'offline' | 'connecting' | 'connected' | 'failed';

export interface SessionResponse {
  clientId: string;
  nickname: string;
  iceServers: RTCIceServer[];
  relayFileLimitBytes: number;
  directFileSoftLimitBytes: number;
  recommendedTransferMode: TransferMode;
}

export interface RoomPeer {
  clientId: string;
  nickname: string;
  joinedAt: number;
}

export interface RelayFileDescriptor {
  fileId: string;
  fileName: string;
  size: number;
  contentType: string;
  objectKey: string;
  fromId: string;
  fromName: string;
  createdAt: number;
  targetId: string | null;
  previewable: boolean;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  kind: 'text' | 'relay-file' | 'system' | 'direct-file';
  fromId: string;
  fromName: string;
  targetId: string | null;
  createdAt: number;
  transport: 'server-sync' | 'server-relay' | 'direct-p2p';
  text?: string;
  file?: RelayFileDescriptor;
}

export interface RoomSnapshotMessage {
  type: 'room-snapshot';
  roomId: string;
  peers: RoomPeer[];
  messages: ChatMessage[];
  serverTime: number;
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
  peer: RoomPeer;
}

export interface PeerLeftMessage {
  type: 'peer-left';
  clientId: string;
}

export interface ChatEventMessage {
  type: 'chat-event';
  message: ChatMessage;
}

export interface ThreadClearedMessage {
  type: 'thread-cleared';
  targetId: string | null;
  actorId: string;
  actorName: string;
  removedMessages: number;
  removedRelayFiles: number;
}

export interface SignalEnvelope {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export interface SignalMessage {
  type: 'signal';
  fromId: string;
  payload: SignalEnvelope;
}

export interface PongMessage {
  type: 'pong';
  serverTime: number;
}

export interface ServerErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type ServerToClientMessage =
  | RoomSnapshotMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | ChatEventMessage
  | ThreadClearedMessage
  | SignalMessage
  | PongMessage
  | ServerErrorMessage;

export interface SetProfileMessage {
  type: 'set-profile';
  nickname: string;
}

export interface ChatSendMessage {
  type: 'chat-send';
  text: string;
  targetId?: string | null;
}

export interface SignalForwardMessage {
  type: 'signal';
  targetId: string;
  payload: SignalEnvelope;
}

export interface RelayFileAnnounceMessage {
  type: 'relay-file-announced';
  file: {
    fileId: string;
    fileName: string;
    size: number;
    contentType: string;
    objectKey: string;
    targetId: string | null;
  };
}

export interface PingMessage {
  type: 'ping';
}

export interface ClearThreadRequest {
  targetId: string | null;
}

export interface ClearThreadResponse {
  targetId: string | null;
  removedMessages: number;
  removedRelayFiles: number;
}

export type ClientToServerMessage =
  | SetProfileMessage
  | ChatSendMessage
  | SignalForwardMessage
  | RelayFileAnnounceMessage
  | PingMessage;

export interface RelayUploadRequest {
  roomId: string;
  fileName: string;
  contentType: string;
  size: number;
  targetId: string | null;
}

export interface RelayUploadResponse {
  fileId: string;
  objectKey: string;
  uploadToken: string;
  chunkSizeBytes: number;
  partUrls: RelayPresignedPart[];
}

export interface RelayUploadedPart {
  partNumber: number;
  etag: string;
}

export interface RelayPresignedHeader {
  name: string;
  value: string;
}

export interface RelayPresignedPart {
  partNumber: number;
  url: string;
  headers: RelayPresignedHeader[];
}

export interface RelayUploadPartResponse {
  partNumber: number;
  etag: string;
}

export interface RelayCompleteUploadRequest {
  uploadToken: string;
  parts: RelayUploadedPart[];
}

export interface RelayAbortUploadRequest {
  uploadToken: string;
}

export interface RelayDiscardUploadRequest {
  uploadToken: string;
}

export interface DirectFileOfferMessage {
  type: 'direct-file-offer';
  transferId: string;
  fileName: string;
  contentType: string;
  size: number;
}

export interface DirectFileAcceptMessage {
  type: 'direct-file-accept';
  transferId: string;
}

export interface DirectFileDeclineMessage {
  type: 'direct-file-decline';
  transferId: string;
  reason?: string;
}

export interface DirectFileReceivedMessage {
  type: 'direct-file-received';
  transferId: string;
}

export interface DirectFileCompleteMessage {
  type: 'direct-file-complete';
  transferId: string;
}

export interface DirectFileFailedMessage {
  type: 'direct-file-failed';
  transferId: string;
  reason?: string;
}

export interface DirectFileCancelMessage {
  type: 'direct-file-cancel';
  transferId: string;
  reason?: string;
}

export type DirectChannelControlMessage =
  | DirectFileOfferMessage
  | DirectFileAcceptMessage
  | DirectFileDeclineMessage
  | DirectFileReceivedMessage
  | DirectFileCompleteMessage
  | DirectFileFailedMessage
  | DirectFileCancelMessage;

export function isPreviewableImage(contentType: string): boolean {
  return contentType.startsWith('image/');
}
