import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomPeer, SignalEnvelope } from '@shared/protocol';
import { PeerMesh } from '@/lib/peer-mesh';

const peerConnectionInstances: MockPeerConnection[] = [];

class MockPeerConnection {
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  readonly addedCandidates: RTCIceCandidateInit[] = [];

  constructor(readonly configuration?: RTCConfiguration) {
    peerConnectionInstances.push(this);
  }

  createDataChannel(label: string): RTCDataChannel {
    return {
      label,
      readyState: 'connecting',
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer' };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  emitCandidate(candidate: RTCIceCandidateInit): void {
    this.onicecandidate?.({
      candidate: {
        toJSON: () => candidate,
      },
    } as RTCPeerConnectionIceEvent);
  }
}

function createMesh(overrides: Partial<ConstructorParameters<typeof PeerMesh>[0]> = {}): PeerMesh {
  return new PeerMesh({
    directFileSoftLimitBytes: 1024,
    localClientId: 'a-local',
    iceServers: [{ urls: ['stun:example.com:3478'] }],
    prepareIncomingFileTarget: vi.fn(async () => ({ mode: 'memory' as const })),
    onIncomingFile: vi.fn(),
    onPeerPathChange: vi.fn(),
    onPeerStateChange: vi.fn(),
    onTransferUpdate: vi.fn(),
    sendSignal: vi.fn(),
    ...overrides,
  });
}

function createPeer(): RoomPeer {
  return {
    clientId: 'z-remote',
    nickname: 'Remote',
    joinedAt: 1,
  };
}

function candidate(type: 'host' | 'srflx' | 'prflx' | 'relay'): RTCIceCandidateInit {
  const addressByType = {
    host: '192.168.1.8',
    srflx: '203.0.113.8',
    prflx: '203.0.113.9',
    relay: '198.51.100.8',
  };

  return {
    candidate: `candidate:1 1 udp 2122260223 ${addressByType[type]} 62000 typ ${type}`,
    sdpMid: '0',
    sdpMLineIndex: 0,
  };
}

describe('PeerMesh ICE candidate filtering', () => {
  beforeEach(() => {
    peerConnectionInstances.length = 0;
    vi.stubGlobal('RTCPeerConnection', MockPeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes configured STUN servers into RTCPeerConnection', () => {
    createMesh().ensurePeer(createPeer());

    expect(peerConnectionInstances[0]?.configuration?.iceServers).toEqual([{ urls: ['stun:example.com:3478'] }]);
  });

  it('forwards host, srflx, and prflx candidates but keeps relay candidates out of the direct path', () => {
    const sendSignal = vi.fn<(targetId: string, payload: SignalEnvelope) => void>();
    createMesh({ sendSignal }).ensurePeer(createPeer());
    const pc = peerConnectionInstances[0];

    pc.emitCandidate(candidate('host'));
    pc.emitCandidate(candidate('srflx'));
    pc.emitCandidate(candidate('prflx'));
    pc.emitCandidate(candidate('relay'));

    expect(sendSignal).toHaveBeenCalledTimes(3);
    expect(sendSignal.mock.calls.map(([, payload]) => payload.candidate?.candidate)).toEqual([
      candidate('host').candidate,
      candidate('srflx').candidate,
      candidate('prflx').candidate,
    ]);
  });

  it('accepts remote srflx candidates and ignores remote relay candidates', async () => {
    const mesh = createMesh();
    mesh.ensurePeer(createPeer());
    const pc = peerConnectionInstances[0];

    await mesh.handleSignal('z-remote', { description: { type: 'offer', sdp: 'offer' } }, 'Remote');
    await mesh.handleSignal('z-remote', { candidate: candidate('srflx') }, 'Remote');
    await mesh.handleSignal('z-remote', { candidate: candidate('relay') }, 'Remote');

    expect(pc.addedCandidates.map((item) => item.candidate)).toEqual([candidate('srflx').candidate]);
  });
});
