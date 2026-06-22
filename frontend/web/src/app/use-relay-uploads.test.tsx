import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelayUploads, type RelayUploadControls } from '@/app/use-relay-uploads';
import type { TransferRow, UiMessage } from '@/app/types';

let latestControls: RelayUploadControls | null = null;
let latestHarnessState: HarnessState | null = null;
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
  aborted = false;

  open(): void {}

  setRequestHeader(): void {}

  send(body: BodyInit): void {
    SuccessfulUploadXHR.requests.push(this);
    window.setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: getBodySize(body) } as ProgressEvent);
      this.responseText = JSON.stringify({
        fileId: 'file-1',
        objectKey: 'obj/file-1',
      });
      this.onload?.();
    }, 0);
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

class HangingUploadXHR extends SuccessfulUploadXHR {
  send(_body: BodyInit): void {
    SuccessfulUploadXHR.requests.push(this);
  }
}

class TimeoutUploadXHR extends SuccessfulUploadXHR {
  send(_body: BodyInit): void {
    SuccessfulUploadXHR.requests.push(this);
  }
}

function getBodySize(body: BodyInit): number {
  if (body instanceof Blob) {
    return body.size;
  }
  if (body instanceof FormData) {
    const file = body.get('file');
    return file instanceof File ? file.size : 0;
  }
  if (typeof body === 'string') {
    return body.length;
  }
  return 0;
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
    vi.stubGlobal('XMLHttpRequest', HangingUploadXHR);
    const view = renderHarness();
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });

    act(() => {
      void latestControls?.relayFile(file, 'peer-1', 'pending-1');
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestControls?.getRelayTaskState('pending-1')).toBe('uploading');

    act(() => {
      latestControls?.abortRelayUploadsForThread('peer-1');
    });

    expect(SuccessfulUploadXHR.requests[0]?.aborted).toBe(true);
    expect(latestControls?.getRelayTaskState('pending-1')).toBe(null);

    view.unmount();
  });

  it('completes relay upload after all parts are acknowledged', async () => {
    vi.stubGlobal('XMLHttpRequest', SuccessfulUploadXHR);
    const view = renderHarness();
    const file = new File(['hello-world'], 'hello.txt', { type: 'text/plain' });

    act(() => {
      void latestControls?.relayFile(file, null, 'pending-1');
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(SuccessfulUploadXHR.requests).toHaveLength(1);
    expect(latestHarnessState?.sendServerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'relay-file-announced',
        file: expect.objectContaining({
          fileId: 'file-1',
          objectKey: 'obj/file-1',
        }),
      }),
    );

    view.unmount();
  });

  it('shows a clear failure when server completion times out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('XMLHttpRequest', TimeoutUploadXHR);
    const view = renderHarness();
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });

    act(() => {
      void latestControls?.relayFile(file, null, 'pending-1');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
      await Promise.resolve();
    });

    expect(latestHarnessState?.updateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        note: expect.stringContaining('长时间没有进度'),
      }),
    );
    expect(latestHarnessState?.showTransientNotice).toHaveBeenCalledWith(
      expect.stringContaining('长时间没有进度'),
      4200,
    );

    view.unmount();
    vi.useRealTimers();
  });
});
