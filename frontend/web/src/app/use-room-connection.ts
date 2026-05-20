import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  ClientToServerMessage,
  DirectPeerState,
  ServerToClientMessage,
  SessionResponse,
} from '@shared/protocol';
import type { SocketStatus, TransferRow, UiMessage } from '@/app/types';
import { buildWsUrl } from '@/lib/utils';
import { PeerMesh, type DirectPathInfo, type IncomingFilePayload, type TransferUpdate } from '@/lib/peer-mesh';

const WS_HEARTBEAT_INTERVAL_MS = 15_000;
const WS_HEARTBEAT_STALE_AFTER_MS = 55_000;
const WS_WATCHDOG_INTERVAL_MS = 5_000;
const WS_RESUME_PROBE_INTERVAL_MS = 3_000;
const WS_CONNECT_TIMEOUT_MS = 12_000;
const WS_RECONNECT_BASE_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 30_000;

function buildRoomWebSocketUrl(roomId: string, nickname: string): string {
  const url = new URL(buildWsUrl(`/api/rooms/${roomId}/ws`));
  if (nickname.trim()) {
    url.searchParams.set('nickname', nickname.trim());
  }
  return url.toString();
}

function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

interface UseRoomConnectionOptions {
  activeRoom: string | null;
  roomConnectionNonce: number;
  session: SessionResponse | null;
  nickname: string;
  onNetworkOffline: () => void;
  onNetworkOnline: () => void;
  onRoomDispose: (transport: 'beacon' | 'fetch') => void;
  onIncomingFile: (payload: IncomingFilePayload) => void;
  onPeerPathChange: (peerId: string, path: DirectPathInfo | null) => void;
  onPeerStateChange: (peerId: string, nextState: DirectPeerState) => void;
  onRoomConnected: (roomId: string) => void;
  onRoomReset: () => void;
  onServerEvent: (event: ServerToClientMessage) => void;
  onTransferUpdate: (update: TransferUpdate) => void;
  prepareIncomingFileTarget: (payload: { fileName: string; size: number }) => Promise<{
    mode: 'memory' | 'disk';
    fileHandle?: FileSystemFileHandle;
    writer?: FileSystemWritableFileStream;
  }>;
  setNotice: (message: string) => void;
}

export interface RoomConnectionHandle {
  meshRef: MutableRefObject<PeerMesh | null>;
  sendServerMessage: (payload: ClientToServerMessage) => boolean;
  socketStatus: SocketStatus;
}

export function useRoomConnection(options: UseRoomConnectionOptions): RoomConnectionHandle {
  const {
    activeRoom,
    roomConnectionNonce,
    session,
    nickname,
    onNetworkOffline,
    onNetworkOnline,
    onRoomDispose,
    onIncomingFile,
    onPeerPathChange,
    onPeerStateChange,
    onRoomConnected,
    onRoomReset,
    onServerEvent,
    onTransferUpdate,
    prepareIncomingFileTarget,
    setNotice,
  } = options;

  const meshRef = useRef<PeerMesh | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const socketStatusRef = useRef<SocketStatus>('idle');
  const reconnectTimerRef = useRef<number | null>(null);
  const connectTimeoutTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const watchdogTimerRef = useRef<number | null>(null);
  const resumeProbeTimerRef = useRef<number | null>(null);
  const lastSignalActivityRef = useRef(0);
  const connectStartedAtRef = useRef<number | null>(null);
  const connectionEpochRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const hasConnectedOnceRef = useRef(false);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('idle');

  const onIncomingFileRef = useLatest(onIncomingFile);
  const onNetworkOfflineRef = useLatest(onNetworkOffline);
  const onNetworkOnlineRef = useLatest(onNetworkOnline);
  const nicknameRef = useLatest(nickname);
  const onPeerPathChangeRef = useLatest(onPeerPathChange);
  const onPeerStateChangeRef = useLatest(onPeerStateChange);
  const onRoomConnectedRef = useLatest(onRoomConnected);
  const onRoomDisposeRef = useLatest(onRoomDispose);
  const onRoomResetRef = useLatest(onRoomReset);
  const onServerEventRef = useLatest(onServerEvent);
  const onTransferUpdateRef = useLatest(onTransferUpdate);
  const prepareIncomingFileTargetRef = useLatest(prepareIncomingFileTarget);
  const setNoticeRef = useLatest(setNotice);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearConnectTimeout = useCallback(() => {
    if (connectTimeoutTimerRef.current) {
      window.clearTimeout(connectTimeoutTimerRef.current);
      connectTimeoutTimerRef.current = null;
    }
    connectStartedAtRef.current = null;
  }, []);

  const stopHeartbeatLoop = useCallback(() => {
    if (heartbeatTimerRef.current) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (watchdogTimerRef.current) {
      window.clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const retireSocket = useCallback(
    (socket: WebSocket | null, closeCode = 4000, closeReason = 'replace socket') => {
      if (!socket) {
        return;
      }

      if (wsRef.current === socket) {
        wsRef.current = null;
        clearConnectTimeout();
      }

      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(closeCode, closeReason);
      }
    },
    [clearConnectTimeout],
  );

  const setSignalStatus = useCallback((next: SocketStatus) => {
    socketStatusRef.current = next;
    setSocketStatus(next);
  }, []);

  const canAttemptConnection = useCallback((): boolean => {
    if (!activeRoom || !session) {
      return false;
    }

    if (document.visibilityState !== 'visible') {
      setSignalStatus('paused');
      return false;
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setSignalStatus('paused');
      return false;
    }

    return true;
  }, [activeRoom, session, setSignalStatus]);

  const isSocketConnectingTooLong = useCallback((socket: WebSocket | null): boolean => {
    if (!socket || socket.readyState !== WebSocket.CONNECTING || connectStartedAtRef.current === null) {
      return false;
    }

    return Date.now() - connectStartedAtRef.current >= WS_CONNECT_TIMEOUT_MS;
  }, []);

  const sendServerMessage = useCallback((payload: ClientToServerMessage): boolean => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }

    wsRef.current.send(JSON.stringify(payload));
    return true;
  }, []);

  useEffect(() => {
    if (!activeRoom || !session) {
      setSignalStatus('idle');
      return;
    }

    onRoomResetRef.current();
    meshRef.current?.close();
    meshRef.current = null;
    setSignalStatus('connecting');

    const mesh = new PeerMesh({
      localClientId: session.clientId,
      iceServers: session.iceServers,
      directFileSoftLimitBytes: session.directFileSoftLimitBytes,
      prepareIncomingFileTarget: (payload) => prepareIncomingFileTargetRef.current(payload),
      sendSignal: (targetId, payload) => {
        sendServerMessage({
          type: 'signal',
          targetId,
          payload,
        });
      },
      onPeerStateChange: (peerId, nextState) => {
        onPeerStateChangeRef.current(peerId, nextState);
      },
      onIncomingFile: (payload) => {
        onIncomingFileRef.current(payload);
      },
      onPeerPathChange: (peerId, path) => {
        onPeerPathChangeRef.current(peerId, path);
      },
      onTransferUpdate: (update) => {
        onTransferUpdateRef.current(update);
      },
    });
    meshRef.current = mesh;

    let disposed = false;
    let intentionallyClosed = false;

    const armConnectTimeout = (epoch: number, socket: WebSocket) => {
      clearConnectTimeout();
      connectStartedAtRef.current = Date.now();
      connectTimeoutTimerRef.current = window.setTimeout(() => {
        if (disposed || intentionallyClosed || wsRef.current !== socket || connectionEpochRef.current !== epoch) {
          return;
        }

        retireSocket(socket, 4010, 'connect timeout');
        scheduleReconnect();
      }, WS_CONNECT_TIMEOUT_MS);
    };

    const startHeartbeatLoop = (epoch: number, socket: WebSocket) => {
      stopHeartbeatLoop();
      lastSignalActivityRef.current = Date.now();

      heartbeatTimerRef.current = window.setInterval(() => {
        if (disposed || wsRef.current !== socket || connectionEpochRef.current !== epoch) {
          stopHeartbeatLoop();
          return;
        }

        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(JSON.stringify({ type: 'ping' } satisfies ClientToServerMessage));
      }, WS_HEARTBEAT_INTERVAL_MS);

      watchdogTimerRef.current = window.setInterval(() => {
        if (disposed || wsRef.current !== socket || connectionEpochRef.current !== epoch) {
          stopHeartbeatLoop();
          return;
        }

        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        if (Date.now() - lastSignalActivityRef.current <= WS_HEARTBEAT_STALE_AFTER_MS) {
          return;
        }

        retireSocket(socket, 4004, 'heartbeat timeout');
        scheduleReconnect();
      }, WS_WATCHDOG_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || intentionallyClosed) {
        return;
      }

      clearReconnectTimer();
      stopHeartbeatLoop();

      if (!canAttemptConnection()) {
        return;
      }

      const attempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = attempt;
      setSignalStatus('reconnecting');

      const delay = Math.min(WS_RECONNECT_MAX_DELAY_MS, WS_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1));
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connectWebSocket();
      }, delay);
    };

    const connectWebSocket = (forceFresh = false) => {
      if (!canAttemptConnection()) {
        return;
      }

      const existing = wsRef.current;
      if (
        !forceFresh &&
        existing &&
        (existing.readyState === WebSocket.OPEN ||
          (existing.readyState === WebSocket.CONNECTING && !isSocketConnectingTooLong(existing)))
      ) {
        return;
      }

      if (forceFresh && existing) {
        retireSocket(existing, 4005, 'refresh socket');
      }

      clearReconnectTimer();
      stopHeartbeatLoop();

      const epoch = connectionEpochRef.current + 1;
      connectionEpochRef.current = epoch;

      const ws = new WebSocket(buildRoomWebSocketUrl(activeRoom, nicknameRef.current || session.nickname));
      wsRef.current = ws;
      setSignalStatus(hasConnectedOnceRef.current || reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');
      armConnectTimeout(epoch, ws);

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws || connectionEpochRef.current !== epoch) {
          retireSocket(ws, 1000, 'stale socket');
          return;
        }

        clearConnectTimeout();
        reconnectAttemptRef.current = 0;
        hasConnectedOnceRef.current = true;
        setSignalStatus('connected');
        lastSignalActivityRef.current = Date.now();
        startHeartbeatLoop(epoch, ws);

        sendServerMessage({
          type: 'set-profile',
          nickname: nicknameRef.current || session.nickname,
        });

        onRoomConnectedRef.current(activeRoom);
      };

      ws.onmessage = (messageEvent) => {
        if (wsRef.current !== ws || connectionEpochRef.current !== epoch) {
          return;
        }

        const payload = JSON.parse(messageEvent.data as string) as ServerToClientMessage;
        lastSignalActivityRef.current = Date.now();

        if (payload.type === 'pong') {
          return;
        }

        if (payload.type !== 'signal') {
          onServerEventRef.current(payload);
        } else {
          onServerEventRef.current(payload);
        }
      };

      ws.onerror = () => {
        if (disposed || wsRef.current !== ws || connectionEpochRef.current !== epoch) {
          return;
        }

        if (socketStatusRef.current !== 'connected') {
          setSignalStatus('reconnecting');
        }
      };

      ws.onclose = (event) => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        clearConnectTimeout();
        stopHeartbeatLoop();

        if (disposed || intentionallyClosed) {
          return;
        }

        if (event.code === 4401) {
          setSignalStatus('closed');
          setNoticeRef.current('会话已失效，请刷新页面重试。');
          return;
        }

        if (event.code === 4409) {
          setSignalStatus('closed');
          setNoticeRef.current('当前页面的信令连接已被新的连接替换。');
          return;
        }

        scheduleReconnect();
      };
    };

    const suspendConnection = (reason: 'hidden' | 'offline') => {
      clearReconnectTimer();
      clearConnectTimeout();
      stopHeartbeatLoop();
      retireSocket(wsRef.current, reason === 'offline' ? 4001 : 4006, `suspend:${reason}`);
      setSignalStatus('paused');
    };

    const handleWake = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      reconnectAttemptRef.current = 0;
      if (socketStatusRef.current === 'connected' && wsRef.current?.readyState === WebSocket.OPEN) {
        lastSignalActivityRef.current = Date.now();
        sendServerMessage({ type: 'ping' });
        return;
      }

      connectWebSocket(Boolean(wsRef.current));
    };

    const handleOnline = () => {
      onNetworkOnlineRef.current();
      if (document.visibilityState !== 'visible') {
        return;
      }

      reconnectAttemptRef.current = 0;
      connectWebSocket(Boolean(wsRef.current));
    };

    const handleOffline = () => {
      onNetworkOfflineRef.current();
      suspendConnection('offline');
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        handleWake();
        return;
      }

      clearReconnectTimer();
      if (socketStatusRef.current !== 'connected') {
        setSignalStatus('paused');
      }
    };

    const closeSocket = () => {
      intentionallyClosed = true;
      onRoomDisposeRef.current('beacon');
      clearReconnectTimer();
      stopHeartbeatLoop();
      retireSocket(wsRef.current, 1000, 'page unload');
    };

    window.addEventListener('pagehide', closeSocket);
    window.addEventListener('beforeunload', closeSocket);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    resumeProbeTimerRef.current = window.setInterval(() => {
      if (disposed || intentionallyClosed) {
        return;
      }

      if (document.visibilityState !== 'visible') {
        return;
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return;
      }

      const socket = wsRef.current;
      if (socket?.readyState === WebSocket.OPEN || socketStatusRef.current === 'connected') {
        return;
      }

      if (socket?.readyState === WebSocket.CONNECTING && !isSocketConnectingTooLong(socket)) {
        return;
      }

      if (reconnectTimerRef.current) {
        return;
      }

      connectWebSocket(Boolean(socket));
    }, WS_RESUME_PROBE_INTERVAL_MS);
    connectWebSocket();

    return () => {
      disposed = true;
      intentionallyClosed = true;
      window.removeEventListener('pagehide', closeSocket);
      window.removeEventListener('beforeunload', closeSocket);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearReconnectTimer();
      clearConnectTimeout();
      stopHeartbeatLoop();
      if (resumeProbeTimerRef.current) {
        window.clearInterval(resumeProbeTimerRef.current);
        resumeProbeTimerRef.current = null;
      }
      retireSocket(wsRef.current, 1000, 'room cleanup');
      wsRef.current = null;
      onRoomDisposeRef.current('fetch');
      meshRef.current?.close();
      meshRef.current = null;
    };
  }, [
    activeRoom,
    canAttemptConnection,
    clearConnectTimeout,
    clearReconnectTimer,
    isSocketConnectingTooLong,
    roomConnectionNonce,
    retireSocket,
    session,
    sendServerMessage,
    setSignalStatus,
    stopHeartbeatLoop,
  ]);

  useEffect(() => {
    if (!session || socketStatus !== 'connected') {
      return;
    }

    sendServerMessage({
      type: 'set-profile',
      nickname: nicknameRef.current || session.nickname,
    });
  }, [nickname, nicknameRef, sendServerMessage, session, socketStatus]);

  return {
    meshRef,
    sendServerMessage,
    socketStatus,
  };
}
