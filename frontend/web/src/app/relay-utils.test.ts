import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRelayUploadSnapshot,
  getRelayUploadConcurrency,
  loadPendingRelayAbortTickets,
  loadPendingRelayAnnounceTickets,
  storePendingRelayAbortTickets,
  storePendingRelayAnnounceTickets,
  uploadRelayPartWithProgress,
} from '@/app/relay-utils';
import type { RelayUploadTask } from '@/app/types';

const MIB = 1024 * 1024;

function createTask(): RelayUploadTask {
  const file = new File([new Uint8Array(10 * MIB)], 'demo.bin', {
    type: 'application/octet-stream',
  });

  return {
    transferId: 'file-1',
    clientRequestId: 'req-1',
    fileName: file.name,
    uploadToken: 'token-1',
    roomId: 'room-1',
    targetId: null,
    peerId: '__global__',
    peerName: '整个房间',
    file,
    chunkSizeBytes: 5 * MIB,
    totalBytes: file.size,
    totalParts: 2,
    concurrency: 1,
    partsByNumber: new Map(),
    pendingPartNumbers: [],
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
}

class TimeoutUploadXHR {
  static latest: TimeoutUploadXHR | null = null;

  status = 0;
  responseText = '';
  timeout = 0;
  aborted = false;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(): void {
    TimeoutUploadXHR.latest = this;
  }

  setRequestHeader(): void {}

  send(): void {}

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

describe('relay-utils', () => {
  beforeEach(() => {
    window.localStorage.clear();
    TimeoutUploadXHR.latest = null;
  });

  it('loads abort tickets and removes invalid or duplicate items', () => {
    storePendingRelayAbortTickets([
      { uploadToken: 'a', createdAt: 1 },
      { uploadToken: 'a', createdAt: 2 },
      { uploadToken: 'b', createdAt: 3 },
    ]);

    window.localStorage.setItem(
      'patrick-im:pending-relay-aborts',
      JSON.stringify([
        { uploadToken: 'a', createdAt: 1 },
        { uploadToken: 'a', createdAt: 2 },
        { uploadToken: '', createdAt: 3 },
        { uploadToken: 'b', createdAt: 4 },
      ]),
    );

    expect(loadPendingRelayAbortTickets()).toEqual([
      { uploadToken: 'a', createdAt: 1 },
      { uploadToken: 'b', createdAt: 4 },
    ]);
  });

  it('loads announce tickets and removes invalid or duplicate items', () => {
    window.localStorage.setItem(
      'patrick-im:pending-relay-announces',
      JSON.stringify([
        {
          uploadToken: 'up-1',
          roomId: 'room-1',
          fileId: 'file-1',
          fileName: 'a.png',
          size: 123,
          contentType: 'image/png',
          objectKey: 'obj/a.png',
          targetId: null,
          createdAt: 1,
        },
        {
          uploadToken: 'up-2',
          roomId: 'room-1',
          fileId: 'file-1',
          fileName: 'dup.png',
          size: 456,
          contentType: 'image/png',
          objectKey: 'obj/dup.png',
          targetId: null,
          createdAt: 2,
        },
        {
          uploadToken: '',
          roomId: 'room-1',
          fileId: 'file-2',
          fileName: 'bad.png',
          size: 456,
          contentType: 'image/png',
          objectKey: 'obj/bad.png',
          targetId: null,
          createdAt: 2,
        },
      ]),
    );

    expect(loadPendingRelayAnnounceTickets()).toEqual([
      {
        uploadToken: 'up-1',
        roomId: 'room-1',
        fileId: 'file-1',
        fileName: 'a.png',
        size: 123,
        contentType: 'image/png',
        objectKey: 'obj/a.png',
        targetId: null,
        createdAt: 1,
      },
    ]);
  });

  it('calculates relay upload concurrency by file size and part count', () => {
    expect(getRelayUploadConcurrency(4 * MIB, 1)).toBe(1);
    expect(getRelayUploadConcurrency(16 * MIB, 2)).toBe(2);
    expect(getRelayUploadConcurrency(80 * MIB, 8)).toBe(4);
    expect(getRelayUploadConcurrency(300 * MIB, 20)).toBe(8);
    expect(getRelayUploadConcurrency(1024 * MIB, 80)).toBe(12);
    expect(getRelayUploadConcurrency(4 * 1024 * MIB, 120)).toBe(16);
  });

  it('applies snapshot and restores uploaded parts and pending parts', () => {
    const task = createTask();

    applyRelayUploadSnapshot(task, {
      fileId: 'file-1',
      objectKey: 'obj/file-1',
      uploadToken: 'token-2',
      chunkSizeBytes: 5 * MIB,
      uploadedParts: [{ partNumber: 1, etag: '"etag-1"' }],
      parts: [
        { partNumber: 1, uploadUrl: '/api/files/upload-part/1' },
        { partNumber: 2, uploadUrl: '/api/files/upload-part/2' },
      ],
    });

    expect(task.uploadToken).toBe('token-2');
    expect(task.uploadedParts.get(1)?.etag).toBe('"etag-1"');
    expect(task.pendingPartNumbers).toEqual([2]);
    expect(task.loadedByPart.get(1)).toBe(5 * MIB);
    expect(task.concurrency).toBe(2);
  });

  it('stores relay queues with size limits', () => {
    storePendingRelayAbortTickets(
      Array.from({ length: 100 }, (_, index) => ({
        uploadToken: `abort-${index}`,
        createdAt: index,
      })),
    );
    storePendingRelayAnnounceTickets(
      Array.from({ length: 200 }, (_, index) => ({
        uploadToken: `announce-${index}`,
        roomId: 'room-1',
        fileId: `file-${index}`,
        fileName: `${index}.bin`,
        size: 100 + index,
        contentType: 'application/octet-stream',
        objectKey: `obj/${index}.bin`,
        targetId: null,
        createdAt: index,
      })),
    );

    expect(loadPendingRelayAbortTickets()).toHaveLength(64);
    expect(loadPendingRelayAnnounceTickets()).toHaveLength(128);
  });

  it('times out an upload part instead of waiting forever', async () => {
    vi.stubGlobal('XMLHttpRequest', TimeoutUploadXHR);
    const task = createTask();
    const promise = uploadRelayPartWithProgress(
      { partNumber: 1, uploadUrl: '/api/files/upload-part/1' },
      getRelayPartBlobForTest(task, 1),
      vi.fn(),
      task,
    );

    expect(TimeoutUploadXHR.latest?.timeout).toBeGreaterThan(0);
    TimeoutUploadXHR.latest?.ontimeout?.();

    await expect(promise).rejects.toThrow('upload_part_timeout');
    expect(task.xhrs.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('aborts a stalled upload part when no progress or response arrives', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('XMLHttpRequest', TimeoutUploadXHR);
    const task = createTask();
    const promise = uploadRelayPartWithProgress(
      { partNumber: 1, uploadUrl: '/api/files/upload-part/1' },
      getRelayPartBlobForTest(task, 1),
      vi.fn(),
      task,
    );
    const assertion = expect(promise).rejects.toThrow('upload_part_idle_timeout');

    await vi.advanceTimersByTimeAsync(65_000);

    expect(TimeoutUploadXHR.latest?.aborted).toBe(true);
    await assertion;
    expect(task.xhrs.size).toBe(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

function getRelayPartBlobForTest(task: RelayUploadTask, partNumber: number): Blob {
  const start = (partNumber - 1) * task.chunkSizeBytes;
  return task.file.slice(start, Math.min(task.file.size, start + task.chunkSizeBytes));
}
