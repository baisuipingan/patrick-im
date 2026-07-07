import type { DirectPeerState, RoomPeer } from '@shared/protocol';
import { getMessageThreadKey } from '@/app/chat-formatters';
import type { TransferRow, UiMessage } from '@/app/types';
import type { DirectPathInfo } from '@/lib/peer-mesh';

const DEFAULT_NOTICE = '把两个浏览器打开到同一个房间后，就可以开始发文字、图片和文件了。';

export function buildDefaultNotice(roomId: string | null): string {
  if (!roomId) {
    return DEFAULT_NOTICE;
  }
  return `已进入房间 ${roomId}。全局聊天发给整个房间，切到设备会话后就是和该设备的私聊。`;
}

export function appendMessageState(options: {
  messages: UiMessage[];
  message: UiMessage;
  selfId: string | undefined;
  activeThread: string;
  unreadCounts: Record<string, number>;
  trackUnread: boolean;
}): {
  messages: UiMessage[];
  unreadCounts: Record<string, number>;
  inserted: boolean;
} {
  const { activeThread, message, messages, selfId, trackUnread, unreadCounts } = options;
  if (messages.some((item) => item.id === message.id)) {
    return {
      messages,
      unreadCounts,
      inserted: false,
    };
  }

  const nextMessages = [...messages, message];
  if (!trackUnread || message.fromId === selfId) {
    return {
      messages: nextMessages,
      unreadCounts,
      inserted: true,
    };
  }

  const threadKey = getMessageThreadKey(message, selfId);
  if (threadKey === activeThread) {
    return {
      messages: nextMessages,
      unreadCounts,
      inserted: true,
    };
  }

  return {
    messages: nextMessages,
    unreadCounts: {
      ...unreadCounts,
      [threadKey]: (unreadCounts[threadKey] ?? 0) + 1,
    },
    inserted: true,
  };
}

export function clearThreadUnreadCount(
  unreadCounts: Record<string, number>,
  threadId: string,
): Record<string, number> {
  if (!(threadId in unreadCounts)) {
    return unreadCounts;
  }

  const next = { ...unreadCounts };
  delete next[threadId];
  return next;
}

export function applyPeerStateUpdate(options: {
  directPaths: Record<string, DirectPathInfo>;
  directStates: Record<string, DirectPeerState>;
  nextState: DirectPeerState;
  peerId: string;
}): {
  directPaths: Record<string, DirectPathInfo>;
  directStates: Record<string, DirectPeerState>;
} {
  const { directPaths, directStates, nextState, peerId } = options;
  const nextDirectStates = {
    ...directStates,
    [peerId]: nextState,
  };

  if (nextState === 'connected' || !(peerId in directPaths)) {
    return {
      directPaths,
      directStates: nextDirectStates,
    };
  }

  const nextDirectPaths = { ...directPaths };
  delete nextDirectPaths[peerId];
  return {
    directPaths: nextDirectPaths,
    directStates: nextDirectStates,
  };
}

export function applyPeerPathUpdate(options: {
  directPaths: Record<string, DirectPathInfo>;
  path: DirectPathInfo | null;
  peerId: string;
}): Record<string, DirectPathInfo> {
  const { directPaths, path, peerId } = options;
  if (!path) {
    if (!(peerId in directPaths)) {
      return directPaths;
    }

    const next = { ...directPaths };
    delete next[peerId];
    return next;
  }

  return {
    ...directPaths,
    [peerId]: path,
  };
}

export function reconcileSnapshotPeerState(options: {
  directPaths: Record<string, DirectPathInfo>;
  directStates: Record<string, DirectPeerState>;
  peers: RoomPeer[];
}): {
  directPaths: Record<string, DirectPathInfo>;
  directStates: Record<string, DirectPeerState>;
} {
  const livePeerIds = new Set(options.peers.map((peer) => peer.clientId));

  return {
    directStates: Object.fromEntries(
      Object.entries(options.directStates).filter(([peerId]) => livePeerIds.has(peerId)),
    ),
    directPaths: Object.fromEntries(
      Object.entries(options.directPaths).filter(([peerId]) => livePeerIds.has(peerId)),
    ),
  };
}

export function upsertPeerList(peers: RoomPeer[], peer: RoomPeer): RoomPeer[] {
  const next = peers.filter((item) => item.clientId !== peer.clientId);
  next.push(peer);
  return next.sort((left, right) => left.joinedAt - right.joinedAt);
}

export function removePeerFromList(peers: RoomPeer[], peerId: string): RoomPeer[] {
  return peers.filter((peer) => peer.clientId !== peerId);
}

export function closeTransferRow(
  transfers: Record<string, TransferRow>,
  transferId: string,
): Record<string, TransferRow> {
  if (!(transferId in transfers)) {
    return transfers;
  }

  const next = { ...transfers };
  delete next[transferId];
  return next;
}
