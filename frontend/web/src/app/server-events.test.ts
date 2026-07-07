import { describe, expect, it, vi } from 'vitest';
import { handleServerEventMessage, type ServerEventHandlers } from '@/app/server-events';
import type { ChatMessage, RoomPeer, ServerToClientMessage } from '@shared/protocol';

function createHandlers(): ServerEventHandlers {
  return {
    activeRoom: 'room-a',
    selfId: 'self',
    acknowledgeRelayMessage: vi.fn(),
    addMessage: vi.fn(),
    addSystemMessage: vi.fn(),
    applyPeerState: vi.fn(),
    clearThreadLocally: vi.fn(),
    flushRelayAnnounces: vi.fn(),
    formatThreadClearRemoteNotice: vi.fn().mockReturnValue('remote cleared'),
    getPeerDisplayName: vi.fn((peerId: string, fallback?: string) => fallback ?? peerId),
    getThreadKeyForClearedEvent: vi.fn().mockReturnValue('thread-x'),
    handleSignal: vi.fn(),
    replaceMessages: vi.fn(),
    replacePeers: vi.fn(),
    replacePeerNames: vi.fn(),
    reconcileSnapshotPeers: vi.fn(),
    setClearDialogOpen: vi.fn(),
    setNotice: vi.fn(),
    upsertPeer: vi.fn().mockReturnValue(false),
    removePeer: vi.fn(),
  };
}

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
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

describe('server-events', () => {
  it('hydrates room snapshot and flushes pending relay announces', () => {
    const handlers = createHandlers();
    const peer: RoomPeer = { clientId: 'alice', nickname: 'Alice', joinedAt: 1 };
    const event: ServerToClientMessage = {
      type: 'room-snapshot',
      roomId: 'room-a',
      peers: [peer],
      messages: [
        createMessage({
          kind: 'relay-file',
          file: {
            fileId: 'file-1',
            fileName: 'a.png',
            size: 1,
            contentType: 'image/png',
            objectKey: 'obj/a.png',
            fromId: 'alice',
            fromName: 'Alice',
            createdAt: 1,
            targetId: null,
            previewable: true,
          },
        }),
      ],
      serverTime: 1,
    };

    handleServerEventMessage(event, handlers);

    expect(handlers.acknowledgeRelayMessage).toHaveBeenCalledWith('file-1');
    expect(handlers.replaceMessages).toHaveBeenCalledTimes(1);
    expect(handlers.replacePeers).toHaveBeenCalledWith([peer]);
    expect(handlers.reconcileSnapshotPeers).toHaveBeenCalledWith([peer]);
    expect(handlers.flushRelayAnnounces).toHaveBeenCalledWith('room-a');
  });

  it('handles peer join and leave events', () => {
    const handlers = createHandlers();

    handleServerEventMessage(
      {
        type: 'peer-joined',
        peer: { clientId: 'alice', nickname: 'Alice', joinedAt: 1 },
      },
      handlers,
    );
    expect(handlers.upsertPeer).toHaveBeenCalled();
    expect(handlers.addSystemMessage).toHaveBeenCalledWith('Alice 进入了房间。');

    handleServerEventMessage(
      {
        type: 'peer-left',
        clientId: 'alice',
      },
      handlers,
    );
    expect(handlers.removePeer).toHaveBeenCalledWith('alice');
    expect(handlers.applyPeerState).toHaveBeenCalledWith('alice', 'offline');
  });

  it('closes clear dialog when current user cleared thread', () => {
    const handlers = createHandlers();

    handleServerEventMessage(
      {
        type: 'thread-cleared',
        targetId: null,
        actorId: 'self',
        actorName: 'Self',
        removedMessages: 1,
        removedRelayFiles: 0,
      },
      handlers,
    );

    expect(handlers.clearThreadLocally).toHaveBeenCalledWith('thread-x');
    expect(handlers.setClearDialogOpen).toHaveBeenCalledWith(false);
  });
});
