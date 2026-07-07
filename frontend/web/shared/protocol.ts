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

export interface ClientSignalMessage {
  type: 'signal';
  targetId: string;
  payload: SignalEnvelope;
}
