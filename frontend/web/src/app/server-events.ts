import type {
  DirectPeerState,
  RoomPeer,
  ServerToClientMessage,
  SignalEnvelope,
} from '@shared/protocol';
import type { UiMessage } from '@/app/types';

export interface ServerEventHandlers {
  activeRoom: string | null;
  selfId?: string;
  acknowledgeRelayMessage: (fileId: string) => void;
  addMessage: (message: UiMessage) => void;
  addSystemMessage: (text: string) => void;
  applyPeerState: (peerId: string, state: DirectPeerState) => void;
  clearThreadLocally: (threadId: string) => void;
  flushRelayAnnounces: (roomId: string) => void;
  formatThreadClearRemoteNotice: (targetId: string | null, actorName: string) => string;
  getPeerDisplayName: (peerId: string, fallback?: string) => string;
  getThreadKeyForClearedEvent: (targetId: string | null, actorId: string, selfId: string | undefined) => string;
  handleSignal: (fromId: string, payload: SignalEnvelope, peerName?: string) => void;
  replaceMessages: (messages: UiMessage[]) => void;
  replacePeers: (peers: RoomPeer[]) => void;
  replacePeerNames: (peerNames: Record<string, string>) => void;
  reconcileSnapshotPeers: (peers: RoomPeer[]) => void;
  setClearDialogOpen: (open: boolean) => void;
  setNotice: (notice: string | ((current: string) => string)) => void;
  upsertPeer: (peer: RoomPeer) => boolean;
  removePeer: (peerId: string) => void;
}

export function handleServerEventMessage(event: ServerToClientMessage, handlers: ServerEventHandlers): void {
  switch (event.type) {
    case 'room-snapshot': {
      const peers = Array.isArray(event.peers) ? event.peers.filter(Boolean) : [];
      const messages = Array.isArray(event.messages) ? event.messages.filter(Boolean) : [];
      const peerNames = Object.fromEntries(peers.map((peer) => [peer.clientId, peer.nickname]));
      for (const message of messages) {
        peerNames[message.fromId] = message.fromName;
        if (message.targetId) {
          peerNames[message.targetId] = peerNames[message.targetId] ?? message.targetId;
        }
        if (message.file?.fileId) {
          handlers.acknowledgeRelayMessage(message.file.fileId);
        }
      }

      handlers.replacePeerNames(peerNames);
      handlers.replaceMessages(messages);
      handlers.replacePeers(peers);
      handlers.reconcileSnapshotPeers(peers);
      handlers.setNotice((current) =>
        /^正在进入房间\s+.+/.test(current)
          ? `已进入房间 ${handlers.activeRoom ?? event.roomId}。全局聊天发给整个房间，切到设备会话后就是和该设备的私聊。`
          : current,
      );
      handlers.flushRelayAnnounces(event.roomId);
      break;
    }
    case 'peer-joined': {
      const existed = handlers.upsertPeer(event.peer);
      if (!existed) {
        handlers.addSystemMessage(`${event.peer.nickname} 进入了房间。`);
      }
      break;
    }
    case 'peer-left': {
      const peerName = handlers.getPeerDisplayName(event.clientId, event.clientId);
      handlers.removePeer(event.clientId);
      handlers.applyPeerState(event.clientId, 'offline');
      handlers.addSystemMessage(`${peerName} 离开了房间。`);
      break;
    }
    case 'chat-event':
      if (!event.message) {
        handlers.setNotice('收到异常消息事件，请刷新后重试。');
        break;
      }
      if (event.message.file?.fileId) {
        handlers.acknowledgeRelayMessage(event.message.file.fileId);
      }
      handlers.addMessage(event.message);
      break;
    case 'thread-cleared': {
      const clearedThread = handlers.getThreadKeyForClearedEvent(event.targetId, event.actorId, handlers.selfId);
      handlers.clearThreadLocally(clearedThread);
      if (event.actorId === handlers.selfId) {
        handlers.setClearDialogOpen(false);
      } else {
        handlers.setNotice(
          handlers.formatThreadClearRemoteNotice(
            event.targetId,
            handlers.getPeerDisplayName(event.actorId, event.actorName),
          ),
        );
      }
      break;
    }
    case 'signal':
      handlers.handleSignal(event.fromId, event.payload, handlers.getPeerDisplayName(event.fromId, event.fromId));
      break;
    case 'error':
      handlers.setNotice(event.message);
      break;
    default:
      break;
  }
}
