import { describe, expect, it } from 'vitest';
import type { DirectPeerState, RoomPeer } from '@shared/protocol';
import {
  appendMessageState,
  applyPeerPathUpdate,
  applyPeerStateUpdate,
  buildDefaultNotice,
  clearThreadUnreadCount,
  closeTransferRow,
  reconcileSnapshotPeerState,
  removePeerFromList,
  upsertPeerList,
} from '@/app/room-state';
import type { TransferRow, UiMessage } from '@/app/types';
import type { DirectPathInfo } from '@/lib/peer-mesh';

function createMessage(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: 'm1',
    roomId: 'room-a',
    kind: 'text',
    fromId: 'alice',
    fromName: 'Alice',
    targetId: null,
    createdAt: 1,
    transport: 'server-sync',
    text: 'hi',
    ...overrides,
  };
}

function createPath(label: string): DirectPathInfo {
  return {
    kind: 'lan',
    protocol: 'udp',
    localAddress: `10.0.0.${label}`,
    remoteAddress: `10.0.0.${label}`,
    localCandidateType: 'host',
    remoteCandidateType: 'host',
  };
}

describe('room-state', () => {
  it('builds default notice from room id', () => {
    expect(buildDefaultNotice(null)).toContain('把两个浏览器打开到同一个房间');
    expect(buildDefaultNotice('abc')).toBe('已进入房间 abc。全局聊天发给整个房间，切到设备会话后就是和该设备的私聊。');
  });

  it('appends message and increments unread for inactive thread', () => {
    const result = appendMessageState({
      messages: [],
      message: createMessage({ targetId: 'bob' }),
      selfId: 'self',
      activeThread: '__global__',
      unreadCounts: {},
      trackUnread: true,
    });

    expect(result.inserted).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.unreadCounts).toEqual({ alice: 1 });
  });

  it('deduplicates messages by id', () => {
    const message = createMessage();
    const result = appendMessageState({
      messages: [message],
      message,
      selfId: 'self',
      activeThread: '__global__',
      unreadCounts: {},
      trackUnread: true,
    });

    expect(result.inserted).toBe(false);
    expect(result.messages).toHaveLength(1);
  });

  it('clears unread counts for a thread', () => {
    expect(clearThreadUnreadCount({ a: 1, b: 2 }, 'a')).toEqual({ b: 2 });
  });

  it('drops peer path when peer leaves connected state', () => {
    const stateResult = applyPeerStateUpdate({
      directPaths: { alice: createPath('1') },
      directStates: { alice: 'connected' as DirectPeerState },
      nextState: 'failed',
      peerId: 'alice',
    });

    expect(stateResult.directStates.alice).toBe('failed');
    expect(stateResult.directPaths).toEqual({});
  });

  it('updates and clears peer path', () => {
    const updated = applyPeerPathUpdate({
      directPaths: {},
      path: createPath('2'),
      peerId: 'alice',
    });
    expect(updated.alice?.kind).toBe('lan');

    const cleared = applyPeerPathUpdate({
      directPaths: updated,
      path: null,
      peerId: 'alice',
    });
    expect(cleared).toEqual({});
  });

  it('reconciles snapshot peers against direct state maps', () => {
    const peer: RoomPeer = { clientId: 'alice', nickname: 'Alice', joinedAt: 1 };
    const result = reconcileSnapshotPeerState({
      directStates: { alice: 'connected', bob: 'connecting' as DirectPeerState },
      directPaths: { alice: createPath('1'), bob: createPath('2') },
      peers: [peer],
    });

    expect(result.directStates).toEqual({ alice: 'connected' });
    expect(result.directPaths).toEqual({ alice: createPath('1') });
  });

  it('upserts and removes peers in sorted order', () => {
    const peers: RoomPeer[] = [{ clientId: 'b', nickname: 'B', joinedAt: 2 }];
    const upserted = upsertPeerList(peers, { clientId: 'a', nickname: 'A', joinedAt: 1 });
    expect(upserted.map((peer) => peer.clientId)).toEqual(['a', 'b']);
    expect(removePeerFromList(upserted, 'a').map((peer) => peer.clientId)).toEqual(['b']);
  });

  it('closes transfer row by id', () => {
    const transfer: TransferRow = {
      id: 't1',
      transferId: 't1',
      direction: 'upload',
      transport: 'server-relay',
      peerId: 'alice',
      peerName: 'Alice',
      fileName: 'a.txt',
      totalBytes: 10,
      transferredBytes: 5,
      status: 'streaming',
      startedAt: 1,
    };

    expect(closeTransferRow({ t1: transfer }, 't1')).toEqual({});
  });
});
