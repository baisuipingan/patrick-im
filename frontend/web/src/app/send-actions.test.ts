import { describe, expect, it } from 'vitest';
import type { PendingAttachment } from '@/app/types';
import {
  MAX_CHAT_TEXT_BYTES,
  TEXT_ATTACHMENT_THRESHOLD_BYTES,
  buildDirectFileMessage,
  canUseDirectTransfer,
  collectSendPayload,
  createTextAttachmentFile,
  getChatTextByteLength,
  isChatTextWithinLimit,
  shouldSendTextAsAttachment,
} from '@/app/send-actions';

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

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

  it('validates chat text by utf-8 byte length', () => {
    expect(getChatTextByteLength('Patrick')).toBe(7);
    expect(getChatTextByteLength('你好')).toBe(6);
    expect(isChatTextWithinLimit('a'.repeat(MAX_CHAT_TEXT_BYTES))).toBe(true);
    expect(isChatTextWithinLimit(`${'a'.repeat(MAX_CHAT_TEXT_BYTES)}b`)).toBe(false);
  });

  it('uses txt attachments above the chat text comfort threshold', () => {
    expect(shouldSendTextAsAttachment('a'.repeat(TEXT_ATTACHMENT_THRESHOLD_BYTES))).toBe(false);
    expect(shouldSendTextAsAttachment(`${'a'.repeat(TEXT_ATTACHMENT_THRESHOLD_BYTES)}b`)).toBe(true);
  });

  it('creates a timestamped txt attachment for oversized text', async () => {
    const file = createTextAttachmentFile('hello', new Date('2026-06-02T03:04:05'));

    expect(file.name).toBe('message-20260602-030405.txt');
    expect(file.type).toBe('text/plain;charset=utf-8');
    expect(await readFileAsText(file)).toBe('hello');
  });
});
