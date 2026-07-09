import type { IceServer, Peer, SignalEnvelope } from '@shared/protocol';

export type DirectState = 'connecting' | 'direct' | 'offline';
export type DirectPathKind = 'lan' | 'stun' | 'turn' | 'unknown';

export interface DirectPathInfo {
  kind: DirectPathKind;
  localCandidateType?: string;
  remoteCandidateType?: string;
  protocol?: string;
  localAddress?: string;
  remoteAddress?: string;
  roundTripTimeMs?: number;
}

export interface DirectPeerSnapshot {
  state: DirectState;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  channelState?: RTCDataChannelState;
  reconnectAttempts: number;
  path?: DirectPathInfo;
  updatedAt: number;
  note?: string;
}

export interface IncomingDirectFile {
  id: string;
  roomId: string;
  conversationId?: string;
  senderId: string;
  senderName: string;
  targetId: string;
  fileName: string;
  size: number;
  contentType: string;
  createdAt: number;
  url?: string;
  savedToDisk?: boolean;
  messageType?: 'txt_file';
}

export interface DirectFileProgress {
  id: string;
  roomId: string;
  peerId: string;
  fileName: string;
  size: number;
  transferredBytes: number;
  direction: 'send' | 'receive';
  error?: string;
  cancelled?: boolean;
}

export interface DirectSendOptions {
  transferId?: string;
  conversationId?: string;
  messageType?: 'txt_file';
  signal?: AbortSignal;
  isPaused?: () => boolean;
  onProgress?: (transferredBytes: number, totalBytes: number) => void;
}

export interface IncomingDirectFileSink {
  savedToDisk: boolean;
  write: (chunk: ArrayBuffer) => Promise<void>;
  close: () => Promise<{ url?: string }>;
  abort: () => Promise<void>;
}

interface DirectMeshOptions {
  selfId: string;
  selfName: string;
  roomId: string;
  iceServers: IceServer[];
  sendSignal: (targetId: string, payload: SignalEnvelope) => void;
  onStateChange: (peerId: string, state: DirectState) => void;
  onPeerSnapshot?: (peerId: string, snapshot: DirectPeerSnapshot) => void;
  onIncomingFileStart?: (progress: DirectFileProgress) => void;
  onIncomingFileProgress?: (progress: DirectFileProgress) => void;
  onIncomingFileCancel?: (progress: DirectFileProgress) => void;
  onIncomingFileError?: (progress: DirectFileProgress) => void;
  createIncomingFileSink?: (meta: DirectFileMeta) => Promise<IncomingDirectFileSink | null>;
  onIncomingFile: (file: IncomingDirectFile) => void;
}

interface DirectPeer {
  id: string;
  name: string;
  peer: Peer;
  polite: boolean;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  activeSendCount: number;
  outgoingFiles: Map<string, PendingOutgoingFile>;
  pendingCandidates: RTCIceCandidateInit[];
  files: Map<string, PendingIncomingFile>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  reconnectTimerId?: number;
  reconnectAttempts: number;
  controlOpenTimerId?: number;
  pathInfo?: DirectPathInfo | null;
  pathInfoKey?: string;
  pathPollTimerId?: number;
  lastLocalCandidate?: ParsedIceCandidate;
  lastRemoteCandidate?: ParsedIceCandidate;
}

interface PendingIncomingFile {
  meta: DirectFileMeta;
  chunks: ArrayBuffer[];
  received: number;
  sink: IncomingDirectFileSink | null;
  writeChain: Promise<void>;
  progress: ProgressReporter;
  channel?: RTCDataChannel;
}

interface PendingOutgoingFile {
  meta: DirectFileMeta;
  file: File;
  sent: number;
  phase: 'offered' | 'streaming' | 'awaiting-complete';
  options: DirectSendOptions;
  progress: ProgressReporter;
  resolve: (value: boolean) => void;
  reject: (error: unknown) => void;
  channel?: RTCDataChannel;
  timeoutId?: number;
  finishedSending?: boolean;
  cancelled?: boolean;
}

interface DirectFileMeta {
  type: 'file-meta';
  id: string;
  roomId: string;
  conversationId?: string;
  senderId: string;
  senderName: string;
  targetId: string;
  fileName: string;
  size: number;
  contentType: string;
  createdAt: number;
  messageType?: 'txt_file';
}

interface DirectFileDone {
  type: 'file-done';
  id: string;
}

interface DirectFileAccept {
  type: 'file-accept';
  id: string;
}

interface DirectFileCancel {
  type: 'file-cancel';
  id: string;
}

interface DirectFileFailed {
  type: 'file-failed';
  id: string;
  error?: string;
}

type DirectControlMessage = DirectFileMeta | DirectFileAccept | DirectFileDone | DirectFileCancel | DirectFileFailed;

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 8 * 1024 * 1024;
const LOW_WATER_MARK = 2 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;
const PEER_REAP_GRACE_MS = 8000;
const PEER_RECONNECT_DELAY_MS = 1200;
const MAX_PEER_RECONNECT_ATTEMPTS = 3;
const CONTROL_CHANNEL_OPEN_TIMEOUT_MS = 3000;
const PATH_POLL_INTERVAL_MS = 2000;
const OUTGOING_ACCEPT_TIMEOUT_MS = 30_000;
const OUTGOING_COMPLETE_TIMEOUT_MS = 10 * 60_000;
const FILE_CHANNEL_PREFIX = 'patrick-im-file:';

interface ParsedIceCandidate {
  candidateType?: string;
  address?: string;
  protocol?: string;
}

interface ProgressReporter {
  report: (transferredBytes: number, totalBytes: number) => void;
  flush: (transferredBytes: number, totalBytes: number) => void;
}

export class DirectMesh {
  private readonly peers = new Map<string, DirectPeer>();
  private readonly peerCloseTimers = new Map<string, number>();
  private readonly options: DirectMeshOptions;
  private closed = false;

  constructor(options: DirectMeshOptions) {
    this.options = options;
  }

  setSelfName(name: string): void {
    this.options.selfName = name;
  }

  setPeers(peers: Peer[]): void {
    if (this.closed || typeof RTCPeerConnection === 'undefined') {
      return;
    }
    const liveIds = new Set<string>();
    for (const peer of peers) {
      if (peer.clientId === this.options.selfId) {
        continue;
      }
      liveIds.add(peer.clientId);
      this.clearPeerCloseTimer(peer.clientId);
      this.ensurePeer(peer, this.shouldInitiate(peer.clientId));
    }
    for (const peerId of [...this.peers.keys()]) {
      if (!liveIds.has(peerId)) {
        this.schedulePeerClose(peerId);
      }
    }
  }

  async handleSignal(fromId: string, payload: SignalEnvelope): Promise<void> {
    if (this.closed || typeof RTCPeerConnection === 'undefined') {
      return;
    }
    const peer = this.ensurePeer({ clientId: fromId, nickname: fromId, joinedAt: Date.now() }, false);
    try {
      if (payload.description) {
        const readyForOffer =
          !peer.makingOffer && (peer.pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
        const offerCollision = payload.description.type === 'offer' && !readyForOffer;
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) {
          return;
        }
        peer.ignoreOffer = false;
        peer.isSettingRemoteAnswerPending = payload.description.type === 'answer';
        await peer.pc.setRemoteDescription(payload.description);
        peer.isSettingRemoteAnswerPending = false;
        await this.flushPendingCandidates(peer);
        if (payload.description.type === 'offer') {
          await peer.pc.setLocalDescription();
          if (peer.pc.localDescription) {
            this.options.sendSignal(fromId, { description: peer.pc.localDescription });
          }
        }
      }
      if (payload.candidate) {
        if (peer.ignoreOffer) {
          return;
        }
        peer.lastRemoteCandidate = parseIceCandidate(payload.candidate);
        if (!peer.pc.remoteDescription) {
          peer.pendingCandidates.push(payload.candidate);
        } else {
          await peer.pc.addIceCandidate(payload.candidate);
        }
      }
    } catch {
      this.emitPeerState(peer, 'offline', 'signal_error');
      this.scheduleReconnect(peer);
    } finally {
      peer.isSettingRemoteAnswerPending = false;
    }
  }

  async sendFile(peerId: string, file: File, options: DirectSendOptions = {}): Promise<boolean> {
    const peer = this.peers.get(peerId);
    const control = peer?.channel;
    if (!peer || !control || control.readyState !== 'open') {
      return false;
    }
    const id = options.transferId ?? crypto.randomUUID?.() ?? `direct-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const meta: DirectFileMeta = {
      type: 'file-meta',
      id,
      roomId: this.options.roomId,
      conversationId: options.conversationId,
      senderId: this.options.selfId,
      senderName: this.options.selfName,
      targetId: peerId,
      fileName: file.name || 'file',
      size: file.size,
      contentType: file.type || 'application/octet-stream',
      createdAt: Date.now(),
      messageType: options.messageType,
    };
    const progress = createProgressReporter(options.onProgress);
    peer.activeSendCount += 1;
    progress.flush(0, file.size);
    return new Promise<boolean>((resolve, reject) => {
      peer.outgoingFiles.set(id, {
        meta,
        file,
        sent: 0,
        phase: 'offered',
        options,
        progress,
        resolve,
        reject,
      });
      const pending = peer.outgoingFiles.get(id);
      if (pending) {
        this.setOutgoingTimeout(peer, pending, OUTGOING_ACCEPT_TIMEOUT_MS, '接收端未确认接收');
      }
      try {
        control.send(JSON.stringify(meta));
      } catch (error) {
        this.cancelOutgoingFile(peer, id, error);
      }
    });
  }

  cancelTransfer(id: string): boolean {
    for (const peer of this.peers.values()) {
      if (peer.outgoingFiles.has(id)) {
        this.notifyTransferCancel(peer, id);
        this.cancelOutgoingFile(peer, id, new DOMException('Transfer cancelled', 'AbortError'));
        return true;
      }
      if (peer.files.has(id)) {
        this.notifyTransferCancel(peer, id);
        void this.cancelIncomingFile(peer, id);
        return true;
      }
    }
    return false;
  }

  close(): void {
    this.closed = true;
    for (const peerId of [...this.peers.keys()]) {
      this.closePeer(peerId);
    }
  }

  private ensurePeer(peer: Peer, shouldOffer: boolean): DirectPeer {
    const existing = this.peers.get(peer.clientId);
    if (existing) {
      existing.name = peer.nickname || existing.name;
      existing.peer = peer;
      if (existing.pc.connectionState === 'failed' || existing.pc.connectionState === 'closed') {
        const nextAttempts = existing.reconnectAttempts + 1;
        if (nextAttempts > MAX_PEER_RECONNECT_ATTEMPTS) {
          return existing;
        }
        this.closePeer(existing.id);
        const nextPeer = this.ensurePeer(peer, shouldOffer);
        nextPeer.reconnectAttempts = nextAttempts;
        return nextPeer;
      }
      return existing;
    }

    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
    const directPeer: DirectPeer = {
      id: peer.clientId,
      name: peer.nickname || peer.clientId,
      peer,
      polite: this.isPolitePeer(peer.clientId),
      pc,
      channel: null,
      activeSendCount: 0,
      outgoingFiles: new Map(),
      pendingCandidates: [],
      files: new Map(),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      reconnectAttempts: 0,
    };
    this.peers.set(peer.clientId, directPeer);
    this.emitPeerState(directPeer, 'connecting', 'peer_created');

    pc.onnegotiationneeded = () => {
      void this.negotiate(directPeer);
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        directPeer.lastLocalCandidate = parseIceCandidate(event.candidate);
        this.options.sendSignal(peer.clientId, { candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.startPathPolling(directPeer);
        this.scheduleControlOpenCheck(directPeer);
        this.emitPeerState(directPeer, directPeer.channel?.readyState === 'open' ? 'direct' : 'connecting', 'pc_connected');
      } else if (state === 'failed') {
        this.stopPathPolling(directPeer);
        this.publishPathInfo(directPeer, null);
        this.emitPeerState(directPeer, 'offline', 'pc_failed');
        this.scheduleReconnect(directPeer);
      } else if (state === 'closed') {
        this.stopPathPolling(directPeer);
        this.publishPathInfo(directPeer, null);
        this.emitPeerState(directPeer, 'offline', 'pc_closed');
      } else if (state === 'disconnected') {
        this.emitPeerState(directPeer, 'connecting', 'pc_disconnected');
      } else {
        this.emitPeerState(directPeer, 'connecting', `pc_${state}`);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this.stopPathPolling(directPeer);
        this.publishPathInfo(directPeer, null);
        this.emitPeerState(directPeer, 'offline', 'ice_failed');
        this.scheduleReconnect(directPeer);
      } else {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          this.scheduleControlOpenCheck(directPeer);
        }
        this.emitPeerState(directPeer, directPeer.channel?.readyState === 'open' ? 'direct' : 'connecting', `ice_${pc.iceConnectionState}`);
      }
    };
    pc.ondatachannel = (event) => {
      if (event.channel.label.startsWith(FILE_CHANNEL_PREFIX)) {
        this.attachIncomingFileChannel(directPeer, event.channel);
        return;
      }
      this.attachChannel(directPeer, event.channel);
    };

    if (shouldOffer) {
      this.attachChannel(directPeer, pc.createDataChannel('patrick-im-file'));
    }
    return directPeer;
  }

  private emitPeerState(peer: DirectPeer, state: DirectState, note?: string): void {
    this.options.onStateChange(peer.id, state);
    this.options.onPeerSnapshot?.(peer.id, {
      state,
      connectionState: peer.pc.connectionState,
      iceConnectionState: peer.pc.iceConnectionState,
      signalingState: peer.pc.signalingState,
      channelState: peer.channel?.readyState,
      reconnectAttempts: peer.reconnectAttempts,
      path: peer.pathInfo ?? undefined,
      updatedAt: Date.now(),
      note,
    });
  }

  private isPolitePeer(peerId: string): boolean {
    return this.options.selfId.localeCompare(peerId) > 0;
  }

  private shouldInitiate(peerId: string): boolean {
    return this.options.selfId.localeCompare(peerId) > 0;
  }

  private async flushPendingCandidates(peer: DirectPeer): Promise<void> {
    while (peer.pendingCandidates.length > 0) {
      const candidate = peer.pendingCandidates.shift();
      if (candidate) {
        await peer.pc.addIceCandidate(candidate);
      }
    }
  }

  private attachChannel(peer: DirectPeer, channel: RTCDataChannel): void {
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    channel.onopen = () => {
      this.clearControlOpenCheck(peer);
      peer.reconnectAttempts = 0;
      this.startPathPolling(peer);
      this.emitPeerState(peer, 'direct', 'control_open');
    };
    channel.onclose = () => {
      void this.failIncomingFilesForPeer(peer, '直连已断开，传输中断');
      this.clearControlOpenCheck(peer);
      this.stopPathPolling(peer);
      this.publishPathInfo(peer, null);
      this.emitPeerState(peer, 'offline', 'control_closed');
      this.scheduleReconnect(peer);
    };
    channel.onerror = () => {
      void this.failIncomingFilesForPeer(peer, '直连通道异常');
      this.clearControlOpenCheck(peer);
      this.stopPathPolling(peer);
      this.emitPeerState(peer, 'offline', 'control_error');
      this.scheduleReconnect(peer);
    };
    channel.onmessage = (event) => {
      void this.handleControlMessage(peer, event.data);
    };
  }

  private async negotiate(peer: DirectPeer): Promise<void> {
    if (this.closed || peer.pc.signalingState === 'closed') {
      return;
    }
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      if (peer.pc.localDescription) {
        this.options.sendSignal(peer.id, { description: peer.pc.localDescription });
      }
    } catch {
      this.emitPeerState(peer, 'offline', 'negotiate_error');
      this.scheduleReconnect(peer);
    } finally {
      peer.makingOffer = false;
    }
  }

  private async handleControlMessage(peer: DirectPeer, data: unknown): Promise<void> {
    if (typeof data === 'string') {
      let payload: DirectControlMessage;
      try {
        payload = JSON.parse(data) as DirectControlMessage;
      } catch {
        return;
      }
      if (payload.type === 'file-meta') {
        await this.prepareIncomingFile(peer, payload);
        return;
      }
      if (payload.type === 'file-accept') {
        this.openOutgoingFileChannel(peer, payload.id);
        return;
      }
      if (payload.type === 'file-done') {
        this.completeOutgoingFile(peer, payload.id);
        return;
      }
      if (payload.type === 'file-cancel') {
        this.cancelOutgoingFile(peer, payload.id, new DOMException('Transfer cancelled by receiver', 'AbortError'));
        await this.cancelIncomingFile(peer, payload.id);
        return;
      }
      if (payload.type === 'file-failed') {
        this.cancelOutgoingFile(peer, payload.id, new Error(payload.error || '接收端处理失败'));
      }
      return;
    }
  }

  private async handleIncomingFileChannelMessage(peer: DirectPeer, id: string, data: unknown): Promise<void> {
    const pending = peer.files.get(id);
    if (!pending) {
      return;
    }
    if (typeof data === 'string') {
      let payload: DirectFileDone | DirectFileCancel;
      try {
        payload = JSON.parse(data) as DirectFileDone | DirectFileCancel;
      } catch {
        return;
      }
      if (payload.type === 'file-done') {
        await this.finishIncomingFile(peer, id);
      } else if (payload.type === 'file-cancel') {
        await this.cancelIncomingFile(peer, id);
      }
      return;
    }
    const chunk = await toArrayBuffer(data);
    if (pending.sink) {
      pending.writeChain = pending.writeChain.then(() => pending.sink?.write(chunk) ?? Promise.resolve());
    } else {
      pending.chunks.push(chunk);
    }
    pending.received += chunk.byteLength;
    pending.progress.report(pending.received, pending.meta.size);
  }

  private async prepareIncomingFile(peer: DirectPeer, payload: DirectFileMeta): Promise<void> {
    const progress = createProgressReporter((transferredBytes, totalBytes) => {
      this.options.onIncomingFileProgress?.({
        id: payload.id,
        roomId: payload.roomId,
        peerId: peer.id,
        fileName: payload.fileName,
        size: totalBytes,
        transferredBytes,
        direction: 'receive',
      });
    });
    let sink: IncomingDirectFileSink | null = null;
    try {
      sink = (await this.options.createIncomingFileSink?.(payload)) ?? null;
    } catch {
      sink = null;
    }
    peer.files.set(payload.id, { meta: payload, chunks: [], received: 0, sink, writeChain: Promise.resolve(), progress });
    this.options.onIncomingFileStart?.({
      id: payload.id,
      roomId: payload.roomId,
      peerId: peer.id,
      fileName: payload.fileName,
      size: payload.size,
      transferredBytes: 0,
      direction: 'receive',
    });
    peer.channel?.send(JSON.stringify({ type: 'file-accept', id: payload.id } satisfies DirectFileAccept));
  }

  private attachIncomingFileChannel(peer: DirectPeer, channel: RTCDataChannel): void {
    const id = channel.label.startsWith(FILE_CHANNEL_PREFIX) ? channel.label.slice(FILE_CHANNEL_PREFIX.length) : '';
    const pending = peer.files.get(id);
    if (!id || !pending) {
      channel.close();
      return;
    }
    pending.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => {
      void this.handleIncomingFileChannelMessage(peer, id, event.data);
    };
    channel.onerror = () => {
      void this.failIncomingFile(peer, id, '文件通道异常');
    };
    channel.onclose = () => {
      const current = peer.files.get(id);
      if (current && current.received < current.meta.size) {
        void this.failIncomingFile(peer, id, '文件通道已关闭');
      }
    };
  }

  private openOutgoingFileChannel(peer: DirectPeer, id: string): void {
    const pending = peer.outgoingFiles.get(id);
    if (!pending || pending.channel || pending.cancelled) {
      return;
    }
    this.clearOutgoingTimeout(pending);
    pending.phase = 'streaming';
    const channel = peer.pc.createDataChannel(`${FILE_CHANNEL_PREFIX}${id}`);
    pending.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    channel.onopen = () => {
      void this.streamOutgoingFile(peer, pending);
    };
    channel.onerror = () => {
      this.cancelOutgoingFile(peer, id, new Error('文件通道异常'));
    };
    channel.onclose = () => {
      const current = peer.outgoingFiles.get(id);
      if (current && !current.finishedSending && !current.cancelled) {
        this.cancelOutgoingFile(peer, id, new Error('文件通道已关闭'));
      }
    };
  }

  private async streamOutgoingFile(peer: DirectPeer, pending: PendingOutgoingFile): Promise<void> {
    const channel = pending.channel;
    if (!channel || channel.readyState !== 'open' || pending.cancelled) {
      return;
    }
    try {
      await sendFileChunks(channel, pending.file, {
        ...pending.options,
        onProgress: (transferredBytes, totalBytes) => {
          pending.sent = transferredBytes;
          pending.progress.report(transferredBytes, totalBytes);
        },
      });
      channel.send(JSON.stringify({ type: 'file-done', id: pending.meta.id } satisfies DirectFileDone));
      pending.finishedSending = true;
      pending.phase = 'awaiting-complete';
      this.setOutgoingTimeout(peer, pending, OUTGOING_COMPLETE_TIMEOUT_MS, '接收端完成确认超时');
      pending.progress.flush(pending.file.size, pending.file.size);
    } catch (error) {
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'file-cancel', id: pending.meta.id } satisfies DirectFileCancel));
      }
      peer.channel?.send(JSON.stringify({ type: 'file-cancel', id: pending.meta.id } satisfies DirectFileCancel));
      this.cancelOutgoingFile(peer, pending.meta.id, error);
    }
  }

  private completeOutgoingFile(peer: DirectPeer, id: string): void {
    const pending = peer.outgoingFiles.get(id);
    if (!pending) {
      return;
    }
    pending.channel?.close();
    this.clearOutgoingTimeout(pending);
    peer.outgoingFiles.delete(id);
    peer.activeSendCount = Math.max(0, peer.activeSendCount - 1);
    pending.resolve(true);
  }

  private cancelOutgoingFile(peer: DirectPeer, id: string, error: unknown): void {
    const pending = peer.outgoingFiles.get(id);
    if (!pending) {
      return;
    }
    pending.cancelled = true;
    pending.channel?.close();
    this.clearOutgoingTimeout(pending);
    peer.outgoingFiles.delete(id);
    peer.activeSendCount = Math.max(0, peer.activeSendCount - 1);
    pending.reject(error);
  }

  private notifyTransferCancel(peer: DirectPeer, id: string): void {
    const message = JSON.stringify({ type: 'file-cancel', id } satisfies DirectFileCancel);
    const outgoing = peer.outgoingFiles.get(id);
    if (outgoing?.channel?.readyState === 'open') {
      outgoing.channel.send(message);
    }
    if (peer.channel?.readyState === 'open') {
      peer.channel.send(message);
    }
  }

  private setOutgoingTimeout(peer: DirectPeer, pending: PendingOutgoingFile, timeoutMs: number, message: string): void {
    this.clearOutgoingTimeout(pending);
    pending.timeoutId = window.setTimeout(() => {
      this.cancelOutgoingFile(peer, pending.meta.id, new Error(message));
    }, timeoutMs);
  }

  private clearOutgoingTimeout(pending: PendingOutgoingFile): void {
    if (!pending.timeoutId) {
      return;
    }
    window.clearTimeout(pending.timeoutId);
    pending.timeoutId = undefined;
  }

  private async cancelIncomingFile(peer: DirectPeer, id: string): Promise<void> {
    const pending = peer.files.get(id);
    if (!pending) {
      return;
    }
    peer.files.delete(id);
    pending.channel?.close();
    await pending.writeChain.catch(() => undefined);
    await pending.sink?.abort();
    this.options.onIncomingFileCancel?.({
      id: pending.meta.id,
      roomId: pending.meta.roomId,
      peerId: peer.id,
      fileName: pending.meta.fileName,
      size: pending.meta.size,
      transferredBytes: pending.received,
      direction: 'receive',
      error: '已取消',
      cancelled: true,
    });
  }

  private async failIncomingFile(peer: DirectPeer, id: string, error: string): Promise<void> {
    const pending = peer.files.get(id);
    if (!pending) {
      return;
    }
    peer.files.delete(id);
    pending.channel?.close();
    await pending.writeChain.catch(() => undefined);
    await pending.sink?.abort();
    peer.channel?.send(JSON.stringify({ type: 'file-failed', id, error } satisfies DirectFileFailed));
    this.options.onIncomingFileError?.({
      id: pending.meta.id,
      roomId: pending.meta.roomId,
      peerId: peer.id,
      fileName: pending.meta.fileName,
      size: pending.meta.size,
      transferredBytes: pending.received,
      direction: 'receive',
      error,
    });
  }

  private async failIncomingFilesForPeer(peer: DirectPeer, error: string): Promise<void> {
    const pendingIds = [...peer.files.keys()];
    await Promise.all(pendingIds.map((id) => this.failIncomingFile(peer, id, error)));
  }

  private async finishIncomingFile(peer: DirectPeer, id: string): Promise<void> {
    const pending = peer.files.get(id);
    if (!pending) {
      return;
    }
    peer.files.delete(id);
    try {
      await pending.writeChain;
      if (pending.received !== pending.meta.size) {
        throw new Error('文件接收不完整');
      }
      pending.progress.flush(pending.meta.size, pending.meta.size);
      if (pending.sink) {
        const result = await pending.sink.close();
        this.options.onIncomingFile({ ...pending.meta, url: result.url, savedToDisk: pending.sink.savedToDisk });
        peer.channel?.send(JSON.stringify({ type: 'file-done', id } satisfies DirectFileDone));
        pending.channel?.close();
        return;
      }
      const blob = new Blob(pending.chunks, { type: pending.meta.contentType });
      const url = URL.createObjectURL(blob);
      this.options.onIncomingFile({ ...pending.meta, url });
      peer.channel?.send(JSON.stringify({ type: 'file-done', id } satisfies DirectFileDone));
      pending.channel?.close();
    } catch {
      await pending.sink?.abort();
      pending.channel?.close();
      peer.channel?.send(JSON.stringify({ type: 'file-failed', id, error: '接收文件失败' } satisfies DirectFileFailed));
      this.options.onIncomingFileError?.({
        id: pending.meta.id,
        roomId: pending.meta.roomId,
        peerId: peer.id,
        fileName: pending.meta.fileName,
        size: pending.meta.size,
        transferredBytes: pending.received,
        direction: 'receive',
        error: '接收文件失败',
      });
    }
  }

  private recreatePeer(peer: DirectPeer): void {
    const nextAttempts = peer.reconnectAttempts + 1;
    const peerInfo = peer.peer;
    this.closePeer(peer.id);
    if (this.closed || nextAttempts > MAX_PEER_RECONNECT_ATTEMPTS) {
      return;
    }
    const nextPeer = this.ensurePeer(peerInfo, this.shouldInitiate(peerInfo.clientId));
    nextPeer.reconnectAttempts = nextAttempts;
  }

  private scheduleReconnect(peer: DirectPeer): void {
    if (this.closed || peer.reconnectTimerId || peer.reconnectAttempts >= MAX_PEER_RECONNECT_ATTEMPTS) {
      return;
    }
    peer.reconnectTimerId = window.setTimeout(() => {
      peer.reconnectTimerId = undefined;
      const current = this.peers.get(peer.id);
      if (!current || current !== peer || this.isPeerDirect(current)) {
        return;
      }
      this.recreatePeer(peer);
    }, PEER_RECONNECT_DELAY_MS);
  }

  private scheduleControlOpenCheck(peer: DirectPeer): void {
    if (this.closed || peer.controlOpenTimerId || this.isPeerDirect(peer) || peer.reconnectAttempts >= MAX_PEER_RECONNECT_ATTEMPTS) {
      return;
    }
    peer.controlOpenTimerId = window.setTimeout(() => {
      peer.controlOpenTimerId = undefined;
      const current = this.peers.get(peer.id);
      if (!current || current !== peer || this.isPeerDirect(current)) {
        return;
      }
      this.emitPeerState(peer, 'connecting', 'control_open_timeout');
      this.recreatePeer(peer);
    }, CONTROL_CHANNEL_OPEN_TIMEOUT_MS);
  }

  private clearControlOpenCheck(peer: DirectPeer): void {
    if (!peer.controlOpenTimerId) {
      return;
    }
    window.clearTimeout(peer.controlOpenTimerId);
    peer.controlOpenTimerId = undefined;
  }

  private isPeerDirect(peer: DirectPeer): boolean {
    return peer.pc.connectionState === 'connected' && peer.channel?.readyState === 'open';
  }

  private startPathPolling(peer: DirectPeer): void {
    if (peer.pathPollTimerId) {
      return;
    }
    void this.refreshPathInfo(peer);
    peer.pathPollTimerId = window.setInterval(() => {
      void this.refreshPathInfo(peer);
    }, PATH_POLL_INTERVAL_MS);
  }

  private stopPathPolling(peer: DirectPeer): void {
    if (!peer.pathPollTimerId) {
      return;
    }
    window.clearInterval(peer.pathPollTimerId);
    peer.pathPollTimerId = undefined;
  }

  private publishPathInfo(peer: DirectPeer, path: DirectPathInfo | null): void {
    const nextKey = buildPathInfoKey(path);
    if (peer.pathInfoKey === nextKey) {
      return;
    }
    peer.pathInfoKey = nextKey;
    peer.pathInfo = path;
    this.emitPeerState(peer, peer.channel?.readyState === 'open' ? 'direct' : 'connecting', path ? 'path_updated' : 'path_cleared');
  }

  private async refreshPathInfo(peer: DirectPeer): Promise<void> {
    if (peer.pc.connectionState !== 'connected') {
      return;
    }
    try {
      const stats = await peer.pc.getStats();
      const selectedPair = findSelectedCandidatePair(stats);
      if (!selectedPair) {
        return;
      }
      const localCandidateId = selectedPair.localCandidateId as string | undefined;
      const remoteCandidateId = selectedPair.remoteCandidateId as string | undefined;
      const localCandidate = localCandidateId ? (stats.get(localCandidateId) as Record<string, unknown> | undefined) : undefined;
      const remoteCandidate = remoteCandidateId ? (stats.get(remoteCandidateId) as Record<string, unknown> | undefined) : undefined;
      const localCandidateType =
        typeof localCandidate?.candidateType === 'string' ? localCandidate.candidateType : peer.lastLocalCandidate?.candidateType;
      const remoteCandidateType =
        typeof remoteCandidate?.candidateType === 'string' ? remoteCandidate.candidateType : peer.lastRemoteCandidate?.candidateType;
      const localAddress = readCandidateAddress(localCandidate) ?? peer.lastLocalCandidate?.address;
      const remoteAddress = readCandidateAddress(remoteCandidate) ?? peer.lastRemoteCandidate?.address;
      const protocol =
        (typeof localCandidate?.protocol === 'string' ? localCandidate.protocol : undefined) ??
        (typeof selectedPair.protocol === 'string' ? selectedPair.protocol : undefined) ??
        peer.lastLocalCandidate?.protocol ??
        peer.lastRemoteCandidate?.protocol;
      const roundTripTimeMs =
        typeof selectedPair.currentRoundTripTime === 'number'
          ? Math.round(selectedPair.currentRoundTripTime * 1000)
          : undefined;
      this.publishPathInfo(peer, {
        kind: classifyDirectPath(localCandidateType, remoteCandidateType, localAddress, remoteAddress),
        localCandidateType,
        remoteCandidateType,
        protocol,
        localAddress,
        remoteAddress,
        roundTripTimeMs,
      });
    } catch {
      // Stats can fail transiently while ICE is changing; keep the last known path.
    }
  }

  private closePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }
    this.clearPeerCloseTimer(peerId);
    for (const pending of peer.outgoingFiles.values()) {
      this.notifyTransferCancel(peer, pending.meta.id);
    }
    void this.failIncomingFilesForPeer(peer, '直连已断开，传输中断');
    this.stopPathPolling(peer);
    this.publishPathInfo(peer, null);
    if (peer.reconnectTimerId) {
      window.clearTimeout(peer.reconnectTimerId);
      peer.reconnectTimerId = undefined;
    }
    this.clearControlOpenCheck(peer);
    for (const pending of peer.files.values()) {
      pending.channel?.close();
      void pending.sink?.abort();
    }
    for (const pending of peer.outgoingFiles.values()) {
      this.clearOutgoingTimeout(pending);
      pending.channel?.close();
      pending.reject(new DOMException('Peer connection closed', 'AbortError'));
    }
    peer.files.clear();
    peer.outgoingFiles.clear();
    peer.channel?.close();
    peer.pc.close();
    this.peers.delete(peerId);
    this.emitPeerState(peer, 'offline', 'peer_closed');
  }

  private schedulePeerClose(peerId: string): void {
    if (this.peerCloseTimers.has(peerId)) {
      return;
    }
    const timer = window.setTimeout(() => {
      this.peerCloseTimers.delete(peerId);
      const peer = this.peers.get(peerId);
      if (!peer) {
        return;
      }
      if (peer.files.size > 0 || peer.outgoingFiles.size > 0 || peer.activeSendCount > 0) {
        this.schedulePeerClose(peerId);
        return;
      }
      this.closePeer(peerId);
    }, PEER_REAP_GRACE_MS);
    this.peerCloseTimers.set(peerId, timer);
  }

  private clearPeerCloseTimer(peerId: string): void {
    const timer = this.peerCloseTimers.get(peerId);
    if (timer) {
      window.clearTimeout(timer);
      this.peerCloseTimers.delete(peerId);
    }
  }
}

function buildPathInfoKey(path: DirectPathInfo | null): string {
  if (!path) {
    return 'none';
  }
  return [
    path.kind,
    path.localCandidateType ?? '-',
    path.remoteCandidateType ?? '-',
    path.protocol ?? '-',
    path.roundTripTimeMs ?? '-',
  ].join(':');
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
  if (
    isLocalNetworkCandidate(localCandidateType, localAddress) &&
    isLocalNetworkCandidate(remoteCandidateType, remoteAddress)
  ) {
    return 'lan';
  }
  if (isDirectCandidateType(localCandidateType) || isDirectCandidateType(remoteCandidateType)) {
    return 'stun';
  }
  return 'unknown';
}

function isDirectCandidateType(candidateType?: string): boolean {
  return candidateType === 'host' || candidateType === 'srflx' || candidateType === 'prflx';
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
    return { candidateType: directType, address: directAddress, protocol: directProtocol };
  }
  const parts = line.split(/\s+/);
  const typeIndex = parts.indexOf('typ');
  return {
    candidateType: directType ?? (typeIndex >= 0 && typeIndex + 1 < parts.length ? parts[typeIndex + 1] : undefined),
    address: directAddress ?? parts[4],
    protocol: directProtocol ?? parts[2],
  };
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
  return address.endsWith('.local') || isPrivateIpAddress(address);
}

function isPrivateIpAddress(value: string): boolean {
  const normalized = value.trim().replace(/^\[|\]$/g, '').split('%')[0];
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map((segment) => Number(segment));
    if ([a, b].some((segment) => Number.isNaN(segment))) {
      return false;
    }
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
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

function findSelectedCandidatePair(stats: RTCStatsReport): Record<string, unknown> | null {
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
    if (value.type === 'candidate-pair' && (value.selected === true || value.nominated === true || value.state === 'succeeded')) {
      pair = value;
    }
  });
  return pair;
}

async function sendFileChunks(channel: RTCDataChannel, file: File, options: DirectSendOptions): Promise<void> {
  let sent = 0;
  const stream = file.stream?.();
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        sent = await sendBytesInChunks(channel, value, sent, file.size, options);
      }
    }
    return;
  }
  const buffer = await file.arrayBuffer();
  await sendBytesInChunks(channel, new Uint8Array(buffer), sent, file.size, options);
}

async function sendBytesInChunks(
  channel: RTCDataChannel,
  bytes: Uint8Array,
  sentBytes: number,
  totalBytes: number,
  options: DirectSendOptions,
): Promise<number> {
  let sent = sentBytes;
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    await waitWhilePaused(options);
    throwIfAborted(options.signal);
    const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
    channel.send(chunk);
    sent += chunk.byteLength;
    options.onProgress?.(Math.min(sent, totalBytes), totalBytes);
    await waitForBuffer(channel);
  }
  return sent;
}

async function waitWhilePaused(options: DirectSendOptions): Promise<void> {
  while (options.isPaused?.()) {
    throwIfAborted(options.signal);
    await delay(120);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Transfer cancelled', 'AbortError');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForBuffer(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount < HIGH_WATER_MARK) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 500);
    channel.onbufferedamountlow = () => {
      window.clearTimeout(timeout);
      channel.onbufferedamountlow = null;
      resolve();
    };
  });
}

function createProgressReporter(callback?: (transferredBytes: number, totalBytes: number) => void): ProgressReporter {
  let lastEmit = 0;
  let lastBytes = -1;
  return {
    report(transferredBytes, totalBytes) {
      if (!callback) {
        return;
      }
      const now = Date.now();
      if (transferredBytes >= totalBytes || transferredBytes === 0 || now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now;
        lastBytes = transferredBytes;
        callback(transferredBytes, totalBytes);
      }
    },
    flush(transferredBytes, totalBytes) {
      if (!callback || lastBytes === transferredBytes) {
        return;
      }
      lastEmit = Date.now();
      lastBytes = transferredBytes;
      callback(transferredBytes, totalBytes);
    },
  };
}

async function toArrayBuffer(data: unknown): Promise<ArrayBuffer> {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }
  if (data instanceof Blob) {
    return data.arrayBuffer();
  }
  return new ArrayBuffer(0);
}
