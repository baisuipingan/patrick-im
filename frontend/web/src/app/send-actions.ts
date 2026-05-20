import type { SessionResponse, TransferMode } from '@shared/protocol';
import type { PendingAttachment, UiMessage } from '@/app/types';

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
