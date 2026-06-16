import type { RelayUploadPart, RelayUploadPartResponse, RelayUploadResponse } from '@shared/protocol';
import type { PendingRelayAbortTicket, PendingRelayAnnounceTicket, RelayUploadTask } from '@/app/types';

export const PENDING_RELAY_ABORTS_KEY = 'patrick-im:pending-relay-aborts';
export const PENDING_RELAY_ANNOUNCES_KEY = 'patrick-im:pending-relay-announces';
const MIB = 1024 * 1024;
const RELAY_PART_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export function isRelayUploadCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === 'relay_upload_cancelled';
}

export function createRelayUploadCancelledError(): Error {
  return new Error('relay_upload_cancelled');
}

export function loadPendingRelayAbortTickets(): PendingRelayAbortTicket[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(PENDING_RELAY_ABORTS_KEY);
    const parsed = stored ? (JSON.parse(stored) as PendingRelayAbortTicket[]) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const seen = new Set<string>();
    return parsed.filter((item) => {
      if (!item || typeof item.uploadToken !== 'string' || !item.uploadToken) {
        return false;
      }
      if (seen.has(item.uploadToken)) {
        return false;
      }
      seen.add(item.uploadToken);
      return true;
    });
  } catch {
    return [];
  }
}

export function storePendingRelayAbortTickets(tickets: PendingRelayAbortTicket[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(PENDING_RELAY_ABORTS_KEY, JSON.stringify(tickets.slice(-64)));
}

export function loadPendingRelayAnnounceTickets(): PendingRelayAnnounceTicket[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(PENDING_RELAY_ANNOUNCES_KEY);
    const parsed = stored ? (JSON.parse(stored) as PendingRelayAnnounceTicket[]) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const seen = new Set<string>();
    return parsed.filter((item) => {
      if (
        !item ||
        typeof item.uploadToken !== 'string' ||
        !item.uploadToken ||
        typeof item.roomId !== 'string' ||
        !item.roomId ||
        typeof item.fileId !== 'string' ||
        !item.fileId ||
        typeof item.fileName !== 'string' ||
        !item.fileName ||
        typeof item.size !== 'number' ||
        !Number.isFinite(item.size) ||
        item.size <= 0 ||
        typeof item.contentType !== 'string' ||
        !item.contentType ||
        typeof item.objectKey !== 'string' ||
        !item.objectKey ||
        typeof item.createdAt !== 'number' ||
        !Number.isFinite(item.createdAt)
      ) {
        return false;
      }

      if (item.targetId !== null && typeof item.targetId !== 'string') {
        return false;
      }

      if (seen.has(item.fileId)) {
        return false;
      }

      seen.add(item.fileId);
      return true;
    });
  } catch {
    return [];
  }
}

export function storePendingRelayAnnounceTickets(tickets: PendingRelayAnnounceTicket[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(PENDING_RELAY_ANNOUNCES_KEY, JSON.stringify(tickets.slice(-128)));
}

export function getRelayUploadConcurrency(fileSizeBytes: number, totalParts: number): number {
  if (totalParts <= 1) {
    return 1;
  }
  if (fileSizeBytes <= 32 * MIB || totalParts <= 2) {
    return Math.min(2, totalParts);
  }
  if (fileSizeBytes <= 128 * MIB || totalParts <= 4) {
    return Math.min(4, totalParts);
  }
  if (fileSizeBytes <= 512 * MIB || totalParts <= 16) {
    return Math.min(8, totalParts);
  }
  if (fileSizeBytes <= 2 * 1024 * MIB || totalParts <= 64) {
    return Math.min(12, totalParts);
  }
  return Math.min(16, totalParts);
}

export function buildRelayUploadNote(totalParts: number, concurrency: number, prefix = '正在上传到服务器存储'): string {
  return totalParts > 1 ? `${prefix}（共 ${totalParts} 个分片，并发 ${concurrency}）` : prefix;
}

export function buildRelayPausedNote(reason: RelayUploadTask['pauseReason']): string {
  return reason === 'offline' ? '网络已断开，上传已暂停，恢复后可继续' : '已暂停，可继续';
}

export function buildRelayAwaitingSyncNote(reason: RelayUploadTask['pauseReason']): string {
  return reason === 'offline'
    ? '文件已上传，网络恢复后会同步到聊天记录'
    : '文件已上传，等待信令恢复后同步到聊天记录';
}

export function getRelayTaskTransferredBytes(task: RelayUploadTask): number {
  let transferred = 0;
  task.loadedByPart.forEach((loaded) => {
    transferred += loaded;
  });
  return Math.min(task.totalBytes, transferred);
}

export function rememberRelayTaskDisplayedBytes(task: RelayUploadTask, transferredBytes: number): number {
  const clamped = Math.min(task.totalBytes, Math.max(0, transferredBytes));
  task.displayedTransferredBytes = Math.max(task.displayedTransferredBytes, clamped);
  return task.displayedTransferredBytes;
}

export function getRelayTaskVisibleTransferredBytes(task: RelayUploadTask): number {
  return rememberRelayTaskDisplayedBytes(task, getRelayTaskTransferredBytes(task));
}

export function getRelayPartBlob(file: File, chunkSizeBytes: number, partNumber: number): Blob {
  const start = (partNumber - 1) * chunkSizeBytes;
  return file.slice(start, Math.min(file.size, start + chunkSizeBytes));
}

export function applyRelayUploadSnapshot(task: RelayUploadTask, payload: RelayUploadResponse): void {
  if (payload.fileId !== task.transferId) {
    throw new Error('relay_upload_resume_file_mismatch');
  }

  const uploadedParts = new Map(payload.uploadedParts.map((part) => [part.partNumber, part]));
  const uploadedPartNumbers = new Set(uploadedParts.keys());
  const loadedByPart = new Map<number, number>();

  uploadedPartNumbers.forEach((partNumber) => {
    loadedByPart.set(partNumber, getRelayPartBlob(task.file, payload.chunkSizeBytes, partNumber).size);
  });

  task.uploadToken = payload.uploadToken;
  task.chunkSizeBytes = payload.chunkSizeBytes;
  task.totalParts = payload.parts.length;
  task.concurrency = getRelayUploadConcurrency(task.totalBytes, task.totalParts);
  task.partsByNumber = new Map(payload.parts.map((part) => [part.partNumber, part]));
  task.pendingPartNumbers = payload.parts
    .map((part) => part.partNumber)
    .filter((partNumber) => !uploadedPartNumbers.has(partNumber));
  task.inFlightPartNumbers.clear();
  task.uploadedParts = uploadedParts;
  task.loadedByPart = loadedByPart;
  rememberRelayTaskDisplayedBytes(task, getRelayTaskTransferredBytes(task));
}

export function uploadRelayPartWithProgress(
  part: RelayUploadPart,
  chunk: Blob,
  onProgress: (loaded: number) => void,
  task: RelayUploadTask,
): Promise<RelayUploadPartResponse> {
  return new Promise<RelayUploadPartResponse>((resolve, reject) => {
    if (task.cancelled) {
      reject(createRelayUploadCancelledError());
      return;
    }

    const xhr = new XMLHttpRequest();
    task.xhrs.add(xhr);
    xhr.open('POST', part.uploadUrl, true);
    xhr.timeout = RELAY_PART_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-patrick-im-upload-token', task.uploadToken);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded);
      }
    };
    xhr.onabort = () => {
      task.xhrs.delete(xhr);
      reject(createRelayUploadCancelledError());
    };
    xhr.onerror = () => {
      task.xhrs.delete(xhr);
      reject(new Error('upload_part_failed'));
    };
    xhr.ontimeout = () => {
      task.xhrs.delete(xhr);
      reject(new Error('upload_part_timeout'));
    };
    xhr.onload = () => {
      task.xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as RelayUploadPartResponse);
        } catch {
          reject(new Error('upload_part_bad_response'));
          return;
        }
      } else {
        reject(new Error(`upload_part_failed_${xhr.status}`));
      }
    };

    if (task.cancelled) {
      xhr.abort();
      return;
    }

    xhr.send(chunk);
  });
}

export async function uploadRelayPartsConcurrently(options: {
  onAckPart: (task: RelayUploadTask, part: RelayUploadPartResponse) => Promise<void>;
  onProgress: (transferredBytes: number, totalParts: number, concurrency: number) => void;
  task: RelayUploadTask;
}): Promise<void> {
  const { onAckPart, onProgress, task } = options;
  let aggregateLoadedBytes = 0;
  let lastProgressEmitAt = 0;

  const emitProgress = (force: boolean = false) => {
    const now = performance.now();
    if (!force && now - lastProgressEmitAt < 120) {
      return;
    }
    lastProgressEmitAt = now;
    onProgress(Math.min(task.totalBytes, aggregateLoadedBytes), task.totalParts, task.concurrency);
  };

  const recomputeLoadedBytes = (forceEmit: boolean = false) => {
    aggregateLoadedBytes = getRelayTaskTransferredBytes(task);
    emitProgress(forceEmit || aggregateLoadedBytes >= task.totalBytes);
  };

  const claimNextPartNumber = (): number | null => {
    while (task.pendingPartNumbers.length > 0) {
      const partNumber = task.pendingPartNumbers.shift();
      if (!partNumber) {
        break;
      }
      if (task.uploadedParts.has(partNumber) || task.inFlightPartNumbers.has(partNumber)) {
        continue;
      }
      task.inFlightPartNumbers.add(partNumber);
      return partNumber;
    }
    return null;
  };

  const requeuePartNumber = (partNumber: number) => {
    if (
      task.uploadedParts.has(partNumber) ||
      task.inFlightPartNumbers.has(partNumber) ||
      task.pendingPartNumbers.includes(partNumber)
    ) {
      return;
    }
    task.pendingPartNumbers.unshift(partNumber);
  };

  recomputeLoadedBytes(true);

  const uploadNext = async (): Promise<void> => {
    while (true) {
      if (task.cancelled || task.stage === 'paused') {
        return;
      }

      const partNumber = claimNextPartNumber();
      if (partNumber === null) {
        return;
      }

      const part = task.partsByNumber.get(partNumber);
      if (!part) {
        task.inFlightPartNumbers.delete(partNumber);
        throw new Error(`upload_part_missing_${partNumber}`);
      }

      const chunk = getRelayPartBlob(task.file, task.chunkSizeBytes, partNumber);
      const pauseGeneration = task.pauseGeneration;

      try {
        const uploadedPart = await uploadRelayPartWithProgress(part, chunk, (loaded) => {
          task.loadedByPart.set(partNumber, loaded);
          recomputeLoadedBytes();
        }, task);
        await onAckPart(task, uploadedPart);
        task.inFlightPartNumbers.delete(partNumber);
        task.uploadedParts.set(partNumber, uploadedPart);
        task.loadedByPart.set(partNumber, chunk.size);
        recomputeLoadedBytes(true);
      } catch (error) {
        task.inFlightPartNumbers.delete(partNumber);
        task.loadedByPart.delete(partNumber);
        recomputeLoadedBytes(true);

        if (task.pauseGeneration > pauseGeneration) {
          requeuePartNumber(partNumber);
          return;
        }

        if (task.cancelled || isRelayUploadCancelledError(error)) {
          return;
        }

        throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: task.concurrency }, () => uploadNext()));
  recomputeLoadedBytes(true);
}
