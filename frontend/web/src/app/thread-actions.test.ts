import { describe, expect, it, vi } from 'vitest';
import {
  clearThreadMessages,
  clearThreadTransfers,
  formatThreadClearRemoteNotice,
  formatThreadClearSuccessNotice,
} from '@/app/thread-actions';
import type { TransferRow, UiMessage } from '@/app/types';

function createMessage(overrides: Partial<UiMessage>): UiMessage {
  return {
    id: 'm1',
    roomId: 'room-a',
    kind: 'text',
    fromId: 'alice',
    fromName: 'Alice',
    targetId: null,
    createdAt: 1,
    transport: 'server-sync',
    text: 'hello',
    ...overrides,
  };
}

describe('thread-actions', () => {
  it('clears messages in target thread and releases local urls', () => {
    const releaseObjectUrl = vi.fn();
    const messages: UiMessage[] = [
      createMessage({ id: 'g1', targetId: null }),
      createMessage({ id: 'p1', fromId: 'self', targetId: 'bob', localUrl: 'blob:1' }),
      createMessage({ id: 'p2', fromId: 'bob', targetId: 'self' }),
    ];

    const next = clearThreadMessages({
      messages,
      selfId: 'self',
      threadId: 'bob',
      releaseObjectUrl,
    });

    expect(next.map((message) => message.id)).toEqual(['g1']);
    expect(releaseObjectUrl).toHaveBeenCalledWith('blob:1');
  });

  it('clears transfers for a thread', () => {
    const rawTransfers = {
      a: { peerId: 'bob' },
      b: { peerId: '__global__' },
    };
    const typedTransfers = rawTransfers as unknown as Record<string, TransferRow>;

    expect(Object.keys(clearThreadTransfers('bob', typedTransfers))).toEqual(['b']);
  });

  it('formats thread clear notices', () => {
    expect(
      formatThreadClearSuccessNotice({
        targetId: 'bob',
        removedMessages: 2,
        removedRelayFiles: 1,
        getPeerDisplayName: () => 'Bob',
      }),
    ).toBe('已清空与 Bob 的私聊记录，并回收 1 个失去引用的中继文件。');

    expect(formatThreadClearRemoteNotice(null, 'Alice')).toBe('Alice 清空了当前房间的全局聊天记录。');
  });
});
