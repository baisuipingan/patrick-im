import { describe, expect, it } from 'vitest';
import type { PendingAttachment } from '@/app/types';
import { buildDirectFileMessage, canUseDirectTransfer, collectSendPayload } from '@/app/send-actions';

describe('send-actions', () => {
  it('allows direct transfer only when all conditions match', () => {
    expect(
      canUseDirectTransfer({
        targetId: 'peer-1',
        directState: 'connected',
        fileSize: 100,
        effectiveTransferMode: 'auto',
        session: {
          clientId: 'self',
          nickname: 'Patrick',
          iceServers: [],
          relayFileLimitBytes: 1000,
          directFileSoftLimitBytes: 200,
          recommendedTransferMode: 'auto',
        },
      }),
    ).toBe(true);

    expect(
      canUseDirectTransfer({
        targetId: null,
        directState: 'connected',
        fileSize: 100,
        effectiveTransferMode: 'auto',
        session: {
          clientId: 'self',
          nickname: 'Patrick',
          iceServers: [],
          relayFileLimitBytes: 1000,
          directFileSoftLimitBytes: 200,
          recommendedTransferMode: 'auto',
        },
      }),
    ).toBe(false);
  });

  it('builds direct file message payload', () => {
    const message = buildDirectFileMessage({
      activeRoom: 'room-a',
      contentType: 'image/png',
      fileName: 'a.png',
      fileSize: 123,
      fromId: 'self',
      fromName: 'Patrick',
      localUrl: 'blob:test',
      targetId: 'peer-1',
      transferId: 'tx-1',
    });

    expect(message.kind).toBe('direct-file');
    expect(message.transport).toBe('direct-p2p');
    expect(message.file?.previewable).toBe(true);
    expect(message.localUrl).toBe('blob:test');
  });

  it('collects trimmed text and pending file snapshot', () => {
    const pendingFiles = [{ id: '1', file: new File(['a'], 'a.txt') }] as PendingAttachment[];
    const payload = collectSendPayload(' hello ', pendingFiles);

    expect(payload.text).toBe('hello');
    expect(payload.files).toHaveLength(1);
    expect(payload.files).not.toBe(pendingFiles);
  });
});
