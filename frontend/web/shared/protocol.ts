export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface SessionResponse {
  clientId: string;
  nickname: string;
  sessionToken?: string;
  iceServers: IceServer[];
  maxUploadBytes: number;
  historyPageSize: number;
}

export interface Peer {
  clientId: string;
  nickname: string;
  joinedAt: number;
}

export interface FileInfo {
  id: string;
  fileName: string;
  size: number;
  contentType: string;
  url: string;
  previewable: boolean;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  kind: 'text' | 'file';
  senderId: string;
  senderName: string;
  targetId: string | null;
  text?: string;
  file?: FileInfo;
  createdAt: number;
}

export interface ServerEvent {
  type: 'presence' | 'message' | 'messages-cleared' | 'signal';
  roomId?: string;
  peers?: Peer[];
  message?: ChatMessage;
  fromId?: string;
  payload?: SignalEnvelope;
  actorId?: string;
  targetId?: string | null;
  removed?: number;
  error?: string;
}

export interface SendMessageRequest {
  text: string;
  targetId?: string | null;
}

export interface SignalEnvelope {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export interface WebRTCSignalPayload {
  targetId?: string;
  fromId?: string;
  signal: SignalEnvelope;
}

export interface ClientSignalMessage {
  type: 'signal';
  targetId: string;
  payload: SignalEnvelope;
}

export interface UserView {
  id: string;
  nickname: string;
}

export interface RoomSummary {
  id: string;
  displayName: string;
  lastMessageText?: string;
  lastMessageAt: number;
  unreadCount: number;
  updatedAt: number;
}

export interface RoomMemberView {
  userId: string;
  nickname: string;
  role: string;
  joinedAt: number;
  lastSeenAt: number;
  online: boolean;
}

export interface ConversationView {
  id: string;
  roomId: string;
  type: 'room' | 'direct' | 'group' | string;
  title: string;
  peerUserId?: string;
  lastMessageId?: string;
  lastMessageText?: string;
  lastMessageAt: number;
  unreadCount: number;
  updatedAt: number;
}

export interface RoomDetail {
  id: string;
  displayName: string;
  members: RoomMemberView[];
  conversations: ConversationView[];
  updatedAt: number;
}

export interface AttachmentView {
  id: string;
  messageId: string;
  fileName: string;
  size: number;
  contentType: string;
  url: string;
  previewable: boolean;
  storageKind: 'local' | 'p2p' | 'pending' | string;
  createdAt: number;
}

export type MessageType = 'text' | 'image' | 'file' | 'system' | 'txt_file';

export interface MessageView {
  id: string;
  clientMessageId?: string;
  roomId: string;
  conversationId: string;
  type: MessageType;
  senderId: string;
  senderName: string;
  targetId?: string | null;
  text?: string;
  attachment?: AttachmentView;
  status: 'sending' | 'sent' | 'failed' | 'deleted' | 'revoked' | string;
  createdAt: number;
}

export interface EnvelopeError {
  code: string;
  message: string;
}

export interface Envelope<T = unknown> {
  type: string;
  request_id?: string;
  room_id?: string;
  conversation_id?: string;
  payload?: T;
  created_at: number;
  error?: EnvelopeError;
}

export interface RoomSnapshotPayload {
  room: RoomDetail;
  peers: Peer[];
}

export interface MemberUpdatedPayload {
  peers: Peer[];
}

export interface MessageCreatedPayload {
  message: MessageView;
}

export interface MessageAckPayload {
  clientMessageId?: string;
  message: MessageView;
}

export interface UnreadUpdatedPayload {
  conversation: ConversationView;
}

export interface RoomUpdatedPayload {
  room: RoomDetail;
}
