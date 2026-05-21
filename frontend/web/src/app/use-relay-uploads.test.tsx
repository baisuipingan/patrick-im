import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRelayUploads, type RelayUploadControls } from '@/app/use-relay-uploads';
import type { TransferRow, UiMessage } from '@/app/types';

let latestControls: RelayUploadControls | null = null;

vi.mock('@/app/relay-utils', async () => {
  const actual = await vi.importActual<typeof import('@/app/relay-utils')>('@/app/relay-utils');
  return {
    ...actual,
    uploadRelayPartsConcurrently: vi.fn(
      async () =>
        await new Promise<void>(() => {
          // Keep the mocked upload in-flight so the hook has a live relay task to abort.
        }),
    ),
  };
});

function Harness() {
  const messagesRef = React.useRef<UiMessage[]>([]);
  const transfersRef = React.useRef<Record<string, TransferRow>>({});
  const activeRoomRef = React.useRef<string | null>('room-a');
  const closedTransferIdsRef = React.useRef<Set<string>>(new Set());

  const controls = useRelayUploads({
    activeRoom: 'room-a',
    activeRoomRef,
    closedTransferIdsRef,
    getPeerDisplayName: (peerId) => peerId,
    messagesRef,
    removePendingFile: vi.fn(),
    sendServerMessage: vi.fn(() => true),
    setTransfers: (updater) => {
      const next = typeof updater === 'function' ? updater(transfersRef.current) : updater;
      transfersRef.current = next;
    },
    showTransientNotice: vi.fn(),
    transfersRef,
    updateTransfer: vi.fn(),
  });

  latestControls = controls;
  return null;
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
              partUrls: [{ partNumber: 1, url: 'https://example.com/1', headers: [] }],
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
});
