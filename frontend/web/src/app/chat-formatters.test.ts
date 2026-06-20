import { describe, expect, it } from 'vitest';
import {
  directPathDescription,
  directPathLabel,
  formatClockTime,
  formatTransferNote,
  getMessageThreadKey,
  socketStatusLabel,
  transportLabel,
} from '@/app/chat-formatters';
import type { ChatMessage } from '@shared/protocol';

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    roomId: 'room-1',
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

describe('chat-formatters', () => {
  it('maps socket status to chinese labels', () => {
    expect(socketStatusLabel('connected')).toBe('信令在线');
    expect(socketStatusLabel('paused')).toBe('信令待恢复');
    expect(socketStatusLabel('reconnecting')).toBe('信令重连中');
  });

  it('describes direct path kinds with current product wording', () => {
    expect(directPathLabel({ kind: 'lan' })).toBe('局域网直连');
    expect(directPathLabel({ kind: 'stun' })).toBe('公网直连');
    expect(directPathDescription({ kind: 'stun' })).toContain('数据不经过中继服务器');
    expect(directPathLabel({ kind: 'turn' })).toBe('中继');
    expect(directPathDescription({ kind: 'unknown' })).toContain('发送文件时会走中继');
  });

  it('maps transport and transfer notes to user-facing copy', () => {
    expect(transportLabel('direct-p2p')).toBe('局域网直连');
    expect(transportLabel('server-relay')).toBe('中继');
    expect(formatTransferNote('saved directly to receive directory')).toBe('已直接写入接收目录');
  });

  it('formats message timestamps with full date and time', () => {
    expect(formatClockTime(new Date(2026, 5, 20, 16, 13).getTime())).toBe('2026-06-20 16:13');
  });

  it('derives thread key for global and private messages', () => {
    expect(
      getMessageThreadKey(
        createMessage({
          targetId: null,
        }),
        'self',
      ),
    ).toBe('__global__');

    expect(
      getMessageThreadKey(
        createMessage({
          fromId: 'self',
          targetId: 'bob',
        }),
        'self',
      ),
    ).toBe('bob');

    expect(
      getMessageThreadKey(
        createMessage({
          fromId: 'bob',
          targetId: 'self',
        }),
        'self',
      ),
    ).toBe('bob');
  });
});
