import type { SessionResponse, TransferMode } from '@shared/protocol';
import type { PendingAttachment, UiMessage } from '@/app/types';

export const MAX_CHAT_TEXT_BYTES = 1024 * 1024;
export const TEXT_ATTACHMENT_THRESHOLD_BYTES = 200 * 1024;

export function getChatTextByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function isChatTextWithinLimit(text: string): boolean {
  return getChatTextByteLength(text) <= MAX_CHAT_TEXT_BYTES;
}

export function shouldSendTextAsAttachment(text: string): boolean {
  return getChatTextByteLength(text) > TEXT_ATTACHMENT_THRESHOLD_BYTES;
}

export function createTextAttachmentFile(text: string, now = new Date()): File {
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return new File([text], `message-${timestamp}.txt`, {
    type: 'text/plain;charset=utf-8',
  });
}

export function canUseDirectTransfer(options: {
  directState: string | undefined;
  effectiveTransferMode: TransferMode;
  fileSize: number;
  session: SessionResponse;
  targetId: string | null;
}): boolean {
  const { directState, effectiveTransferMode, fileSize, session, targetId } = options;
  return (
    targetId !== null &&
    directState === 'connected' &&
    fileSize <= session.directFileSoftLimitBytes &&
    effectiveTransferMode !== 'relay-only'
  );
}

export function buildDirectFileMessage(options: {
  activeRoom: string | null;
  contentType: string;
  fileName: string;
  fileSize: number;
  fromId: string;
  fromName: string;
  localUrl: string;
  targetId: string;
  transferId: string;
}): UiMessage {
  const { activeRoom, contentType, fileName, fileSize, fromId, fromName, localUrl, targetId, transferId } = options;
  return {
    id: transferId,
    roomId: activeRoom ?? 'room',
    kind: 'direct-file',
    fromId,
    fromName,
    targetId,
    createdAt: Date.now(),
    transport: 'direct-p2p',
    file: {
      fileId: transferId,
      fileName,
      size: fileSize,
      contentType,
      objectKey: '',
      fromId,
      fromName,
      createdAt: Date.now(),
      targetId,
      previewable: contentType.startsWith('image/'),
    },
    localUrl,
  };
}

export function collectSendPayload(composer: string, pendingFiles: PendingAttachment[]): {
  files: PendingAttachment[];
  text: string;
} {
  return {
    text: composer.trim(),
    files: [...pendingFiles],
  };
}
