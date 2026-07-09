import { describe, expect, it } from 'vitest';
import {
  byteLength,
  createTextAttachmentFile,
  shouldSendTextAsAttachment,
} from './send-actions';

describe('send actions', () => {
  it('counts utf-8 bytes', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('你好')).toBe(6);
  });

  it('turns text over 200 KiB into a txt attachment', () => {
    expect(shouldSendTextAsAttachment('a'.repeat(200 * 1024))).toBe(false);
    expect(shouldSendTextAsAttachment('a'.repeat(200 * 1024 + 1))).toBe(true);
  });

  it('keeps converting very large text into a txt attachment', () => {
    expect(shouldSendTextAsAttachment('a'.repeat(1024 * 1024 + 1))).toBe(true);
  });

  it('creates stable txt attachment names', () => {
    const file = createTextAttachmentFile('hello', new Date(2026, 0, 2, 3, 4, 5));
    expect(file.name).toBe('message-20260102-030405.txt');
    expect(file.type).toBe('text/plain;charset=utf-8');
  });
});
