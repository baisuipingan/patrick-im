import type { IceServer, Peer, SignalEnvelope } from '@shared/protocol';

export type DirectState = 'connecting' | 'direct' | 'offline';

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
  onIncomingFileStart?: (progress: DirectFileProgress) => void;
  onIncomingFileProgress?: (progress: DirectFileProgress) => void;
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
  activeFileId: string | null;
  activeSendCount: number;
  pendingCandidates: RTCIceCandidateInit[];
  files: Map<string, PendingIncomingFile>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  reconnectTimerId?: number;
  reconnectAttempts: number;
}

interface PendingIncomingFile {
  meta: DirectFileMeta;
  chunks: ArrayBuffer[];
  received: number;
  sink: IncomingDirectFileSink | null;
  writeChain: Promise<void>;
  progress: ProgressReporter;
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

interface DirectFileCancel {
  type: 'file-cancel';
  id: string;
}

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 8 * 1024 * 1024;
const LOW_WATER_MARK = 2 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;
const PEER_REAP_GRACE_MS = 8000;
const PEER_RECONNECT_DELAY_MS = 1200;
const MAX_PEER_RECONNECT_ATTEMPTS = 3;

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
        if (!peer.pc.remoteDescription) {
          peer.pendingCandidates.push(payload.candidate);
        } else {
          await peer.pc.addIceCandidate(payload.candidate);
        }
      }
    } catch {
      this.options.onStateChange(fromId, 'offline');
      this.scheduleReconnect(peer);
    } finally {
      peer.isSettingRemoteAnswerPending = false;
    }
  }

  async sendFile(peerId: string, file: File, options: DirectSendOptions = {}): Promise<boolean> {
    const peer = this.peers.get(peerId);
    const channel = peer?.channel;
    if (!peer || !channel || channel.readyState !== 'open') {
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
    channel.send(JSON.stringify(meta));
    progress.flush(0, file.size);
    try {
      await sendFileChunks(channel, file, {
        ...options,
        onProgress: progress.report,
      });
      channel.send(JSON.stringify({ type: 'file-done', id } satisfies DirectFileDone));
      progress.flush(file.size, file.size);
    } catch (error) {
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'file-cancel', id } satisfies DirectFileCancel));
      }
      throw error;
    } finally {
      peer.activeSendCount = Math.max(0, peer.activeSendCount - 1);
    }
    return true;
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
      activeFileId: null,
      activeSendCount: 0,
      pendingCandidates: [],
      files: new Map(),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      reconnectAttempts: 0,
    };
    this.peers.set(peer.clientId, directPeer);
    this.options.onStateChange(peer.clientId, 'connecting');

    pc.onnegotiationneeded = () => {
      void this.negotiate(directPeer);
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.sendSignal(peer.clientId, { candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        directPeer.reconnectAttempts = 0;
        this.options.onStateChange(peer.clientId, 'direct');
      } else if (state === 'failed') {
        this.options.onStateChange(peer.clientId, 'offline');
        this.scheduleReconnect(directPeer);
      } else if (state === 'closed') {
        this.options.onStateChange(peer.clientId, 'offline');
      } else if (state === 'disconnected') {
        this.options.onStateChange(peer.clientId, 'connecting');
      } else {
        this.options.onStateChange(peer.clientId, 'connecting');
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this.options.onStateChange(peer.clientId, 'offline');
        this.scheduleReconnect(directPeer);
      }
    };
    pc.ondatachannel = (event) => {
      this.attachChannel(directPeer, event.channel);
    };

    if (shouldOffer) {
      this.attachChannel(directPeer, pc.createDataChannel('patrick-im-file'));
    }
    return directPeer;
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
    channel.onopen = () => this.options.onStateChange(peer.id, 'direct');
    channel.onclose = () => this.options.onStateChange(peer.id, 'offline');
    channel.onerror = () => this.scheduleReconnect(peer);
    channel.onmessage = (event) => {
      void this.handleDataChannelMessage(peer, event.data);
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
      this.options.onStateChange(peer.id, 'offline');
      this.scheduleReconnect(peer);
    } finally {
      peer.makingOffer = false;
    }
  }

  private async handleDataChannelMessage(peer: DirectPeer, data: unknown): Promise<void> {
    if (typeof data === 'string') {
      let payload: DirectFileMeta | DirectFileDone | DirectFileCancel;
      try {
        payload = JSON.parse(data) as DirectFileMeta | DirectFileDone | DirectFileCancel;
      } catch {
        return;
      }
      if (payload.type === 'file-meta') {
        peer.activeFileId = payload.id;
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
        return;
      }
      if (payload.type === 'file-done') {
        await this.finishIncomingFile(peer, payload.id);
        return;
      }
      if (payload.type === 'file-cancel') {
        const pending = peer.files.get(payload.id);
        peer.files.delete(payload.id);
        void pending?.sink?.abort();
        if (peer.activeFileId === payload.id) {
          peer.activeFileId = null;
        }
      }
      return;
    }

    const activeId = peer.activeFileId;
    const pending = activeId ? peer.files.get(activeId) : null;
    if (!pending) {
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

  private async finishIncomingFile(peer: DirectPeer, id: string): Promise<void> {
    const pending = peer.files.get(id);
    if (!pending) {
      return;
    }
    peer.files.delete(id);
    if (peer.activeFileId === id) {
      peer.activeFileId = null;
    }
    try {
      await pending.writeChain;
      if (pending.received !== pending.meta.size) {
        throw new Error('文件接收不完整');
      }
      pending.progress.flush(pending.meta.size, pending.meta.size);
      if (pending.sink) {
        const result = await pending.sink.close();
        this.options.onIncomingFile({ ...pending.meta, url: result.url, savedToDisk: pending.sink.savedToDisk });
        return;
      }
      const blob = new Blob(pending.chunks, { type: pending.meta.contentType });
      const url = URL.createObjectURL(blob);
      this.options.onIncomingFile({ ...pending.meta, url });
    } catch {
      await pending.sink?.abort();
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
      if (!current || current !== peer || current.pc.connectionState === 'connected') {
        return;
      }
      this.recreatePeer(peer);
    }, PEER_RECONNECT_DELAY_MS);
  }

  private closePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }
    this.clearPeerCloseTimer(peerId);
    if (peer.reconnectTimerId) {
      window.clearTimeout(peer.reconnectTimerId);
      peer.reconnectTimerId = undefined;
    }
    for (const pending of peer.files.values()) {
      void pending.sink?.abort();
    }
    peer.channel?.close();
    peer.pc.close();
    this.peers.delete(peerId);
    this.options.onStateChange(peerId, 'offline');
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
      if (peer.activeFileId || peer.activeSendCount > 0) {
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
