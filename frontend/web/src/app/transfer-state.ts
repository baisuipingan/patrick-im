import type { TransferUpdate } from '@/lib/peer-mesh';
import type { TransferRow } from '@/app/types';
import { closeTransferRow } from '@/app/room-state';

export interface TransferStateResult {
  closedTransferIds: Set<string>;
  nextTransfers: Record<string, TransferRow> | null;
  noticeMessage?: string;
  noticeDurationMs?: number;
  resetActiveTransferNotice: boolean;
}

export function reduceTransferUpdate(options: {
  activeTransferNoticeId: string | null;
  closedTransferIds: Set<string>;
  currentTransfers: Record<string, TransferRow>;
  getPeerDisplayName: (peerId: string, fallback?: string) => string;
  update: TransferUpdate;
}): TransferStateResult {
  const { activeTransferNoticeId, closedTransferIds, currentTransfers, getPeerDisplayName, update } = options;
  const nextClosedTransferIds = new Set(closedTransferIds);

  if (update.status === 'pending') {
    nextClosedTransferIds.delete(update.transferId);
  } else if (
    nextClosedTransferIds.has(update.transferId) &&
    update.status !== 'complete' &&
    update.status !== 'cancelled'
  ) {
    return {
      closedTransferIds: nextClosedTransferIds,
      nextTransfers: null,
      resetActiveTransferNotice: false,
    };
  }

  if (update.status === 'complete' || update.status === 'cancelled') {
    nextClosedTransferIds.add(update.transferId);
  }

  let noticeMessage: string | undefined;
  let noticeDurationMs: number | undefined;
  let resetActiveTransferNotice = false;

  if (update.direction === 'upload' && update.transport === 'direct-p2p') {
    if (update.status === 'complete' && activeTransferNoticeId === update.transferId) {
      resetActiveTransferNotice = true;
      noticeMessage = `${update.fileName} 已直连发送给 ${getPeerDisplayName(update.peerId, update.peerName)}。`;
    } else if (
      (update.status === 'failed' || update.status === 'declined') &&
      activeTransferNoticeId === update.transferId
    ) {
      resetActiveTransferNotice = true;
      noticeMessage =
        update.status === 'declined'
          ? `${update.fileName} 对方未接受直连，请切到中继后重发。`
          : `${update.fileName} 直连发送失败，请重试或切到中继。`;
      noticeDurationMs = 3200;
    }
  }

  if (update.status === 'cancelled') {
    if (activeTransferNoticeId === update.transferId) {
      resetActiveTransferNotice = true;
    }
    noticeMessage =
      update.note === 'cancelled by remote'
        ? `${update.fileName} 已被对方取消。`
        : `${update.fileName} 已取消${update.direction === 'upload' ? '发送' : '接收'}。`;
  }

  if (update.status === 'complete' || update.status === 'cancelled') {
    return {
      closedTransferIds: nextClosedTransferIds,
      nextTransfers: closeTransferRow(currentTransfers, update.transferId),
      noticeMessage,
      noticeDurationMs,
      resetActiveTransferNotice,
    };
  }

  const existing = currentTransfers[update.transferId];
  const now = Date.now();
  let speedBytesPerSecond = existing?.speedBytesPerSecond;
  let lastProgressAt = existing?.lastProgressAt ?? now;
  let lastProgressBytes = existing?.lastProgressBytes ?? update.transferredBytes;

  if (update.status === 'streaming') {
    const baseBytes = existing?.lastProgressBytes ?? update.transferredBytes;
    const baseAt = existing?.lastProgressAt ?? now;
    const deltaBytes = Math.max(0, update.transferredBytes - baseBytes);
    const deltaMs = now - baseAt;

    if (deltaBytes > 0 && deltaMs >= 250) {
      const instantSpeed = deltaBytes / (deltaMs / 1000);
      speedBytesPerSecond =
        typeof existing?.speedBytesPerSecond === 'number'
          ? existing.speedBytesPerSecond * 0.45 + instantSpeed * 0.55
          : instantSpeed;
      lastProgressAt = now;
      lastProgressBytes = update.transferredBytes;
    } else if (!existing) {
      lastProgressAt = now;
      lastProgressBytes = update.transferredBytes;
    }

    if (update.note === 'waiting for receiver confirmation') {
      speedBytesPerSecond = undefined;
    }
  } else if (update.status !== 'pending') {
    speedBytesPerSecond = undefined;
  }

  return {
    closedTransferIds: nextClosedTransferIds,
    nextTransfers: {
      ...currentTransfers,
      [update.transferId]: {
        ...update,
        id: update.transferId,
        startedAt: existing?.startedAt ?? now,
        speedBytesPerSecond,
        lastProgressAt,
        lastProgressBytes,
      },
    },
    noticeMessage,
    noticeDurationMs,
    resetActiveTransferNotice,
  };
}
