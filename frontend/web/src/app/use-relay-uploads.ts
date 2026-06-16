import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type {
  ClientToServerMessage,
  RelayAbortUploadRequest,
  RelayDiscardUploadRequest,
  RelayUploadPartResponse,
  RelayUploadResponse,
} from '@shared/protocol';
import type { TransferUpdate } from '@/lib/peer-mesh';
import type {
  PendingRelayAbortTicket,
  PendingRelayAnnounceTicket,
  RelayUploadTask,
  TransferRow,
  UiMessage,
} from '@/app/types';
import {
  applyRelayUploadSnapshot,
  buildRelayAwaitingSyncNote,
  buildRelayPausedNote,
  buildRelayUploadNote,
  getRelayTaskVisibleTransferredBytes,
  getRelayUploadConcurrency,
  isRelayUploadCancelledError,
  loadPendingRelayAbortTickets,
  loadPendingRelayAnnounceTickets,
  rememberRelayTaskDisplayedBytes,
  storePendingRelayAbortTickets,
  storePendingRelayAnnounceTickets,
  uploadRelayPartsConcurrently,
} from '@/app/relay-utils';

interface UseRelayUploadsOptions {
  activeRoom: string | null;
  activeRoomRef: MutableRefObject<string | null>;
  closedTransferIdsRef: MutableRefObject<Set<string>>;
  getPeerDisplayName: (peerId: string) => string;
  messagesRef: MutableRefObject<UiMessage[]>;
  removePendingFile: (id: string) => void;
  sendServerMessage: (payload: ClientToServerMessage) => boolean;
  setTransfers: Dispatch<SetStateAction<Record<string, TransferRow>>>;
  showTransientNotice: (message: string, durationMs?: number) => void;
  transfersRef: MutableRefObject<Record<string, TransferRow>>;
  updateTransfer: (update: TransferUpdate) => void;
}

export interface RelayUploadControls {
  abortAllRelayUploads: (options: {
    reason: string;
    transport: 'fetch' | 'keepalive' | 'beacon';
    updateUi: boolean;
    notice?: string;
  }) => void;
  abortRelayUploadsForThread: (threadId: string, options?: { transport?: 'fetch' | 'keepalive' | 'beacon' }) => void;
  acknowledgeRelayMessage: (fileId: string) => void;
  cancelRelayUpload: (transferId: string) => Promise<boolean>;
  flushPendingRelayAborts: () => Promise<void>;
  flushPendingRelayAnnounces: (options?: { roomId?: string }) => void;
  getRelayTaskState: (transferId: string) => RelayUploadTask['stage'] | null;
  pauseAllRelayUploads: (options: {
    reason: RelayUploadTask['pauseReason'];
    notice?: string;
  }) => void;
  pauseRelayUpload: (transferId: string) => Promise<boolean>;
  relayFile: (file: File, targetId: string | null, pendingAttachmentId?: string) => Promise<void>;
  resumeOfflinePausedRelayUploads: () => void;
  resumeRelayUpload: (transferId: string) => Promise<boolean>;
}

async function ackRelayUploadPart(_task: RelayUploadTask, _part: RelayUploadPartResponse): Promise<void> {
  // Uploading a part now stores and acknowledges it in one request.
}

async function readRelayError(response: Response, fallback: string): Promise<string> {
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === 'string' && payload.error.trim()) {
        return payload.error.trim();
      }
    } else {
      const text = await response.text();
      if (text.trim()) {
        return text.trim();
      }
    }
  } catch {
    // Keep the original upload failure if the error body is not readable.
  }
  return fallback;
}

export function useRelayUploads(options: UseRelayUploadsOptions): RelayUploadControls {
  const {
    activeRoom,
    activeRoomRef,
    closedTransferIdsRef,
    getPeerDisplayName,
    messagesRef,
    removePendingFile,
    sendServerMessage,
    setTransfers,
    showTransientNotice,
    transfersRef,
    updateTransfer,
  } = options;
  const relayAbortQueueRef = useRef<PendingRelayAbortTicket[]>(loadPendingRelayAbortTickets());
  const relayAnnounceQueueRef = useRef<PendingRelayAnnounceTicket[]>(loadPendingRelayAnnounceTickets());
  const relayUploadTasksRef = useRef<Map<string, RelayUploadTask>>(new Map());

  useEffect(() => {
    return () => {
      relayUploadTasksRef.current.forEach((task) => {
        abortRelayTask(task, {
          reason: 'cancelled locally',
          transport: 'beacon',
          updateUi: false,
        });
      });
      relayUploadTasksRef.current.clear();
    };
  }, []);

  function setRelayAbortQueue(next: PendingRelayAbortTicket[]): void {
    relayAbortQueueRef.current = next;
    storePendingRelayAbortTickets(next);
  }

  function setRelayAnnounceQueue(next: PendingRelayAnnounceTicket[]): void {
    relayAnnounceQueueRef.current = next;
    storePendingRelayAnnounceTickets(next);
  }

  function rememberRelayAbort(uploadToken: string): void {
    if (relayAbortQueueRef.current.some((ticket) => ticket.uploadToken === uploadToken)) {
      return;
    }

    setRelayAbortQueue([
      ...relayAbortQueueRef.current,
      {
        uploadToken,
        createdAt: Date.now(),
      },
    ]);
  }

  function forgetRelayAbort(uploadToken: string): void {
    if (!relayAbortQueueRef.current.some((ticket) => ticket.uploadToken === uploadToken)) {
      return;
    }

    setRelayAbortQueue(relayAbortQueueRef.current.filter((ticket) => ticket.uploadToken !== uploadToken));
  }

  function rememberRelayAnnounce(ticket: PendingRelayAnnounceTicket): void {
    const existingIndex = relayAnnounceQueueRef.current.findIndex((item) => item.fileId === ticket.fileId);
    if (existingIndex === -1) {
      setRelayAnnounceQueue([...relayAnnounceQueueRef.current, ticket]);
      return;
    }

    const next = [...relayAnnounceQueueRef.current];
    next[existingIndex] = ticket;
    setRelayAnnounceQueue(next);
  }

  function forgetRelayAnnounce(fileId: string): void {
    if (!relayAnnounceQueueRef.current.some((ticket) => ticket.fileId === fileId)) {
      return;
    }

    setRelayAnnounceQueue(relayAnnounceQueueRef.current.filter((ticket) => ticket.fileId !== fileId));
  }

  function hasMessageForRelayFile(fileId: string): boolean {
    return messagesRef.current.some((message) => message.file?.fileId === fileId);
  }

  function markRelayTransferSynced(fileId: string): void {
    const existing = transfersRef.current[fileId];
    if (!existing || existing.transport !== 'server-relay' || existing.direction !== 'upload') {
      return;
    }

    updateTransfer({
      transferId: existing.id,
      peerId: existing.peerId,
      peerName: existing.peerName,
      fileName: existing.fileName,
      totalBytes: existing.totalBytes,
      transferredBytes: existing.totalBytes,
      direction: 'upload',
      transport: 'server-relay',
      status: 'complete',
      note: '已同步到聊天记录',
    });
  }

  function tryAnnounceRelayFile(ticket: PendingRelayAnnounceTicket): boolean {
    if (activeRoomRef.current !== ticket.roomId) {
      return false;
    }

    const announced = sendServerMessage({
      type: 'relay-file-announced',
      file: {
        fileId: ticket.fileId,
        fileName: ticket.fileName,
        size: ticket.size,
        contentType: ticket.contentType,
        objectKey: ticket.objectKey,
        targetId: ticket.targetId,
      },
    });

    if (announced) {
      updateTransfer({
        transferId: ticket.fileId,
        peerId: transfersRef.current[ticket.fileId]?.peerId ?? (ticket.targetId ?? '__global__'),
        peerName:
          transfersRef.current[ticket.fileId]?.peerName ??
          (ticket.targetId ? getPeerDisplayName(ticket.targetId) : '整个房间'),
        fileName: ticket.fileName,
        totalBytes: ticket.size,
        transferredBytes: ticket.size,
        direction: 'upload',
        transport: 'server-relay',
        status: 'streaming',
        note: '等待写入聊天记录',
      });
    }

    return announced;
  }

  function flushPendingRelayAnnounces(flushOptions?: { roomId?: string }): void {
    const roomId = flushOptions?.roomId ?? activeRoomRef.current;
    if (!roomId) {
      return;
    }

    const pendingForRoom = relayAnnounceQueueRef.current.filter((ticket) => ticket.roomId === roomId);
    if (pendingForRoom.length === 0) {
      return;
    }

    for (const ticket of pendingForRoom) {
      if (hasMessageForRelayFile(ticket.fileId)) {
        forgetRelayAnnounce(ticket.fileId);
        markRelayTransferSynced(ticket.fileId);
        continue;
      }

      if (!tryAnnounceRelayFile(ticket)) {
        break;
      }
    }
  }

  async function postRelayAbort(uploadToken: string, keepalive = false): Promise<boolean> {
    try {
      const response = await fetch('/api/files/abort', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          uploadToken,
        } satisfies RelayAbortUploadRequest),
        keepalive,
      });

      if (response.ok || response.status === 409) {
        forgetRelayAbort(uploadToken);
        return true;
      }
    } catch {
      // Leave the token in the retry queue.
    }

    return false;
  }

  async function postRelayDiscard(uploadToken: string, keepalive = false): Promise<boolean> {
    try {
      const response = await fetch('/api/files/discard', {
        method: 'POST',
        keepalive,
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          uploadToken,
        } satisfies RelayDiscardUploadRequest),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function dispatchRelayAbort(uploadToken: string, mode: 'fetch' | 'keepalive' | 'beacon'): void {
    rememberRelayAbort(uploadToken);

    if (mode === 'beacon' && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const body = new Blob(
        [
          JSON.stringify({
            uploadToken,
          } satisfies RelayAbortUploadRequest),
        ],
        { type: 'application/json' },
      );
      const accepted = navigator.sendBeacon('/api/files/abort', body);
      if (accepted) {
        return;
      }
    }

    void postRelayAbort(uploadToken, mode !== 'fetch');
  }

  function dispatchRelayDiscard(uploadToken: string, mode: 'fetch' | 'keepalive' | 'beacon'): void {
    if (mode === 'beacon' && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const body = new Blob(
        [
          JSON.stringify({
            uploadToken,
          } satisfies RelayDiscardUploadRequest),
        ],
        { type: 'application/json' },
      );
      navigator.sendBeacon('/api/files/discard', body);
      return;
    }

    void postRelayDiscard(uploadToken, mode !== 'fetch');
  }

  async function flushPendingRelayAborts(): Promise<void> {
    const tickets = [...relayAbortQueueRef.current];
    for (const ticket of tickets) {
      await postRelayAbort(ticket.uploadToken);
    }
  }

  function wakeRelayTaskResume(task: RelayUploadTask): void {
    const resolver = task.resumeResolver;
    task.resumeResolver = null;
    task.resumePromise = null;
    resolver?.();
  }

  function waitForRelayTaskResume(task: RelayUploadTask): Promise<void> {
    if (task.stage !== 'paused') {
      return Promise.resolve();
    }

    if (task.resumePromise) {
      return task.resumePromise;
    }

    task.resumePromise = new Promise<void>((resolve) => {
      task.resumeResolver = resolve;
    });
    return task.resumePromise;
  }

  function pauseRelayTask(
    task: RelayUploadTask,
    pauseOptions: {
      reason: RelayUploadTask['pauseReason'];
      notice?: string;
    },
  ): boolean {
    if (task.cancelled || (task.stage !== 'uploading' && task.stage !== 'awaiting-sync')) {
      return false;
    }

    task.stage = 'paused';
    task.pauseReason = pauseOptions.reason;
    task.pauseGeneration += 1;
    task.xhrs.forEach((xhr) => xhr.abort());
    task.xhrs.clear();

    updateTransfer({
      transferId: task.transferId,
      peerId: task.peerId,
      peerName: task.peerName,
      fileName: task.fileName,
      totalBytes: task.totalBytes,
      transferredBytes: getRelayTaskVisibleTransferredBytes(task),
      direction: 'upload',
      transport: 'server-relay',
      status: 'paused',
      note:
        task.uploadedParts.size >= task.totalParts
          ? buildRelayAwaitingSyncNote(pauseOptions.reason)
          : buildRelayPausedNote(pauseOptions.reason),
    });

    if (pauseOptions.notice) {
      showTransientNotice(pauseOptions.notice, 3200);
    }

    return true;
  }

  async function refreshRelayTaskUploadSnapshot(task: RelayUploadTask): Promise<void> {
    const response = await fetch('/api/files/upload-request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        clientRequestId: task.clientRequestId,
        roomId: task.roomId,
        fileName: task.file.name,
        contentType: task.file.type,
        size: task.file.size,
        targetId: task.targetId,
      }),
    });

    if (!response.ok) {
      throw new Error('relay_upload_resume_request_failed');
    }

    applyRelayUploadSnapshot(task, (await response.json()) as RelayUploadResponse);
  }

  async function resumeRelayTask(task: RelayUploadTask, resumeOptions?: { notice?: string }): Promise<boolean> {
    if (task.cancelled || task.stage !== 'paused') {
      return false;
    }

    const wasOfflinePaused = task.pauseReason === 'offline';
    updateTransfer({
      transferId: task.transferId,
      peerId: task.peerId,
      peerName: task.peerName,
      fileName: task.fileName,
      totalBytes: task.totalBytes,
      transferredBytes: getRelayTaskVisibleTransferredBytes(task),
      direction: 'upload',
      transport: 'server-relay',
      status: 'streaming',
      note: '正在恢复中继上传',
    });

    try {
      await refreshRelayTaskUploadSnapshot(task);
    } catch {
      task.stage = 'paused';
      task.pauseReason = wasOfflinePaused ? 'offline' : 'manual';
      updateTransfer({
        transferId: task.transferId,
        peerId: task.peerId,
        peerName: task.peerName,
        fileName: task.fileName,
        totalBytes: task.totalBytes,
        transferredBytes: getRelayTaskVisibleTransferredBytes(task),
        direction: 'upload',
        transport: 'server-relay',
        status: 'paused',
        note: buildRelayPausedNote(task.pauseReason),
      });
      showTransientNotice(`${task.fileName} 恢复失败，请稍后重试。`, 3200);
      return false;
    }

    task.pauseReason = null;
    task.stage = task.uploadedParts.size >= task.totalParts ? 'awaiting-sync' : 'uploading';
    wakeRelayTaskResume(task);

    updateTransfer({
      transferId: task.transferId,
      peerId: task.peerId,
      peerName: task.peerName,
      fileName: task.fileName,
      totalBytes: task.totalBytes,
      transferredBytes: getRelayTaskVisibleTransferredBytes(task),
      direction: 'upload',
      transport: 'server-relay',
      status: 'streaming',
      note:
        task.uploadedParts.size >= task.totalParts
          ? wasOfflinePaused
            ? '网络已恢复，正在同步到聊天记录'
            : '正在同步到聊天记录'
          : buildRelayUploadNote(
              task.totalParts,
              task.concurrency,
              wasOfflinePaused ? '网络已恢复，继续上传到服务器存储' : '继续上传到服务器存储',
            ),
    });

    if (resumeOptions?.notice) {
      showTransientNotice(resumeOptions.notice, 3200);
    }

    return true;
  }

  function abortRelayTask(
    task: RelayUploadTask,
    abortOptions: {
      reason: string;
      transport: 'fetch' | 'keepalive' | 'beacon';
      cleanup?: 'abort' | 'discard';
      updateUi: boolean;
      notice?: string;
    },
  ): void {
    if (task.cancelled) {
      return;
    }

    task.cancelled = true;
    task.pauseReason = null;
    task.stage = 'awaiting-sync';
    task.xhrs.forEach((xhr) => xhr.abort());
    task.xhrs.clear();
    wakeRelayTaskResume(task);
    closedTransferIdsRef.current.add(task.transferId);
    forgetRelayAnnounce(task.transferId);
    if (abortOptions.cleanup === 'discard') {
      dispatchRelayDiscard(task.uploadToken, abortOptions.transport);
    } else {
      dispatchRelayAbort(task.uploadToken, abortOptions.transport);
    }
    relayUploadTasksRef.current.delete(task.transferId);
    setTransfers((current) => {
      if (!(task.transferId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[task.transferId];
      return next;
    });

    if (abortOptions.updateUi) {
      updateTransfer({
        transferId: task.transferId,
        peerId: task.peerId,
        peerName: task.peerName,
        fileName: task.fileName,
        totalBytes: task.totalBytes,
        transferredBytes: getRelayTaskVisibleTransferredBytes(task),
        direction: 'upload',
        transport: 'server-relay',
        status: 'cancelled',
        note: abortOptions.reason,
      });
    }

    if (abortOptions.notice) {
      showTransientNotice(abortOptions.notice, 3200);
    }
  }

  function abortAllRelayUploads(abortOptions: {
    reason: string;
    transport: 'fetch' | 'keepalive' | 'beacon';
    updateUi: boolean;
    notice?: string;
  }): void {
    const tasks = [...relayUploadTasksRef.current.values()];
    if (tasks.length === 0) {
      return;
    }

    for (const task of tasks) {
      abortRelayTask(task, abortOptions);
    }
  }

  function abortRelayUploadsForThread(
    threadId: string,
    options?: { transport?: 'fetch' | 'keepalive' | 'beacon' },
  ): void {
    const transport = options?.transport ?? 'fetch';
    const tasks = [...relayUploadTasksRef.current.values()].filter((task) => task.peerId === threadId);
    if (tasks.length === 0) {
      return;
    }

    for (const task of tasks) {
      abortRelayTask(task, {
        reason: 'thread cleared',
        transport,
        cleanup: task.uploadedParts.size >= task.totalParts ? 'discard' : 'abort',
        updateUi: false,
      });
    }
  }

  function pauseAllRelayUploads(pauseOptions: {
    reason: RelayUploadTask['pauseReason'];
    notice?: string;
  }): void {
    const tasks = [...relayUploadTasksRef.current.values()];
    if (tasks.length === 0) {
      return;
    }

    let pausedAny = false;
    for (const task of tasks) {
      pausedAny = pauseRelayTask(task, { reason: pauseOptions.reason }) || pausedAny;
    }

    if (pausedAny && pauseOptions.notice) {
      showTransientNotice(pauseOptions.notice, 3200);
    }
  }

  function resumeOfflinePausedRelayUploads(): void {
    const tasks = [...relayUploadTasksRef.current.values()];
    for (const task of tasks) {
      if (task.stage === 'paused' && task.pauseReason === 'offline') {
        void resumeRelayTask(task);
      }
    }

    flushPendingRelayAnnounces();
  }

  async function cancelRelayUpload(transferId: string): Promise<boolean> {
    const task = relayUploadTasksRef.current.get(transferId);
    if (!task) {
      closedTransferIdsRef.current.add(transferId);
      forgetRelayAnnounce(transferId);
      setTransfers((current) => {
        if (!(transferId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[transferId];
        return next;
      });
      return true;
    }

    abortRelayTask(task, {
      reason: 'cancelled locally',
      transport: 'fetch',
      cleanup: task.uploadedParts.size >= task.totalParts ? 'discard' : 'abort',
      updateUi: true,
    });
    return true;
  }

  async function pauseRelayUpload(transferId: string): Promise<boolean> {
    const task = relayUploadTasksRef.current.get(transferId);
    if (!task) {
      return false;
    }

    return pauseRelayTask(task, {
      reason: 'manual',
      notice: `${task.fileName} 已暂停。`,
    });
  }

  async function resumeRelayUpload(transferId: string): Promise<boolean> {
    const task = relayUploadTasksRef.current.get(transferId);
    if (!task) {
      return false;
    }

    return await resumeRelayTask(task, {
      notice: `${task.fileName} 已继续发送。`,
    });
  }

  async function relayFile(file: File, targetId: string | null, pendingAttachmentId?: string): Promise<void> {
    void runRelayFileUpload(file, targetId, pendingAttachmentId);
  }

  async function runRelayFileUpload(file: File, targetId: string | null, pendingAttachmentId?: string): Promise<void> {
    const roomId = activeRoom;
    if (!roomId) {
      return;
    }

    const peerId = targetId ?? '__global__';
    const peerName = targetId ? getPeerDisplayName(targetId) : '整个房间';
    const clientRequestId = pendingAttachmentId ?? crypto.randomUUID();
    let task: RelayUploadTask | null = null;
    try {
      const uploadRequest = await fetch('/api/files/upload-request', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          clientRequestId,
          roomId,
          fileName: file.name,
          contentType: file.type,
          size: file.size,
          targetId,
        }),
      });

      if (!uploadRequest.ok) {
        throw new Error(await readRelayError(uploadRequest, 'upload_request_failed'));
      }

      const payload = (await uploadRequest.json()) as RelayUploadResponse;
      const totalParts = payload.parts.length;
      const concurrency = getRelayUploadConcurrency(file.size, totalParts);
      task = {
        transferId: payload.fileId,
        clientRequestId,
        fileName: file.name,
        uploadToken: payload.uploadToken,
        roomId,
        targetId,
        peerId,
        peerName,
        file,
        chunkSizeBytes: payload.chunkSizeBytes,
        totalBytes: file.size,
        totalParts,
        concurrency,
        partsByNumber: new Map(payload.parts.map((part) => [part.partNumber, part])),
        pendingPartNumbers: payload.parts.map((part) => part.partNumber),
        inFlightPartNumbers: new Set(),
        uploadedParts: new Map(),
        loadedByPart: new Map(),
        displayedTransferredBytes: 0,
        stage: 'uploading',
        pauseReason: null,
        pauseGeneration: 0,
        resumePromise: null,
        resumeResolver: null,
        cancelled: false,
        xhrs: new Set(),
      };
      applyRelayUploadSnapshot(task, payload);

      if (activeRoomRef.current !== roomId) {
        dispatchRelayAbort(task.uploadToken, 'fetch');
        return;
      }

      relayUploadTasksRef.current.set(payload.fileId, task);

      updateTransfer({
        transferId: task.transferId,
        peerId,
        peerName,
        fileName: file.name,
        totalBytes: file.size,
        transferredBytes: getRelayTaskVisibleTransferredBytes(task),
        direction: 'upload',
        transport: 'server-relay',
        status: 'pending',
        note:
          task.uploadedParts.size > 0
            ? buildRelayUploadNote(totalParts, concurrency, '继续上传到服务器存储')
            : '等待上传到服务器存储',
      });
      if (pendingAttachmentId) {
        removePendingFile(pendingAttachmentId);
      }

      while (task.uploadedParts.size < task.totalParts) {
        if (task.cancelled || closedTransferIdsRef.current.has(task.transferId)) {
          return;
        }

        if (task.stage === 'paused') {
          await waitForRelayTaskResume(task);
          continue;
        }

        await uploadRelayPartsConcurrently({
          task,
          onAckPart: ackRelayUploadPart,
          onProgress: (transferredBytes, nextTotalParts, nextConcurrency) => {
            if (!task) {
              return;
            }
            const relayStage = task.stage;
            const pauseReason = task.pauseReason;
            updateTransfer({
              transferId: payload.fileId,
              peerId,
              peerName,
              fileName: file.name,
              totalBytes: file.size,
              transferredBytes: rememberRelayTaskDisplayedBytes(task, transferredBytes),
              direction: 'upload',
              transport: 'server-relay',
              status: relayStage === 'paused' ? 'paused' : 'streaming',
              note:
                relayStage === 'paused'
                  ? buildRelayPausedNote(pauseReason)
                  : buildRelayUploadNote(nextTotalParts, nextConcurrency),
            });
          },
        });
      }

      if (task.cancelled || closedTransferIdsRef.current.has(task.transferId)) {
        return;
      }

      task.stage = 'completing';
      const completeResponse = await fetch('/api/files/complete', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          uploadToken: task.uploadToken,
          parts: [...task.uploadedParts.values()].sort((left, right) => left.partNumber - right.partNumber),
        }),
      });

      if (!completeResponse.ok) {
        throw new Error(await readRelayError(completeResponse, 'upload_complete_failed'));
      }

      if (task.cancelled || closedTransferIdsRef.current.has(task.transferId)) {
        return;
      }

      const completed = (await completeResponse.json()) as Pick<RelayUploadResponse, 'fileId' | 'objectKey'>;
      task.stage = 'awaiting-sync';
      const announceTicket: PendingRelayAnnounceTicket = {
        uploadToken: task.uploadToken,
        roomId,
        fileId: completed.fileId,
        fileName: file.name,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
        objectKey: completed.objectKey,
        targetId,
        createdAt: Date.now(),
      };

      rememberRelayAnnounce(announceTicket);

      const canAnnounce =
        !task.cancelled &&
        activeRoomRef.current === roomId &&
        tryAnnounceRelayFile(announceTicket);

      if (!canAnnounce) {
        updateTransfer({
          transferId: payload.fileId,
          peerId,
          peerName,
          fileName: file.name,
          totalBytes: file.size,
          transferredBytes: task ? rememberRelayTaskDisplayedBytes(task, file.size) : file.size,
          direction: 'upload',
          transport: 'server-relay',
          status: 'streaming',
          note: '文件已上传，等待信令恢复后同步到聊天记录',
        });
        return;
      }
      updateTransfer({
        transferId: payload.fileId,
        peerId,
        peerName,
        fileName: file.name,
        totalBytes: file.size,
        transferredBytes: task ? rememberRelayTaskDisplayedBytes(task, file.size) : file.size,
        direction: 'upload',
        transport: 'server-relay',
        status: 'streaming',
        note: '等待写入聊天记录',
      });
    } catch (error) {
      if (isRelayUploadCancelledError(error) || task?.cancelled || (task && closedTransferIdsRef.current.has(task.transferId))) {
        return;
      }

      if (task && (task.stage === 'uploading' || task.stage === 'completing' || task.stage === 'failed')) {
        dispatchRelayAbort(task.uploadToken, 'keepalive');
      }

      if (task) {
        task.stage = 'failed';
      }
      const errorMessage = error instanceof Error && error.message ? error.message : '服务端中继上传失败，请重试';

      updateTransfer({
        transferId: task?.transferId ?? `relay-failed:${crypto.randomUUID()}`,
        peerId,
        peerName,
        fileName: file.name,
        totalBytes: file.size,
        transferredBytes: task ? getRelayTaskVisibleTransferredBytes(task) : 0,
        direction: 'upload',
        transport: 'server-relay',
        status: 'failed',
        note: `服务端中继上传失败：${errorMessage}`,
      });
      showTransientNotice(`${file.name} 中继上传失败：${errorMessage}`, 4200);
    } finally {
      if (task) {
        relayUploadTasksRef.current.delete(task.transferId);
      }
    }
  }

  function getRelayTaskState(transferId: string): RelayUploadTask['stage'] | null {
    return relayUploadTasksRef.current.get(transferId)?.stage ?? null;
  }

  function acknowledgeRelayMessage(fileId: string): void {
    forgetRelayAnnounce(fileId);
    markRelayTransferSynced(fileId);
  }

  return {
    abortAllRelayUploads,
    abortRelayUploadsForThread,
    acknowledgeRelayMessage,
    cancelRelayUpload,
    flushPendingRelayAborts,
    flushPendingRelayAnnounces,
    getRelayTaskState,
    pauseAllRelayUploads,
    pauseRelayUpload,
    relayFile,
    resumeOfflinePausedRelayUploads,
    resumeRelayUpload,
  };
}
