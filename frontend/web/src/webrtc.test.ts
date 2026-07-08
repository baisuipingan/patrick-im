import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Peer, SignalEnvelope } from '@shared/protocol';
import { DirectMesh } from './webrtc';

const peerConnectionInstances: MockPeerConnection[] = [];

class MockDataChannel {
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = 'connecting';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onbufferedamountlow: ((event: Event) => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(readonly label: string) {}

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
    this.onclose?.(new Event('close'));
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.(new Event('open'));
  }

  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

class MockPeerConnection {
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  readonly channels: MockDataChannel[] = [];
  stats = new Map<string, Record<string, unknown>>();

  constructor(readonly configuration?: RTCConfiguration) {
    peerConnectionInstances.push(this);
  }

  createDataChannel(label: string): RTCDataChannel {
    const channel = new MockDataChannel(label);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
    const next =
      description ??
      (this.remoteDescription?.type === 'offer'
        ? ({ type: 'answer', sdp: 'answer' } satisfies RTCSessionDescriptionInit)
        : ({ type: 'offer', sdp: 'offer' } satisfies RTCSessionDescriptionInit));
    this.localDescription = next as RTCSessionDescriptionInit;
    this.signalingState = next.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  async getStats(): Promise<RTCStatsReport> {
    return this.stats as unknown as RTCStatsReport;
  }

  close(): void {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }

  emitRemoteChannel(channel: MockDataChannel): void {
    this.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent);
  }
}

function createMesh(overrides: Partial<ConstructorParameters<typeof DirectMesh>[0]> = {}): DirectMesh {
  return new DirectMesh({
    selfId: 'z-local',
    selfName: 'Local',
    roomId: 'room-1',
    iceServers: [{ urls: ['stun:example.com:3478'] }],
    sendSignal: vi.fn(),
    onStateChange: vi.fn(),
    onIncomingFile: vi.fn(),
    ...overrides,
  });
}

function createPeer(id = 'a-remote'): Peer {
  return {
    clientId: id,
    nickname: 'Remote',
    joinedAt: 1,
  };
}

function candidate(): RTCIceCandidateInit {
  return {
    candidate: 'candidate:1 1 udp 2122260223 192.168.1.8 62000 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  };
}

function testFile(name: string, text: string, type: string): File {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as unknown as File;
}

function parseSentControl(channel: MockDataChannel, index: number): { type: string; id?: string; fileName?: string } {
  return JSON.parse(String(channel.sent[index]));
}

describe('DirectMesh WebRTC negotiation', () => {
  beforeEach(() => {
    peerConnectionInstances.length = 0;
    vi.stubGlobal('RTCPeerConnection', MockPeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses configured ICE servers and sends an offer from the deterministic initiator', async () => {
    const sendSignal = vi.fn<(targetId: string, payload: SignalEnvelope) => void>();
    const onPeerSnapshot = vi.fn();
    const mesh = createMesh({ sendSignal, onPeerSnapshot });

    mesh.setPeers([createPeer()]);
    const pc = peerConnectionInstances[0];
    await pc.onnegotiationneeded?.();

    expect(pc.configuration?.iceServers).toEqual([{ urls: ['stun:example.com:3478'] }]);
    expect(sendSignal).toHaveBeenCalledWith('a-remote', { description: { type: 'offer', sdp: 'offer' } });
    expect(onPeerSnapshot).toHaveBeenCalledWith('a-remote', expect.objectContaining({
      state: 'connecting',
      iceConnectionState: 'new',
      signalingState: 'stable',
    }));
  });

  it('publishes direct path diagnostics from the selected candidate pair', async () => {
    const onPeerSnapshot = vi.fn();
    const mesh = createMesh({ onPeerSnapshot });

    mesh.setPeers([createPeer()]);
    const pc = peerConnectionInstances[0];
    const control = pc.channels[0];
    pc.stats = new Map([
      ['transport-1', { type: 'transport', selectedCandidatePairId: 'pair-1' }],
      ['pair-1', {
        type: 'candidate-pair',
        localCandidateId: 'local-1',
        remoteCandidateId: 'remote-1',
        currentRoundTripTime: 0.012,
        state: 'succeeded',
      }],
      ['local-1', { type: 'local-candidate', candidateType: 'host', address: '192.168.1.8', protocol: 'udp' }],
      ['remote-1', { type: 'remote-candidate', candidateType: 'host', address: '192.168.1.9', protocol: 'udp' }],
    ]);
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    control.open();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(onPeerSnapshot).toHaveBeenCalledWith('a-remote', expect.objectContaining({
      path: expect.objectContaining({
        kind: 'lan',
        roundTripTimeMs: 12,
      }),
    }));
  });

  it('queues remote ICE candidates until the offer arrives, then answers and flushes candidates', async () => {
    const sendSignal = vi.fn<(targetId: string, payload: SignalEnvelope) => void>();
    const mesh = createMesh({ selfId: 'a-local', sendSignal });

    await mesh.handleSignal('z-remote', { candidate: candidate() });
    await mesh.handleSignal('z-remote', { description: { type: 'offer', sdp: 'offer' } });

    const pc = peerConnectionInstances[0];
    expect(pc.addedCandidates).toEqual([candidate()]);
    expect(sendSignal).toHaveBeenCalledWith('z-remote', { description: { type: 'answer', sdp: 'answer' } });
  });
});

describe('DirectMesh direct file transfer', () => {
  beforeEach(() => {
    peerConnectionInstances.length = 0;
    vi.stubGlobal('RTCPeerConnection', MockPeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends file metadata over the control channel, streams over a file channel, and resolves after receiver ack', async () => {
    const mesh = createMesh();
    mesh.setPeers([createPeer()]);
    const pc = peerConnectionInstances[0];
    const control = pc.channels[0];
    control.open();

    const file = testFile('hello.txt', 'hello', 'text/plain');
    const result = mesh.sendFile('a-remote', file, { transferId: 'transfer-1' });

    expect(parseSentControl(control, 0)).toMatchObject({
      type: 'file-meta',
      id: 'transfer-1',
      fileName: 'hello.txt',
    });

    control.receive(JSON.stringify({ type: 'file-accept', id: 'transfer-1' }));
    const fileChannel = pc.channels[1];
    expect(fileChannel.label).toBe('patrick-im-file:transfer-1');
    fileChannel.open();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(fileChannel.sent.some((item) => item instanceof Uint8Array)).toBe(true);
    expect(fileChannel.sent.map((item) => (typeof item === 'string' ? JSON.parse(item).type : 'binary'))).toContain('file-done');

    control.receive(JSON.stringify({ type: 'file-done', id: 'transfer-1' }));
    await expect(result).resolves.toBe(true);
  });

  it('prepares an incoming file, writes chunks, emits the received file, and sends completion ack', async () => {
    const onIncomingFile = vi.fn();
    const writes: ArrayBuffer[] = [];
    const mesh = createMesh({
      selfId: 'a-local',
      onIncomingFile,
      createIncomingFileSink: vi.fn(async () => ({
        savedToDisk: true,
        write: async (chunk: ArrayBuffer) => {
          writes.push(chunk);
        },
        close: async () => ({}),
        abort: async () => undefined,
      })),
    });
    await mesh.handleSignal('z-remote', { description: { type: 'offer', sdp: 'offer' } });
    const pc = peerConnectionInstances[0];
    const control = pc.channels[0] ?? new MockDataChannel('patrick-im-file-control');
    pc.emitRemoteChannel(control);
    control.open();

    control.receive(JSON.stringify({
      type: 'file-meta',
      id: 'incoming-1',
      roomId: 'room-1',
      senderId: 'z-remote',
      senderName: 'Remote',
      targetId: 'a-local',
      fileName: 'incoming.txt',
      size: 5,
      contentType: 'text/plain',
      createdAt: 1,
    }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(parseSentControl(control, 0)).toMatchObject({ type: 'file-accept', id: 'incoming-1' });

    const fileChannel = new MockDataChannel('patrick-im-file:incoming-1');
    pc.emitRemoteChannel(fileChannel);
    fileChannel.open();
    fileChannel.receive(new TextEncoder().encode('hello'));
    fileChannel.receive(JSON.stringify({ type: 'file-done', id: 'incoming-1' }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(writes).toHaveLength(1);
    expect(onIncomingFile).toHaveBeenCalledWith(expect.objectContaining({
      id: 'incoming-1',
      fileName: 'incoming.txt',
      savedToDisk: true,
    }));
    expect(control.sent.map((item) => JSON.parse(String(item)).type)).toContain('file-done');
  });
});
