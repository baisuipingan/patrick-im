import type { IceServer, Peer, SignalEnvelope } from '@shared/protocol';

export type DirectState = 'connecting' | 'direct' | 'offline';

export interface IncomingDirectFile {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  targetId: string;
  fileName: string;
  size: number;
  contentType: string;
  createdAt: number;
  url: string;
}

interface DirectMeshOptions {
  selfId: string;
  selfName: string;
  roomId: string;
  iceServers: IceServer[];
  sendSignal: (targetId: string, payload: SignalEnvelope) => void;
  onStateChange: (peerId: string, state: DirectState) => void;
  onIncomingFile: (file: IncomingDirectFile) => void;
}

interface DirectPeer {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  activeFileId: string | null;
  pendingCandidates: RTCIceCandidateInit[];
  files: Map<string, PendingIncomingFile>;
}

interface PendingIncomingFile {
  meta: DirectFileMeta;
  chunks: ArrayBuffer[];
  received: number;
}

interface DirectFileMeta {
  type: 'file-meta';
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  targetId: string;
  fileName: string;
  size: number;
  contentType: string;
  createdAt: number;
}

interface DirectFileDone {
  type: 'file-done';
  id: string;
}

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 1024 * 1024;
const LOW_WATER_MARK = 256 * 1024;

export class DirectMesh {
  private readonly peers = new Map<string, DirectPeer>();
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
      this.ensurePeer(peer, this.options.selfId < peer.clientId);
    }
    for (const peerId of [...this.peers.keys()]) {
      if (!liveIds.has(peerId)) {
        this.closePeer(peerId);
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
        await peer.pc.setRemoteDescription(payload.description);
        await this.flushPendingCandidates(peer);
        if (payload.description.type === 'offer') {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          this.options.sendSignal(fromId, { description: answer });
        }
      }
      if (payload.candidate) {
        if (peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(payload.candidate);
        } else {
          peer.pendingCandidates.push(payload.candidate);
        }
      }
    } catch {
      this.options.onStateChange(fromId, 'offline');
    }
  }

  async sendFile(peerId: string, file: File): Promise<boolean> {
    const peer = this.peers.get(peerId);
    const channel = peer?.channel;
    if (!peer || !channel || channel.readyState !== 'open') {
      return false;
    }
    const id = crypto.randomUUID?.() ?? `direct-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const meta: DirectFileMeta = {
      type: 'file-meta',
      id,
      roomId: this.options.roomId,
      senderId: this.options.selfId,
      senderName: this.options.selfName,
      targetId: peerId,
      fileName: file.name || 'file',
      size: file.size,
      contentType: file.type || 'application/octet-stream',
      createdAt: Date.now(),
    };
    channel.send(JSON.stringify(meta));
    await sendFileChunks(channel, file);
    channel.send(JSON.stringify({ type: 'file-done', id } satisfies DirectFileDone));
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
      return existing;
    }

    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
    const directPeer: DirectPeer = {
      id: peer.clientId,
      name: peer.nickname || peer.clientId,
      pc,
      channel: null,
      activeFileId: null,
      pendingCandidates: [],
      files: new Map(),
    };
    this.peers.set(peer.clientId, directPeer);
    this.options.onStateChange(peer.clientId, 'connecting');

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.sendSignal(peer.clientId, { candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.options.onStateChange(peer.clientId, 'direct');
      } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.options.onStateChange(peer.clientId, 'offline');
      } else {
        this.options.onStateChange(peer.clientId, 'connecting');
      }
    };
    pc.ondatachannel = (event) => {
      this.attachChannel(directPeer, event.channel);
    };

    if (shouldOffer) {
      this.attachChannel(directPeer, pc.createDataChannel('patrick-im-file'));
      void this.createOffer(directPeer);
    }
    return directPeer;
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
    channel.onmessage = (event) => {
      void this.handleDataChannelMessage(peer, event.data);
    };
  }

  private async createOffer(peer: DirectPeer): Promise<void> {
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.options.sendSignal(peer.id, { description: offer });
    } catch {
      this.options.onStateChange(peer.id, 'offline');
    }
  }

  private async handleDataChannelMessage(peer: DirectPeer, data: unknown): Promise<void> {
    if (typeof data === 'string') {
      let payload: DirectFileMeta | DirectFileDone;
      try {
        payload = JSON.parse(data) as DirectFileMeta | DirectFileDone;
      } catch {
        return;
      }
      if (payload.type === 'file-meta') {
        peer.activeFileId = payload.id;
        peer.files.set(payload.id, { meta: payload, chunks: [], received: 0 });
        return;
      }
      if (payload.type === 'file-done') {
        this.finishIncomingFile(peer, payload.id);
      }
      return;
    }

    const activeId = peer.activeFileId;
    const pending = activeId ? peer.files.get(activeId) : null;
    if (!pending) {
      return;
    }
    const chunk = await toArrayBuffer(data);
    pending.chunks.push(chunk);
    pending.received += chunk.byteLength;
  }

  private finishIncomingFile(peer: DirectPeer, id: string): void {
    const pending = peer.files.get(id);
    if (!pending) {
      return;
    }
    peer.files.delete(id);
    if (peer.activeFileId === id) {
      peer.activeFileId = null;
    }
    const blob = new Blob(pending.chunks, { type: pending.meta.contentType });
    const url = URL.createObjectURL(blob);
    this.options.onIncomingFile({ ...pending.meta, url });
  }

  private closePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }
    peer.channel?.close();
    peer.pc.close();
    this.peers.delete(peerId);
    this.options.onStateChange(peerId, 'offline');
  }
}

async function sendFileChunks(channel: RTCDataChannel, file: File): Promise<void> {
  const stream = file.stream?.();
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        channel.send(value);
        await waitForBuffer(channel);
      }
    }
    return;
  }
  const buffer = await file.arrayBuffer();
  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
    channel.send(buffer.slice(offset, offset + CHUNK_SIZE));
    await waitForBuffer(channel);
  }
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
