import type { ChatMessage, RelayPresignedPart, RelayUploadPartResponse, TransferMode } from '@shared/protocol';
import type { TransferUpdate } from '@/lib/peer-mesh';

export interface UiMessage extends ChatMessage {
  localUrl?: string;
  savedToDisk?: boolean;
}

export interface TransferRow extends TransferUpdate {
  id: string;
  startedAt: number;
  speedBytesPerSecond?: number;
  lastProgressAt?: number;
  lastProgressBytes?: number;
}

export interface PendingAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

export interface RelayUploadTask {
  transferId: string;
  clientRequestId: string;
  fileName: string;
  uploadToken: string;
  roomId: string;
  targetId: string | null;
  peerId: string;
  peerName: string;
  file: File;
  chunkSizeBytes: number;
  totalBytes: number;
  totalParts: number;
  concurrency: number;
  partUrlsByNumber: Map<number, RelayPresignedPart>;
  pendingPartNumbers: number[];
  inFlightPartNumbers: Set<number>;
  uploadedParts: Map<number, RelayUploadPartResponse>;
  loadedByPart: Map<number, number>;
  displayedTransferredBytes: number;
  stage: 'uploading' | 'paused' | 'completing' | 'awaiting-sync' | 'failed';
  pauseReason: 'manual' | 'offline' | null;
  pauseGeneration: number;
  resumePromise: Promise<void> | null;
  resumeResolver: (() => void) | null;
  cancelled: boolean;
  xhrs: Set<XMLHttpRequest>;
}

export interface PendingRelayAbortTicket {
  uploadToken: string;
  createdAt: number;
}

export interface PendingRelayAnnounceTicket {
  uploadToken: string;
  roomId: string;
  fileId: string;
  fileName: string;
  size: number;
  contentType: string;
  objectKey: string;
  targetId: string | null;
  createdAt: number;
}

export type SocketStatus =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'paused'
  | 'closed'
  | 'error';

export type PeerPresenceStatus = 'online' | 'offline' | 'recovering' | 'unknown';

export type EffectiveTransferMode = TransferMode;
