import { describe, expect, it } from 'vitest';
import {
  GLOBAL_THREAD,
  clearThreadMessages,
  normalizeRoomId,
  threadForClearEvent,
  upsertMessage,
  visibleMessages,
} from './app-model';
import type { ChatMessage } from '@shared/protocol';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    roomId: 'room',
    kind: 'text',
    senderId: 'alice',
    senderName: 'Alice',
    targetId: null,
    text: 'hello',
    createdAt: 1,
    ...overrides,
  };
}

describe('app model', () => {
  it('normalizes room ids', () => {
    expect(normalizeRoomId(' Room 111 ')).toBe('room-111');
    expect(normalizeRoomId('')).toBe('lobby');
  });

  it('upserts messages by id and sorts by time', () => {
    const result = upsertMessage([message({ id: 'b', createdAt: 2 })], message({ id: 'a', createdAt: 1 }));
    expect(result.map((item) => item.id)).toEqual(['a', 'b']);
    expect(upsertMessage(result, message({ id: 'a', text: 'edited', createdAt: 1 }))[0].text).toBe('edited');
  });

  it('filters global and private threads', () => {
    const messages = [
      message({ id: 'global', targetId: null }),
      message({ id: 'private', senderId: 'self', targetId: 'bob' }),
    ];
    expect(visibleMessages(messages, 'self', GLOBAL_THREAD).map((item) => item.id)).toEqual(['global']);
    expect(visibleMessages(messages, 'self', 'bob').map((item) => item.id)).toEqual(['private']);
    expect(clearThreadMessages(messages, 'self', 'bob').map((item) => item.id)).toEqual(['global']);
  });

  it('maps clear events to the receiver local thread', () => {
    expect(threadForClearEvent('alice', 'alice', null)).toBe(GLOBAL_THREAD);
    expect(threadForClearEvent('alice', 'alice', 'bob')).toBe('bob');
    expect(threadForClearEvent('bob', 'alice', 'bob')).toBe('alice');
  });
});
