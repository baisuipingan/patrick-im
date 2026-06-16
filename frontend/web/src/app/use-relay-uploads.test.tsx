import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadRelayPartsConcurrently } from '@/app/relay-utils';
import { useRelayUploads, type RelayUploadControls } from '@/app/use-relay-uploads';
import type { TransferRow, UiMessage } from '@/app/types';

let latestControls: RelayUploadControls | null = null;
let latestHarnessState: HarnessState | null = null;
let mockUploadRelayParts = true;

vi.mock('@/app/relay-utils', async () => {
  const actual = await vi.importActual<typeof import('@/app/relay-utils')>('@/app/relay-utils');
  return {
    ...actual,
    uploadRelayPartsConcurrently: vi.fn(
      async (...args: Parameters<typeof actual.uploadRelayPartsConcurrently>) => {
        if (!mockUploadRelayParts) {
          return await actual.uploadRelayPartsConcurrently(...args);
        }
        await new Promise<void>(() => {
          // Keep the mocked upload in-flight so the hook has a live relay task to abort.
        });
      },
    ),
  };
});

interface HarnessState {
  messagesRef: React.RefObject<UiMessage[]>;
  transfersRef: React.RefObject<Record<string, TransferRow>>;
  activeRoomRef: React.RefObject<string | null>;
  closedTransferIdsRef: React.RefObject<Set<string>>;
  removePendingFile: ReturnType<typeof vi.fn>;
  sendServerMessage: ReturnType<typeof vi.fn>;
  showTransientNotice: ReturnType<typeof vi.fn>;
  updateTransfer: ReturnType<typeof vi.fn>;
}

function Harness() {
  const messagesRef = React.useRef<UiMessage[]>([]);
  const transfersRef = React.useRef<Record<string, TransferRow>>({});
  const activeRoomRef = React.useRef<string | null>('room-a');
  const closedTransferIdsRef = React.useRef<Set<string>>(new Set());
  const removePendingFile = React.useMemo(() => vi.fn(), []);
  const sendServerMessage = React.useMemo(() => vi.fn(() => true), []);
  const showTransientNotice = React.useMemo(() => vi.fn(), []);
  const updateTransfer = React.useMemo(() => vi.fn(), []);

  const controls = useRelayUploads({
    activeRoom: 'room-a',
    activeRoomRef,
    closedTransferIdsRef,
    getPeerDisplayName: (peerId) => peerId,
    messagesRef,
    removePendingFile,
    sendServerMessage,
    setTransfers: (updater) => {
      const next = typeof updater === 'function' ? updater(transfersRef.current) : updater;
      transfersRef.current = next;
    },
    showTransientNotice,
    transfersRef,
    updateTransfer,
  });

  latestControls = controls;
  latestHarnessState = {
    messagesRef,
    transfersRef,
    activeRoomRef,
    closedTransferIdsRef,
    removePendingFile,
    sendServerMessage,
    showTransientNotice,
    updateTransfer,
  };
  return null;
}

class SuccessfulUploadXHR {
  static requests: SuccessfulUploadXHR[] = [];

  status = 200;
  responseText = '';
  timeout = 0;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private partNumber = 0;

  open(_method: string, url: string): void {
    this.partNumber = Number(url.split('/').pop());
  }

  setRequestHeader(): void {}

  send(chunk: Blob): void {
    SuccessfulUploadXHR.requests.push(this);
    window.setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: chunk.size } as ProgressEvent);
      this.responseText = JSON.stringify({
        partNumber: this.partNumber,
        etag: `etag-${this.partNumber}`,
      });
      this.onload?.();
    }, 0);
  }

  abort(): void {
    this.onabort?.();
  }
}

function renderHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
  return {
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('use-relay-uploads', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    latestControls = null;
    latestHarnessState = null;
    mockUploadRelayParts = true;
    SuccessfulUploadXHR.requests = [];
    window.localStorage.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/files/upload-request')) {
          return new Response(
            JSON.stringify({
              fileId: 'file-1',
              objectKey: 'obj/file-1',
              uploadToken: 'token-1',
              chunkSizeBytes: 5,
              uploadedParts: [],
              parts: [{ partNumber: 1, uploadUrl: '/api/files/upload-part/1' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url.endsWith('/api/files/abort') || url.endsWith('/api/files/discard')) {
          return new Response(null, { status: 200 });
        }

        if (url.endsWith('/api/files/complete')) {
          return new Response(
            JSON.stringify({
              fileId: 'file-1',
              objectKey: 'obj/file-1',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url.endsWith('/api/files/upload-part')) {
          return new Response(null, { status: 200 });
        }

        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('aborts thread-scoped relay upload tasks when thread is cleared', async () => {
    const view = renderHarness();
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });

    act(() => {
      void latestControls?.relayFile(file, 'peer-1', 'pending-1');
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestControls?.getRelayTaskState('file-1')).toBe('uploading');

    act(() => {
      latestControls?.abortRelayUploadsForThread('peer-1');
    });

    expect(latestControls?.getRelayTaskState('file-1')).toBe(null);

    view.unmount();
  });

  it('completes relay upload after all parts are acknowledged', async () => {
    mockUploadRelayParts = false;
    vi.stubGlobal('XMLHttpRequest', SuccessfulUploadXHR);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/files/upload-request')) {
        return new Response(
          JSON.stringify({
            fileId: 'file-1',
            objectKey: 'obj/file-1',
            uploadToken: 'token-1',
            chunkSizeBytes: 5,
            uploadedParts: [],
            parts: [
              { partNumber: 1, uploadUrl: '/api/files/upload-part/1' },
              { partNumber: 2, uploadUrl: '/api/files/upload-part/2' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/files/complete')) {
        return new Response(
          JSON.stringify({
            fileId: 'file-1',
            objectKey: 'obj/file-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = renderHarness();
    const file = new File(['hello-world'], 'hello.txt', { type: 'text/plain' });

    act(() => {
      void latestControls?.relayFile(file, null, 'pending-1');
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/files/complete',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const completeCall = fetchMock.mock.calls.find(([url]) => url === '/api/files/complete');
    expect(completeCall).toBeDefined();
    const completeInit = completeCall?.[1] as unknown as RequestInit;
    const completeBody = JSON.parse(completeInit.body as string) as { parts: unknown[] };
    expect(completeBody.parts).toHaveLength(2);
    expect(latestHarnessState?.sendServerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'relay-file-announced',
      }),
    );
    expect(uploadRelayPartsConcurrently).toHaveBeenCalled();

    view.unmount();
  });

  it('shows a clear failure when server completion times out', async () => {
    mockUploadRelayParts = false;
    vi.useFakeTimers();
    vi.stubGlobal('XMLHttpRequest', SuccessfulUploadXHR);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/files/upload-request')) {
        return new Response(
          JSON.stringify({
            fileId: 'file-1',
            objectKey: 'obj/file-1',
            uploadToken: 'token-1',
            chunkSizeBytes: 5,
            uploadedParts: [],
            parts: [{ partNumber: 1, uploadUrl: '/api/files/upload-part/1' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.endsWith('/api/files/complete')) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = renderHarness();
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });

    act(() => {
      void latestControls?.relayFile(file, null, 'pending-1');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
      await Promise.resolve();
    });

    expect(latestHarnessState?.updateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        note: expect.stringContaining('服务器合并文件超时'),
      }),
    );
    expect(latestHarnessState?.showTransientNotice).toHaveBeenCalledWith(
      expect.stringContaining('服务器合并文件超时'),
      4200,
    );

    view.unmount();
    vi.useRealTimers();
  });
});
