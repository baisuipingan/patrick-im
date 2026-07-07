import type { ChatMessage, Peer } from '@shared/protocol';

export const GLOBAL_THREAD = '__global__';

export function normalizeRoomId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return normalized || 'lobby';
}

export function roomFromHash(fallback = 'lobby'): string {
  if (typeof window === 'undefined') {
    return fallback;
  }
  return normalizeRoomId(decodeURIComponent(window.location.hash.replace(/^#/, '')) || fallback);
}

export function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const existing = messages.some((item) => item.id === message.id);
  const next = existing ? messages.map((item) => (item.id === message.id ? message : item)) : [...messages, message];
  return next.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function messageBelongsToThread(message: ChatMessage, selfId: string, threadId: string): boolean {
  if (threadId === GLOBAL_THREAD) {
    return !message.targetId;
  }
  return (
    (message.senderId === selfId && message.targetId === threadId) ||
    (message.senderId === threadId && message.targetId === selfId)
  );
}

export function visibleMessages(messages: ChatMessage[], selfId: string, threadId: string): ChatMessage[] {
  return messages.filter((message) => messageBelongsToThread(message, selfId, threadId));
}

export function clearThreadMessages(messages: ChatMessage[], selfId: string, threadId: string): ChatMessage[] {
  return messages.filter((message) => !messageBelongsToThread(message, selfId, threadId));
}

export function threadForClearEvent(selfId: string, actorId?: string, targetId?: string | null): string {
  if (!targetId) {
    return GLOBAL_THREAD;
  }
  if (targetId === selfId) {
    return actorId || GLOBAL_THREAD;
  }
  return targetId;
}

export function peerName(peers: Peer[], peerId: string, fallback = peerId): string {
  return peers.find((peer) => peer.clientId === peerId)?.nickname ?? fallback;
}
