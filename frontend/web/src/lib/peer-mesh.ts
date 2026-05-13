import type {
  DirectChannelControlMessage,
  DirectPeerState,
  DirectFileAcceptMessage,
  DirectFileCancelMessage,
  DirectFileCompleteMessage,
  DirectFileDeclineMessage,
  DirectFileFailedMessage,
  DirectFileOfferMessage,
  DirectFileReceivedMessage,
  RoomPeer,
  SignalEnvelope,
} from '@shared/protocol';
import { sleep } from './utils';

const FILE_CHANNEL_PREFIX = 'file:';
const DIRECT_FILE_HARD_LIMIT_BYTES = Number.MAX_SAFE_INTEGER;
const DIRECT_FILE_CHUNK_BYTES = 64 * 1024;
const BUFFER_LIMIT_BYTES = 1024 * 1024;
const RECEIVER_CONFIRM_DELIVERY_SOFT_TIMEOUT_MS = 20_000;
const RECEIVER_CONFIRM_FINALIZE_SOFT_TIMEOUT_MS = 45_000;
const RECEIVER_CONFIRM_HARD_TIMEOUT_MS = 10 * 60_000;
const CANCEL_GRACE_WINDOW_MS = 180;

interface TransferUpdate {
  transferId: string;
  peerId: string;
  peerName: string;
  fileName: string;
  totalBytes: number;
  transferredBytes: number;
  direction: 'upload' | 'download';
  transport: 'direct-p2p' | 'server-relay';
  status: 'pending' | 'paused' | 'streaming' | 'complete' | 'failed' | 'declined' | 'cancelled';
  note?: string;
}

interface IncomingFilePayload {
  transferId: string;
  remoteId: string;
  remoteName: string;
  fileName: string;
  contentType: string;
  size: number;
  blob?: Blob;
  savedToDisk: boolean;
}

interface IncomingFileTarget {
  mode: 'memory' | 'disk';
  fileHandle?: FileSystemFileHandle;
  writer?: FileSystemWritableFileStream;
}

interface IncomingFilePreparation {
  transferId: string;
  remoteId: string;
  remoteName: string;
  fileName: string;
  contentType: string;
  size: number;
}

interface PeerMeshCallbacks {
  directFileSoftLimitBytes: number;
  localClientId: string;
  iceServers: RTCIceServer[];
  prepareIncomingFileTarget: (payload: IncomingFilePreparation) => Promise<IncomingFileTarget>;
  onIncomingFile: (payload: IncomingFilePayload) => void;
  onPeerPathChange: (peerId: string, path: DirectPathInfo | null) => void;
  onPeerStateChange: (peerId: string, nextState: DirectPeerState) => void;
  onTransferUpdate: (update: TransferUpdate) => void;
  sendSignal: (targetId: string, payload: SignalEnvelope) => void;
}

type DirectPathKind = 'lan' | 'stun' | 'turn' | 'unknown';

interface DirectPathInfo {
  kind: DirectPathKind;
  localCandidateType?: string;
  remoteCandidateType?: string;
  protocol?: string;
  localAddress?: string;
  remoteAddress?: string;
  roundTripTimeMs?: number;
}

interface OutgoingTransfer {
  file: File;
  transferId: string;
  sentBytes: number;
  channel?: RTCDataChannel;
  cancelled?: boolean;
  cancelNotified?: boolean;
  confirmSoftTimeoutId?: number;
  confirmHardTimeoutId?: number;
  receiverReceivedFile?: boolean;
}

interface IncomingTransfer {
  transferId: string;
  fileName: string;
  contentType: string;
  size: number;
  receivedBytes: number;
  mode: 'memory' | 'disk';
  chunks: ArrayBuffer[];
  fileHandle?: FileSystemFileHandle;
  writer?: FileSystemWritableFileStream;
  writeChain: Promise<void>;
  channel?: RTCDataChannel;
  cancelled?: boolean;
  receivedNoticeSent?: boolean;
  finishing?: boolean;
}

interface PeerSession {
  peer: RoomPeer;
  pc: RTCPeerConnection;
  control?: RTCDataChannel;
  outgoingTransfers: Map<string, OutgoingTransfer>;
  incomingTransfers: Map<string, IncomingTransfer>;
  pendingCandidates: RTCIceCandidateInit[];
  pathInfoKey?: string;
  pathPollTimerId?: number;
  lastLocalLanCandidate?: ParsedIceCandidate;
  lastRemoteLanCandidate?: ParsedIceCandidate;
}

function getBinarySize(chunk: ArrayBuffer | Blob): number {
  return chunk instanceof Blob ? chunk.size : chunk.byteLength;
}

function clearTransferTimeout(transfer: OutgoingTransfer): void {
  if (transfer.confirmSoftTimeoutId) {
    clearTimeout(transfer.confirmSoftTimeoutId);
    delete transfer.confirmSoftTimeoutId;
  }

  if (transfer.confirmHardTimeoutId) {
    clearTimeout(transfer.confirmHardTimeoutId);
    delete transfer.confirmHardTimeoutId;
  }
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError' || error.name === 'InvalidStateError'
    : false;
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function buildPathInfoKey(path: DirectPathInfo | null): string {
  if (!path) {
    return 'none';
  }

  return `${path.kind}:${path.localCandidateType ?? '-'}:${path.remoteCandidateType ?? '-'}:${path.protocol ?? '-'}`;
}

function classifyDirectPath(
  localCandidateType?: string,
  remoteCandidateType?: string,
  localAddress?: string,
  remoteAddress?: string,
): DirectPathKind {
  if (localCandidateType === 'relay' || remoteCandidateType === 'relay') {
    return 'turn';
  }

  if (isDirectCandidateType(localCandidateType) || isDirectCandidateType(remoteCandidateType)) {
    return 'lan';
  }

  return 'unknown';
}

function isDirectCandidateType(candidateType?: string): boolean {
  return candidateType === 'host' || candidateType === 'srflx' || candidateType === 'prflx';
}

interface ParsedIceCandidate {
  candidateType?: string;
  address?: string;
  protocol?: string;
}

function parseIceCandidate(candidate?: RTCIceCandidateInit | RTCIceCandidate | null): ParsedIceCandidate {
  if (!candidate) {
    return {};
  }

  const raw = candidate as Record<string, unknown>;
  const directType = typeof raw.type === 'string' ? raw.type : undefined;
  const directAddress =
    typeof raw.address === 'string'
      ? raw.address
      : typeof raw.ip === 'string'
        ? raw.ip
        : undefined;
  const directProtocol = typeof raw.protocol === 'string' ? raw.protocol : undefined;

  const line = typeof candidate.candidate === 'string' ? candidate.candidate.trim() : '';
  if (!line) {
    return {
      candidateType: directType,
      address: directAddress,
      protocol: directProtocol,
    };
  }

  const parts = line.split(/\s+/);
  const protocol = directProtocol ?? parts[2];
  const address = directAddress ?? parts[4];
  const typeIndex = parts.indexOf('typ');
  const candidateType =
    directType ?? (typeIndex >= 0 && typeIndex + 1 < parts.length ? parts[typeIndex + 1] : undefined);

  return {
    candidateType,
    address,
    protocol,
  };
}

function isLanIceCandidate(candidate?: RTCIceCandidateInit | RTCIceCandidate | null): boolean {
  const parsed = parseIceCandidate(candidate);
  if (parsed.candidateType !== 'host') {
    return false;
  }

  if (!parsed.address) {
    return true;
  }

  return isMdnsHost(parsed.address) || isPrivateIpAddress(parsed.address);
}

function isLocalNetworkCandidate(candidateType?: string, address?: string): boolean {
  if (candidateType === 'host' && !address) {
    return true;
  }

  if (candidateType !== 'host' && candidateType !== 'prflx') {
    return false;
  }

  if (!address) {
    return false;
  }

  return isMdnsHost(address) || isPrivateIpAddress(address);
}

function isMdnsHost(value: string): boolean {
  return value.endsWith('.local');
}

function isPrivateIpAddress(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map((segment) => Number(segment));
    if ([a, b].some((segment) => Number.isNaN(segment))) {
      return false;
    }
    if (a === 10 || a === 127) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    return false;
  }

  const lower = normalized.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  );
}

function readCandidateAddress(candidate?: Record<string, unknown>): string | undefined {
  const direct = typeof candidate?.address === 'string' ? candidate.address : undefined;
  if (direct) {
    return direct;
  }

  return typeof candidate?.ip === 'string' ? candidate.ip : undefined;
}

export class PeerMesh {
  private readonly callbacks: PeerMeshCallbacks;

  private readonly sessions = new Map<string, PeerSession>();

  constructor(callbacks: PeerMeshCallbacks) {
    this.callbacks = callbacks;
  }

  ensurePeer(peer: RoomPeer): void {
    if (peer.clientId === this.callbacks.localClientId) {
      return;
    }

    const existing = this.sessions.get(peer.clientId);
    if (existing) {
      existing.peer = peer;
      return;
    }

    const pc = new RTCPeerConnection({
      iceServers: [],
    });
    const session: PeerSession = {
      peer,
      pc,
      outgoingTransfers: new Map(),
      incomingTransfers: new Map(),
      pendingCandidates: [],
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candidate = event.candidate.toJSON();
        if (!isLanIceCandidate(candidate)) {
          return;
        }
        session.lastLocalLanCandidate = parseIceCandidate(candidate);
        this.callbacks.sendSignal(peer.clientId, {
          candidate,
        });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const nextState: DirectPeerState =
        state === 'connected'
          ? 'connected'
          : state === 'failed'
            ? 'failed'
            : state === 'closed' || state === 'disconnected'
              ? 'offline'
              : 'connecting';
      this.callbacks.onPeerStateChange(peer.clientId, nextState);
      if (nextState === 'connected') {
        this.startPathPolling(session);
      } else if (nextState === 'offline') {
        this.stopPathPolling(session);
        this.publishPathInfo(session, null);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this.callbacks.onPeerStateChange(peer.clientId, 'failed');
        this.stopPathPolling(session);
        this.publishPathInfo(session, null);
      }
    };
    pc.ondatachannel = (event) => {
      if (event.channel.label === 'control') {
        this.attachControlChannel(session, event.channel);
        return;
      }

      if (event.channel.label.startsWith(FILE_CHANNEL_PREFIX)) {
        this.attachIncomingFileChannel(session, event.channel);
      }
    };

    this.sessions.set(peer.clientId, session);
    this.callbacks.onPeerStateChange(peer.clientId, 'connecting');

    if (this.shouldInitiate(peer.clientId)) {
      const control = pc.createDataChannel('control');
      this.attachControlChannel(session, control);
      void this.createAndSendOffer(session);
    }
  }

  async handleSignal(remoteId: string, payload: SignalEnvelope, peerName?: string): Promise<void> {
    if (!this.sessions.has(remoteId)) {
      this.ensurePeer({
        clientId: remoteId,
        nickname: peerName ?? remoteId,
        joinedAt: Date.now(),
      });
    }

    const session = this.sessions.get(remoteId);
    if (!session) {
      return;
    }

    if (payload.description) {
      await session.pc.setRemoteDescription(payload.description);
      while (session.pendingCandidates.length > 0) {
        const candidate = session.pendingCandidates.shift();
        if (candidate) {
          await session.pc.addIceCandidate(candidate);
        }
      }
      if (payload.description.type === 'offer') {
        const answer = await session.pc.createAnswer();
        await session.pc.setLocalDescription(answer);
        this.callbacks.sendSignal(remoteId, {
          description: answer,
        });
      }
    }

    if (payload.candidate && isLanIceCandidate(payload.candidate)) {
      session.lastRemoteLanCandidate = parseIceCandidate(payload.candidate);
      if (session.pc.remoteDescription) {
        await session.pc.addIceCandidate(payload.candidate);
      } else {
        session.pendingCandidates.push(payload.candidate);
      }
    }
  }

  async sendDirectFile(peerId: string, file: File): Promise<string> {
    const session = this.sessions.get(peerId);
    if (!session || !session.control || session.control.readyState !== 'open') {
      throw new Error('peer is not ready for direct transfer');
    }

    const transferId = crypto.randomUUID();
    session.outgoingTransfers.set(transferId, {
      file,
      transferId,
      sentBytes: 0,
    });

    const updateBase = {
      transferId,
      peerId,
      peerName: session.peer.nickname,
      fileName: file.name,
      totalBytes: file.size,
      transferredBytes: 0,
      direction: 'upload' as const,
      transport: 'direct-p2p' as const,
    };

    this.callbacks.onTransferUpdate({
      ...updateBase,
      status: 'pending',
    });

    const offer: DirectFileOfferMessage = {
      type: 'direct-file-offer',
      transferId,
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    };
    session.control.send(JSON.stringify(offer));
    return transferId;
  }

  cancelTransfer(transferId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.outgoingTransfers.has(transferId)) {
        return this.cancelOutgoingTransfer(session, transferId, 'cancelled locally', 'cancelled_by_sender');
      }

      if (session.incomingTransfers.has(transferId)) {
        void this.cancelIncomingTransfer(session, transferId, 'cancelled locally', 'cancelled_by_receiver');
        return true;
      }
    }

    return false;
  }

  removePeer(peerId: string): void {
    const session = this.sessions.get(peerId);
    if (!session) {
      return;
    }
    this.stopPathPolling(session);
    this.publishPathInfo(session, null);
    session.control?.close();
    session.pc.close();
    this.sessions.delete(peerId);
    this.callbacks.onPeerStateChange(peerId, 'offline');
  }

  close(): void {
    for (const peerId of [...this.sessions.keys()]) {
      this.removePeer(peerId);
    }
  }

  private shouldInitiate(remoteId: string): boolean {
    return this.callbacks.localClientId.localeCompare(remoteId) > 0;
  }

  private async createAndSendOffer(session: PeerSession): Promise<void> {
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    this.callbacks.sendSignal(session.peer.clientId, {
      description: offer,
    });
  }

  private attachControlChannel(session: PeerSession, channel: RTCDataChannel): void {
    session.control = channel;
    channel.onopen = () => {
      this.callbacks.onPeerStateChange(session.peer.clientId, 'connected');
      this.startPathPolling(session);
    };
    channel.onclose = () => {
      this.stopPathPolling(session);
      this.publishPathInfo(session, null);
      this.callbacks.onPeerStateChange(session.peer.clientId, 'offline');
    };
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        return;
      }

      const message = safeJsonParse<DirectChannelControlMessage>(event.data);
      if (!message) {
        return;
      }

      switch (message.type) {
        case 'direct-file-offer':
          void this.handleIncomingOffer(session, message);
          break;
        case 'direct-file-accept':
          void this.handleAcceptedOffer(session, message);
          break;
        case 'direct-file-decline':
          this.handleDeclinedOffer(session, message);
          break;
        case 'direct-file-received':
          this.handleReceivedTransfer(session, message);
          break;
        case 'direct-file-complete':
          this.handleCompletedTransfer(session, message);
          break;
        case 'direct-file-failed':
          this.handleFailedTransfer(session, message);
          break;
        case 'direct-file-cancel':
          void this.handleCancelledTransfer(session, message);
          break;
        default:
          break;
      }
    };
  }

  private async handleIncomingOffer(session: PeerSession, message: DirectFileOfferMessage): Promise<void> {
    if (
      message.size > DIRECT_FILE_HARD_LIMIT_BYTES ||
      message.size > this.callbacks.directFileSoftLimitBytes
    ) {
      const decline: DirectFileDeclineMessage = {
        type: 'direct-file-decline',
        transferId: message.transferId,
        reason: 'file_too_large',
      };
      session.control?.send(JSON.stringify(decline));
      return;
    }

    let target: IncomingFileTarget = {
      mode: 'memory',
    };
    try {
      target = await this.callbacks.prepareIncomingFileTarget({
        transferId: message.transferId,
        remoteId: session.peer.clientId,
        remoteName: session.peer.nickname,
        fileName: message.fileName,
        contentType: message.contentType,
        size: message.size,
      });
    } catch {
      target = {
        mode: 'memory',
      };
    }

    session.incomingTransfers.set(message.transferId, {
      transferId: message.transferId,
      fileName: message.fileName,
      contentType: message.contentType,
      size: message.size,
      receivedBytes: 0,
      mode: target.mode,
      chunks: [],
      fileHandle: target.fileHandle,
      writer: target.writer,
      writeChain: Promise.resolve(),
    });

    const accept: DirectFileAcceptMessage = {
      type: 'direct-file-accept',
      transferId: message.transferId,
    };
    session.control?.send(JSON.stringify(accept));
    this.callbacks.onTransferUpdate({
      transferId: message.transferId,
      peerId: session.peer.clientId,
      peerName: session.peer.nickname,
      fileName: message.fileName,
      totalBytes: message.size,
      transferredBytes: 0,
      direction: 'download',
      transport: 'direct-p2p',
      status: 'pending',
    });
  }

  private async handleAcceptedOffer(session: PeerSession, message: DirectFileAcceptMessage): Promise<void> {
    const transfer = session.outgoingTransfers.get(message.transferId);
    if (!transfer) {
      return;
    }

    const channel = session.pc.createDataChannel(`${FILE_CHANNEL_PREFIX}${message.transferId}`);
    transfer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (transfer.cancelled || !session.outgoingTransfers.has(message.transferId)) {
        channel.close();
        return;
      }
      void this.streamOutgoingFile(session, channel, transfer);
    };
    channel.onerror = () => {
      if (transfer.cancelled || !session.outgoingTransfers.has(message.transferId)) {
        return;
      }
      this.failOutgoingTransfer(session, message.transferId, 'data channel error');
    };
  }

  private handleDeclinedOffer(session: PeerSession, message: DirectFileDeclineMessage): void {
    const transfer = session.outgoingTransfers.get(message.transferId);
    if (!transfer) {
      return;
    }

    this.callbacks.onTransferUpdate({
      transferId: message.transferId,
      peerId: session.peer.clientId,
      peerName: session.peer.nickname,
      fileName: transfer.file.name,
      totalBytes: transfer.file.size,
      transferredBytes: 0,
      direction: 'upload',
      transport: 'direct-p2p',
      status: 'declined',
      note: message.reason === 'file_too_large' ? 'receiver asked to use relay mode' : 'receiver declined',
    });
    clearTransferTimeout(transfer);
    session.outgoingTransfers.delete(message.transferId);
  }

  private emitOutgoingTransferUpdate(
    session: PeerSession,
    transfer: OutgoingTransfer,
    status: TransferUpdate['status'],
    note?: string,
  ): void {
    this.callbacks.onTransferUpdate({
      transferId: transfer.transferId,
      peerId: session.peer.clientId,
      peerName: session.peer.nickname,
      fileName: transfer.file.name,
      totalBytes: transfer.file.size,
      transferredBytes: transfer.sentBytes,
      direction: 'upload',
      transport: 'direct-p2p',
      status,
      note,
    });
  }

  private startReceiverConfirmationWatch(
    session: PeerSession,
    transfer: OutgoingTransfer,
    phase: 'delivery' | 'finalize',
  ): void {
    clearTransferTimeout(transfer);

    const softTimeout =
      phase === 'delivery'
        ? RECEIVER_CONFIRM_DELIVERY_SOFT_TIMEOUT_MS
        : RECEIVER_CONFIRM_FINALIZE_SOFT_TIMEOUT_MS;

    const softNote =
      phase === 'delivery'
        ? 'receiver confirmation is delayed'
        : 'receiver finalization is taking longer than expected';

    const hardNote =
      phase === 'delivery'
        ? 'receiver confirmation timed out'
        : 'receiver finalization timed out';

    transfer.confirmSoftTimeoutId = window.setTimeout(() => {
      if (transfer.cancelled || !session.outgoingTransfers.has(transfer.transferId)) {
        return;
      }

      this.emitOutgoingTransferUpdate(session, transfer, 'streaming', softNote);
    }, softTimeout);

    transfer.confirmHardTimeoutId = window.setTimeout(() => {
      if (transfer.cancelled || !session.outgoingTransfers.has(transfer.transferId)) {
        return;
      }

      this.failOutgoingTransfer(session, transfer.transferId, hardNote);
    }, RECEIVER_CONFIRM_HARD_TIMEOUT_MS);
  }

  private handleReceivedTransfer(session: PeerSession, message: DirectFileReceivedMessage): void {
    const transfer = session.outgoingTransfers.get(message.transferId);
    if (!transfer || transfer.receiverReceivedFile) {
      return;
    }

    transfer.receiverReceivedFile = true;
    this.emitOutgoingTransferUpdate(session, transfer, 'streaming', 'receiver is finalizing file');
    this.startReceiverConfirmationWatch(session, transfer, 'finalize');
  }

  private handleCompletedTransfer(session: PeerSession, message: DirectFileCompleteMessage): void {
    const transfer = session.outgoingTransfers.get(message.transferId);
    if (!transfer) {
      return;
    }

    clearTransferTimeout(transfer);
    this.callbacks.onTransferUpdate({
      transferId: message.transferId,
      peerId: session.peer.clientId,
      peerName: session.peer.nickname,
      fileName: transfer.file.name,
      totalBytes: transfer.file.size,
      transferredBytes: transfer.sentBytes,
      direction: 'upload',
      transport: 'direct-p2p',
      status: 'complete',
    });
    session.outgoingTransfers.delete(message.transferId);
  }

  private handleFailedTransfer(session: PeerSession, message: DirectFileFailedMessage): void {
    this.failOutgoingTransfer(session, message.transferId, message.reason ?? 'receiver reported failure');
  }

  private async handleCancelledTransfer(session: PeerSession, message: DirectFileCancelMessage): Promise<void> {
    if (session.outgoingTransfers.has(message.transferId)) {
      this.cancelOutgoingTransfer(session, message.transferId, 'cancelled by remote');
      return;
    }

    if (session.incomingTransfers.has(message.transferId)) {
      await this.cancelIncomingTransfer(session, message.transferId, 'cancelled by remote');
    }
  }

  private failOutgoingTransfer(session: PeerSession, transferId: string, note: string): void {
    const transfer = session.outgoingTransfers.get(transferId);
    if (!transfer) {
      return;
    }

    clearTransferTimeout(transfer);
    this.callbacks.onTransferUpdate({
      transferId,
      peerId: session.peer.clientId,
      peerName: session.peer.nickname,
      fileName: transfer.file.name,
      totalBytes: transfer.file.size,
      transferredBytes: transfer.sentBytes,
      direction: 'upload',
      transport: 'direct-p2p',
      status: 'failed',
      note,
    });
    session.outgoingTransfers.delete(transferId);
  }

  private cancelOutgoingTransfer(
    session: PeerSession,
    transferId: string,
    note: string,
    notifyReason?: string,
  ): boolean {
    const transfer = session.outgoingTransfers.get(transferId);
    if (!transfer) {
      return false;
    }

    transfer.cancelled = true;
    clearTransferTimeout(transfer);

    if (notifyReason && session.control?.readyState === 'open' && !transfer.cancelNotified) {
      transfer.cancelNotified = true;
      session.control.send(
        JSON.stringify({
          type: 'direct-file-cancel',
          transferId,
          reason: notifyReason,
        } satisfies DirectFileCancelMessage),
      );
    }

    if (transfer.channel && transfer.channel.readyState !== 'closed') {
      transfer.channel.close();
    }

    this.callbacks.onTransferUpdate({
      transferId,
      peerId: session.peer.clientId,
      peerName: session.peer.nickname,
      fileName: transfer.file.name,
      totalBytes: transfer.file.size,
      transferredBytes: transfer.sentBytes,
      direction: 'upload',
      transport: 'direct-p2p',
      status: 'cancelled',
      note,
    });
    session.outgoingTransfers.delete(transferId);
    return true;
  }

  private attachIncomingFileChannel(session: PeerSession, channel: RTCDataChannel): void {
    const transferId = channel.label.replace(FILE_CHANNEL_PREFIX, '');
    const incoming = session.incomingTransfers.get(transferId);
    if (!incoming) {
      channel.close();
      return;
    }

    incoming.channel = channel;
    let receivedBytes = 0;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => {
      if (incoming.cancelled || !session.incomingTransfers.has(transferId)) {
        return;
      }

      const chunk = event.data as ArrayBuffer | Blob;
      if (incoming.writer) {
        const payload = chunk instanceof Blob ? chunk : chunk.slice(0);
        incoming.writeChain = incoming.writeChain.then(() => incoming.writer?.write(payload) ?? Promise.resolve());
      } else {
        if (chunk instanceof Blob) {
          incoming.writeChain = incoming.writeChain.then(async () => {
            incoming.chunks.push(await chunk.arrayBuffer());
          });
        } else {
          incoming.chunks.push(chunk.slice(0));
        }
      }
      receivedBytes += getBinarySize(chunk);
      incoming.receivedBytes = receivedBytes;
      this.callbacks.onTransferUpdate({
        transferId,
        peerId: session.peer.clientId,
        peerName: session.peer.nickname,
        fileName: incoming.fileName,
        totalBytes: incoming.size,
        transferredBytes: receivedBytes,
        direction: 'download',
        transport: 'direct-p2p',
        status: 'streaming',
      });

      if (receivedBytes >= incoming.size && !incoming.receivedNoticeSent) {
        incoming.receivedNoticeSent = true;
        session.control?.send(
          JSON.stringify({
            type: 'direct-file-received',
            transferId,
          } satisfies DirectFileReceivedMessage),
        );
        this.maybeFinishIncomingTransfer(session, incoming, transferId, receivedBytes);
      }
    };
    channel.onclose = () => {
      if (incoming.cancelled || !session.incomingTransfers.has(transferId)) {
        return;
      }
      if (receivedBytes !== incoming.size) {
        window.setTimeout(() => {
          if (incoming.cancelled || !session.incomingTransfers.has(transferId)) {
            return;
          }
          void this.finishIncomingTransfer(session, incoming, transferId, receivedBytes);
        }, CANCEL_GRACE_WINDOW_MS);
        return;
      }

      this.maybeFinishIncomingTransfer(session, incoming, transferId, receivedBytes);
    };
  }

  private maybeFinishIncomingTransfer(
    session: PeerSession,
    incoming: IncomingTransfer,
    transferId: string,
    receivedBytes: number,
  ): void {
    if (incoming.finishing || incoming.cancelled || !session.incomingTransfers.has(transferId)) {
      return;
    }

    if (receivedBytes !== incoming.size) {
      return;
    }

    incoming.finishing = true;
    void this.finishIncomingTransfer(session, incoming, transferId, receivedBytes);
  }

  private async cancelIncomingTransfer(
    session: PeerSession,
    transferId: string,
    note: string,
    notifyReason?: string,
  ): Promise<void> {
    const incoming = session.incomingTransfers.get(transferId);
    if (!incoming) {
      return;
    }

    incoming.cancelled = true;
    incoming.finishing = false;
    session.incomingTransfers.delete(transferId);

    if (notifyReason && session.control?.readyState === 'open') {
      session.control.send(
        JSON.stringify({
          type: 'direct-file-cancel',
          transferId,
          reason: notifyReason,
        } satisfies DirectFileCancelMessage),
      );
    }

    try {
      await incoming.writer?.abort();
    } catch (error) {
      if (!isAbortLikeError(error)) {
        console.warn('Failed to abort incoming file writer', error);
      }
    }

    if (incoming.channel && incoming.channel.readyState !== 'closed') {
      incoming.channel.close();
    }

    this.callbacks.onTransferUpdate({
      transferId,
      peerId: session.peer.clientId,
      peerName: session.peer.nickname,
      fileName: incoming.fileName,
      totalBytes: incoming.size,
      transferredBytes: incoming.receivedBytes,
      direction: 'download',
      transport: 'direct-p2p',
      status: 'cancelled',
      note,
    });
  }

  private async finishIncomingTransfer(
    session: PeerSession,
    incoming: IncomingTransfer,
    transferId: string,
    receivedBytes: number,
  ): Promise<void> {
    try {
      await incoming.writeChain;
      await incoming.writer?.close();
    } catch (error) {
      await incoming.writer?.abort();
      session.control?.send(
        JSON.stringify({
          type: 'direct-file-failed',
          transferId,
          reason: 'receiver_write_failed',
        } satisfies DirectFileFailedMessage),
      );
      this.callbacks.onTransferUpdate({
        transferId,
        peerId: session.peer.clientId,
        peerName: session.peer.nickname,
        fileName: incoming.fileName,
        totalBytes: incoming.size,
        transferredBytes: receivedBytes,
        direction: 'download',
        transport: 'direct-p2p',
        status: 'failed',
        note: error instanceof Error ? error.message : 'failed to write incoming file',
      });
      session.incomingTransfers.delete(transferId);
      return;
    }

    if (receivedBytes !== incoming.size) {
      await incoming.writer?.abort();
      session.control?.send(
        JSON.stringify({
          type: 'direct-file-failed',
          transferId,
          reason: 'transfer_interrupted',
        } satisfies DirectFileFailedMessage),
      );
      this.callbacks.onTransferUpdate({
        transferId,
        peerId: session.peer.clientId,
        peerName: session.peer.nickname,
        fileName: incoming.fileName,
        totalBytes: incoming.size,
        transferredBytes: receivedBytes,
        direction: 'download',
        transport: 'direct-p2p',
        status: 'failed',
        note: 'transfer interrupted',
      });
      session.incomingTransfers.delete(transferId);
      return;
    }

    const previewBlob =
      incoming.mode === 'disk' && incoming.fileHandle && incoming.contentType.startsWith('image/')
        ? await incoming.fileHandle.getFile()
        : incoming.mode === 'memory'
          ? new Blob(incoming.chunks, { type: incoming.contentType })
          : undefined;

    this.callbacks.onIncomingFile({
      transferId,
      remoteId: session.peer.clientId,
      remoteName: session.peer.nickname,
      fileName: incoming.fileName,
      contentType: incoming.contentType,
      size: incoming.size,
      blob: previewBlob,
      savedToDisk: incoming.mode === 'disk',
    });
    this.callbacks.onTransferUpdate({
      transferId,
      peerId: session.peer.clientId,
      peerName: session.peer.nickname,
      fileName: incoming.fileName,
      totalBytes: incoming.size,
      transferredBytes: receivedBytes,
      direction: 'download',
      transport: 'direct-p2p',
      status: 'complete',
      note: incoming.mode === 'disk' ? 'saved directly to receive directory' : undefined,
    });
    session.control?.send(
      JSON.stringify({
        type: 'direct-file-complete',
        transferId,
      } satisfies DirectFileCompleteMessage),
    );
    session.incomingTransfers.delete(transferId);
  }

  private async streamOutgoingFile(
    session: PeerSession,
    channel: RTCDataChannel,
    transfer: OutgoingTransfer,
  ): Promise<void> {
    if (transfer.cancelled || !session.outgoingTransfers.has(transfer.transferId)) {
      channel.close();
      return;
    }

    let sentBytes = 0;

    try {
      for (let offset = 0; offset < transfer.file.size; offset += DIRECT_FILE_CHUNK_BYTES) {
        if (transfer.cancelled || !session.outgoingTransfers.has(transfer.transferId)) {
          channel.close();
          return;
        }

        if (channel.readyState !== 'open') {
          throw new Error('direct channel closed during transfer');
        }

        while (channel.bufferedAmount > BUFFER_LIMIT_BYTES) {
          if (transfer.cancelled || !session.outgoingTransfers.has(transfer.transferId)) {
            channel.close();
            return;
          }

          if (channel.readyState !== 'open') {
            throw new Error('direct channel closed during transfer');
          }
          await sleep(24);
        }

        const chunk = transfer.file.slice(offset, Math.min(offset + DIRECT_FILE_CHUNK_BYTES, transfer.file.size));
        channel.send(chunk);
        sentBytes += chunk.size;
        transfer.sentBytes = sentBytes;
        this.callbacks.onTransferUpdate({
          transferId: transfer.transferId,
          peerId: session.peer.clientId,
          peerName: session.peer.nickname,
          fileName: transfer.file.name,
          totalBytes: transfer.file.size,
          transferredBytes: sentBytes,
          direction: 'upload',
          transport: 'direct-p2p',
          status: 'streaming',
        });
      }

      while (channel.bufferedAmount > 0) {
        if (transfer.cancelled || !session.outgoingTransfers.has(transfer.transferId)) {
          channel.close();
          return;
        }

        if (channel.readyState !== 'open') {
          throw new Error('direct channel closed during transfer');
        }
        await sleep(24);
      }

      this.emitOutgoingTransferUpdate(session, transfer, 'streaming', 'waiting for receiver confirmation');
      this.startReceiverConfirmationWatch(session, transfer, 'delivery');

      channel.close();
    } catch (error) {
      if (error instanceof Error && error.message === 'direct channel closed during transfer') {
        await sleep(CANCEL_GRACE_WINDOW_MS);
      }

      if (transfer.cancelled || !session.outgoingTransfers.has(transfer.transferId)) {
        return;
      }
      this.failOutgoingTransfer(
        session,
        transfer.transferId,
        error instanceof Error ? error.message : 'stream failed',
      );
    }
  }

  private startPathPolling(session: PeerSession): void {
    if (session.pathPollTimerId) {
      return;
    }

    void this.refreshPathInfo(session);
    session.pathPollTimerId = window.setInterval(() => {
      void this.refreshPathInfo(session);
    }, 2_000);
  }

  private stopPathPolling(session: PeerSession): void {
    if (!session.pathPollTimerId) {
      return;
    }

    window.clearInterval(session.pathPollTimerId);
    delete session.pathPollTimerId;
  }

  private publishPathInfo(session: PeerSession, path: DirectPathInfo | null): void {
    const nextKey = buildPathInfoKey(path);
    if (session.pathInfoKey === nextKey) {
      return;
    }

    session.pathInfoKey = nextKey;
    this.callbacks.onPeerPathChange(session.peer.clientId, path);
  }

  private async refreshPathInfo(session: PeerSession): Promise<void> {
    if (session.pc.connectionState !== 'connected') {
      return;
    }

    try {
      const stats = await session.pc.getStats();
      const selectedPair = this.findSelectedCandidatePair(stats);
      if (!selectedPair) {
        return;
      }

      const localCandidateId = selectedPair.localCandidateId as string | undefined;
      const remoteCandidateId = selectedPair.remoteCandidateId as string | undefined;
      const localCandidate = localCandidateId ? (stats.get(localCandidateId) as Record<string, unknown> | undefined) : undefined;
      const remoteCandidate = remoteCandidateId ? (stats.get(remoteCandidateId) as Record<string, unknown> | undefined) : undefined;

      const localCandidateType =
        typeof localCandidate?.candidateType === 'string' ? localCandidate.candidateType : undefined;
      const remoteCandidateType =
        typeof remoteCandidate?.candidateType === 'string' ? remoteCandidate.candidateType : undefined;
      const localFallback = session.lastLocalLanCandidate;
      const remoteFallback = session.lastRemoteLanCandidate;
      const localAddress = readCandidateAddress(localCandidate) ?? localFallback?.address;
      const remoteAddress = readCandidateAddress(remoteCandidate) ?? remoteFallback?.address;
      const resolvedLocalCandidateType = localCandidateType ?? localFallback?.candidateType;
      const resolvedRemoteCandidateType = remoteCandidateType ?? remoteFallback?.candidateType;
      const protocol =
        (typeof localCandidate?.protocol === 'string' ? localCandidate.protocol : undefined) ??
        (typeof selectedPair.protocol === 'string' ? selectedPair.protocol : undefined) ??
        localFallback?.protocol ??
        remoteFallback?.protocol;
      const roundTripTimeMs =
        typeof selectedPair.currentRoundTripTime === 'number'
          ? Math.round(selectedPair.currentRoundTripTime * 1000)
          : undefined;

      this.publishPathInfo(session, {
        kind: classifyDirectPath(
          resolvedLocalCandidateType,
          resolvedRemoteCandidateType,
          localAddress,
          remoteAddress,
        ),
        localCandidateType: resolvedLocalCandidateType,
        remoteCandidateType: resolvedRemoteCandidateType,
        protocol,
        localAddress,
        remoteAddress,
        roundTripTimeMs,
      });
    } catch {
      // Ignore stats failures; path tooltip can stay in previous known state.
    }
  }

  private findSelectedCandidatePair(stats: RTCStatsReport): Record<string, unknown> | null {
    let pair: Record<string, unknown> | null = null;

    stats.forEach((report) => {
      if (pair) {
        return;
      }

      const value = report as unknown as Record<string, unknown>;
      if (value.type === 'transport' && typeof value.selectedCandidatePairId === 'string') {
        const selected = stats.get(value.selectedCandidatePairId);
        if (selected) {
          pair = selected as unknown as Record<string, unknown>;
        }
      }
    });

    if (pair) {
      return pair;
    }

    stats.forEach((report) => {
      if (pair) {
        return;
      }

      const value = report as unknown as Record<string, unknown>;
      if (value.type !== 'candidate-pair') {
        return;
      }

      if (value.selected === true || value.nominated === true || value.state === 'succeeded') {
        pair = value;
      }
    });

    return pair;
  }
}

export type { DirectPathInfo, IncomingFilePayload, TransferUpdate };
