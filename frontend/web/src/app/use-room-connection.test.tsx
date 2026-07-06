import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse } from '@shared/protocol';
import { useRoomConnection } from '@/app/use-room-connection';

const peerMeshInstances: Array<{ closed: boolean; callbacks: Record<string, unknown>; close: () => void }> = [];

vi.mock('@/lib/peer-mesh', () => {
  class MockPeerMesh {
    closed = false;
    constructor(public callbacks: Record<string, unknown>) {
      peerMeshInstances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  return {
    PeerMesh: MockPeerMesh,
  };
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  closeWith(code: number) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

function HookHarness(props: {
  session: SessionResponse | null;
  activeRoom: string | null;
  nickname?: string;
  onNetworkOffline?: () => void;
  onNetworkOnline?: () => void;
  onRoomDispose?: (transport: 'beacon' | 'fetch') => void;
  onRoomReset?: () => void;
  onServerEvent?: (event: unknown) => void;
  onRoomConnected?: (roomId: string) => void;
  setNotice?: (message: string) => void;
}) {
  useRoomConnection({
    activeRoom: props.activeRoom,
    roomConnectionNonce: 0,
    session: props.session,
    nickname: props.nickname ?? 'Patrick',
    onNetworkOffline: props.onNetworkOffline ?? vi.fn(),
    onNetworkOnline: props.onNetworkOnline ?? vi.fn(),
    onRoomDispose: props.onRoomDispose ?? vi.fn(),
    onIncomingFile: vi.fn(),
    onPeerPathChange: vi.fn(),
    onPeerStateChange: vi.fn(),
    onRoomConnected: props.onRoomConnected ?? vi.fn(),
    onRoomReset: props.onRoomReset ?? vi.fn(),
    onServerEvent: props.onServerEvent ?? vi.fn(),
    onTransferUpdate: vi.fn(),
    prepareIncomingFileTarget: vi.fn(async () => ({ mode: 'memory' as const })),
    setNotice: props.setNotice ?? vi.fn(),
  });

  return null;
}

function renderHookHarness(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    rerender(nextElement: React.ReactElement) {
      act(() => {
        root.render(nextElement);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const session: SessionResponse = {
  clientId: 'self',
  nickname: 'Patrick',
  iceServers: [],
  relayFileLimitBytes: 1024,
  directFileSoftLimitBytes: 1024,
  recommendedTransferMode: 'auto',
};

describe('use-room-connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    peerMeshInstances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens websocket and reports room connected', async () => {
    const onRoomConnected = vi.fn();
    renderHookHarness(<HookHarness session={session} activeRoom="room-a" onRoomConnected={onRoomConnected} />);

    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      FakeWebSocket.instances[0].open();
    });

    expect(onRoomConnected).toHaveBeenCalledWith('room-a');
  });

  it('passes session token as websocket subprotocol', () => {
    renderHookHarness(
      <HookHarness session={{ ...session, sessionToken: 'signed-session-token' }} activeRoom="room-a" />,
    );

    expect(FakeWebSocket.instances[0].protocols).toEqual([
      'patrick-im',
      'patrick-im-session.signed-session-token',
    ]);
  });

  it('forwards non-pong server events', async () => {
    const onServerEvent = vi.fn();
    renderHookHarness(<HookHarness session={session} activeRoom="room-a" onServerEvent={onServerEvent} />);

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].message({
        type: 'error',
        code: 'bad',
        message: 'oops',
      });
      FakeWebSocket.instances[0].message({
        type: 'pong',
        serverTime: 1,
      });
    });

    expect(onServerEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps socket alive when server event handling fails', async () => {
    const setNotice = vi.fn();
    renderHookHarness(
      <HookHarness
        session={session}
        activeRoom="room-a"
        onServerEvent={() => {
          throw new Error('boom');
        }}
        setNotice={setNotice}
      />,
    );

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].message({
        type: 'chat-event',
      });
    });

    expect(setNotice).toHaveBeenCalledWith('处理信令消息失败，请刷新页面重试。');
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.OPEN);
  });

  it('pauses on offline and reconnects after online', async () => {
    const onNetworkOffline = vi.fn();
    const onNetworkOnline = vi.fn();
    renderHookHarness(
      <HookHarness
        session={session}
        activeRoom="room-a"
        onNetworkOffline={onNetworkOffline}
        onNetworkOnline={onNetworkOnline}
      />,
    );

    act(() => {
      FakeWebSocket.instances[0].open();
      window.dispatchEvent(new Event('offline'));
    });

    expect(onNetworkOffline).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(onNetworkOnline).toHaveBeenCalledTimes(1);

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('disposes room uploads with fetch on unmount', () => {
    const onRoomDispose = vi.fn();
    const view = renderHookHarness(<HookHarness session={session} activeRoom="room-a" onRoomDispose={onRoomDispose} />);

    view.unmount();

    expect(onRoomDispose).toHaveBeenCalledWith('fetch');
    expect(peerMeshInstances[0]?.closed).toBe(true);
  });

  it('updates nickname without rebuilding room connection', () => {
    const onRoomReset = vi.fn();
    const view = renderHookHarness(
      <HookHarness session={session} activeRoom="room-a" nickname="Patrick" onRoomReset={onRoomReset} />,
    );

    act(() => {
      FakeWebSocket.instances[0].open();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onRoomReset).toHaveBeenCalledTimes(1);

    view.rerender(<HookHarness session={session} activeRoom="room-a" nickname="Patrick Renamed" onRoomReset={onRoomReset} />);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onRoomReset).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances[0].sent.at(-1)).toBe(
      JSON.stringify({
        type: 'set-profile',
        nickname: 'Patrick Renamed',
      }),
    );
  });
});
