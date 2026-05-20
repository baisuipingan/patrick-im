import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  Edit2,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  Menu,
  Paperclip,
  Pause,
  Play,
  Send,
  Trash2,
  Upload,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import type {
  ChatMessage,
  ClearThreadResponse,
  DirectPeerState,
  ServerToClientMessage,
  SessionResponse,
  TransferMode,
} from '@shared/protocol';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ComposerPanel, MessageList, TransferPanel } from '@/app/chat-sections';
import { ClearThreadDialog, EditNicknameDialog, ImagePreviewDialog } from '@/app/dialogs';
import {
  candidateAddressLabel,
  candidateTypeLabel,
  directPathDescription,
  directPathLabel,
  formatClockTime,
  formatTransferNote,
  formatTransferSpeed,
  getInitials,
  getMessageThreadKey,
  getPeerPresenceStatus,
  getThreadKeyForClearedEvent,
  peerBadgeTone,
  peerDotTone,
  peerSignalLabel,
  peerStateLabel,
  socketStatusDotTone,
  socketStatusLabel,
  socketStatusTone,
  summarizeMessage,
  transferStatusLabel,
  transportBadgeTone,
  transportLabel,
} from '@/app/chat-formatters';
import { RoomPicker } from '@/app/room-picker';
import {
  appendMessageState,
  applyPeerPathUpdate,
  applyPeerStateUpdate,
  buildDefaultNotice,
  clearThreadUnreadCount,
  closeTransferRow,
  reconcileSnapshotPeerState,
  removePeerFromList,
  upsertPeerList,
} from '@/app/room-state';
import { buildDirectFileMessage, canUseDirectTransfer, collectSendPayload } from '@/app/send-actions';
import { handleServerEventMessage } from '@/app/server-events';
import {
  clearThreadMessages,
  clearThreadTransfers,
  formatThreadClearRemoteNotice,
  formatThreadClearSuccessNotice,
} from '@/app/thread-actions';
import { reduceTransferUpdate } from '@/app/transfer-state';
import type { PendingAttachment, PeerPresenceStatus, TransferRow, UiMessage } from '@/app/types';
import {
  clearReceiveDirectory,
  createWritableFile,
  ensureDirectoryWritable,
  loadReceiveDirectoryState,
  pickReceiveDirectory,
  supportsDirectoryPicker,
  type StoredDirectoryState,
} from '@/lib/file-system';
import { cn, formatBytes, roomToSlug } from '@/lib/utils';
import type { DirectPathInfo, IncomingFilePayload, TransferUpdate } from '@/lib/peer-mesh';
import { useRelayUploads, type RelayUploadControls } from '@/app/use-relay-uploads';
import { useRoomConnection } from '@/app/use-room-connection';

const GLOBAL_THREAD = '__global__';
const RECENT_ROOMS_KEY = 'patrick-im:recent-rooms';
const TRANSFER_MODE_TOOLTIP_DELAY_MS = 500;
const PEER_PATH_TOOLTIP_DELAY_MS = 500;
const TRANSIENT_NOTICE_RESET_MS = 2600;
const LARGE_DIRECT_FILE_NOTICE_BYTES = 256 * 1024 * 1024;
const HEADER_BADGE_CLASS = 'h-7 rounded-full px-3 text-[12px] font-medium shadow-sm';

function ShareRoomIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1236 1024" fill="none" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M741.743 1018.343c-28.287 0-50.917-11.315-73.547-28.288-22.63-22.63-39.602-50.917-39.602-84.862V792.044c-124.464 0-328.133 33.945-435.624 181.039-16.973 28.287-56.575 45.26-90.52 50.917H85.478C28.903 1012.685-5.042 961.768 0.616 905.193c28.287-243.27 113.15-418.652 260.243-537.458 107.492-84.862 231.956-130.122 367.735-141.437V118.807c0-50.917 22.63-96.177 67.89-113.15C736.086-5.657 781.345 0 815.29 33.945l362.077 367.735c28.288 22.63 45.26 56.574 50.918 96.176 5.657 39.603-5.658 79.205-33.945 107.492-5.658 5.658-11.315 16.972-22.63 22.63l-350.762 356.42c-22.63 22.63-50.918 33.945-79.205 33.945z m-90.52-339.448h90.52v226.298l356.42-367.734 5.658-5.658c5.657-5.657 5.657-16.972 5.657-22.63 0-11.315-5.657-16.972-11.315-22.63l-5.657-5.657-356.42-362.077V333.79l-79.205 5.658c-118.806 0-231.956 39.602-328.132 113.149-113.15 90.519-186.696 237.613-209.326 429.967 141.436-175.382 390.364-203.669 531.8-203.669z"
      />
    </svg>
  );
}

function getInitialNickname(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem('patrick-im:nickname') ?? '';
}

function getInitialRoomDraft(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  const hashRoom = decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
  if (hashRoom) {
    return hashRoom;
  }

  return window.localStorage.getItem('patrick-im:last-room') ?? '';
}

function loadRecentRooms(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(RECENT_ROOMS_KEY);
    const parsed = stored ? (JSON.parse(stored) as string[]) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 8) : [];
  } catch {
    return [];
  }
}

function storeRecentRooms(rooms: string[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(rooms.slice(0, 8)));
}

function rememberRoom(roomId: string, current: string[]): string[] {
  const next = [roomId, ...current.filter((item) => item !== roomId)].slice(0, 8);
  storeRecentRooms(next);
  return next;
}


function getRoomShareLink(roomId: string): string {
  return `${window.location.origin}/#${encodeURIComponent(roomId)}`;
}

export default function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [nickname, setNickname] = useState(getInitialNickname);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [roomDraft, setRoomDraft] = useState(getInitialRoomDraft);
  const [recentRooms, setRecentRooms] = useState(loadRecentRooms);
  const [showRoomPicker, setShowRoomPicker] = useState(() => !Boolean(getInitialRoomDraft()));
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const [roomConnectionNonce, setRoomConnectionNonce] = useState(0);
  const [activeThread, setActiveThread] = useState<string>(GLOBAL_THREAD);
  const [composer, setComposer] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [peers, setPeers] = useState<Array<{ clientId: string; nickname: string; joinedAt: number }>>([]);
  const [transferMode, setTransferMode] = useState<TransferMode>('auto');
  const [directStates, setDirectStates] = useState<Record<string, DirectPeerState>>({});
  const [directPaths, setDirectPaths] = useState<Record<string, DirectPathInfo>>({});
  const [transfers, setTransfers] = useState<Record<string, TransferRow>>({});
  const [notice, setNotice] = useState(() => buildDefaultNotice(null));
  const [receiveDirectory, setReceiveDirectory] = useState<StoredDirectoryState>(() => ({
    handle: null,
    status: supportsDirectoryPicker() ? 'not-configured' : 'unsupported',
    name: '',
  }));
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const [isClearingThread, setIsClearingThread] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [isSending, setIsSending] = useState(false);
  const [transferModeTooltip, setTransferModeTooltip] = useState<TransferMode | null>(null);
  const [peerPathTooltip, setPeerPathTooltip] = useState<{ peerId: string; scope: 'sidebar' | 'header' } | null>(null);
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);

  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const dragCounterRef = useRef(0);
  const objectUrlsRef = useRef<string[]>([]);
  const peerNamesRef = useRef<Record<string, string>>({});
  const receiveDirectoryRef = useRef<StoredDirectoryState>({
    handle: null,
    status: supportsDirectoryPicker() ? 'not-configured' : 'unsupported',
    name: '',
  });
  const messagesRef = useRef<UiMessage[]>([]);
  const transfersRef = useRef<Record<string, TransferRow>>({});
  const unreadCountsRef = useRef<Record<string, number>>({});
  const directPathsRef = useRef<Record<string, DirectPathInfo>>({});
  const activeRoomRef = useRef<string | null>(null);
  const activeThreadRef = useRef<string>(GLOBAL_THREAD);
  const copiedMessageTimerRef = useRef<number | null>(null);
  const transferModeTooltipTimerRef = useRef<number | null>(null);
  const peerPathTooltipTimerRef = useRef<number | null>(null);
  const shareFeedbackTimerRef = useRef<number | null>(null);
  const closedTransferIdsRef = useRef<Set<string>>(new Set());
  const noticeResetTimerRef = useRef<number | null>(null);
  const activeTransferNoticeRef = useRef<string | null>(null);
  const relayUploadsRef = useRef<RelayUploadControls | null>(null);

  const selfId = session?.clientId;
  const roomLink = activeRoom ? getRoomShareLink(activeRoom) : '';
  const activePeerId = activeThread === GLOBAL_THREAD ? null : activeThread;
  const activePeer = peers.find((peer) => peer.clientId === activePeerId) ?? null;
  const effectiveTransferMode: TransferMode = activePeerId ? transferMode : 'relay-only';
  const canToggleTransferMode = Boolean(activePeerId);
  const sortedMessages = useMemo(
    () => [...messages].sort((left, right) => left.createdAt - right.createdAt),
    [messages],
  );
  const transferRows = useMemo(
    () => Object.values(transfers).sort((left, right) => right.startedAt - left.startedAt),
    [transfers],
  );
  const receiveDirectoryBadgeText =
    receiveDirectory.status === 'ready'
      ? `接收目录: ${receiveDirectory.name}`
      : receiveDirectory.status === 'needs-permission'
        ? `接收目录待授权: ${receiveDirectory.name}`
        : null;

  const threadMessages = useMemo(() => {
    const map: Record<string, UiMessage[]> = {
      [GLOBAL_THREAD]: [],
    };

    for (const message of sortedMessages) {
      const key = getMessageThreadKey(message, selfId);
      if (!map[key]) {
        map[key] = [];
      }
      map[key].push(message);
    }

    return map;
  }, [selfId, sortedMessages]);

  const filteredMessages = threadMessages[activeThread] ?? [];

  const knownPeerIds = useMemo(() => {
    const ids = new Set<string>();
    peers.forEach((peer) => ids.add(peer.clientId));
    Object.keys(directStates).forEach((peerId) => ids.add(peerId));
    sortedMessages.forEach((message) => {
      const key = getMessageThreadKey(message, selfId);
      if (key !== GLOBAL_THREAD) {
        ids.add(key);
      }
    });
    if (selfId) {
      ids.delete(selfId);
    }
    return [...ids];
  }, [directStates, peers, selfId, sortedMessages]);

  function getPeerDisplayName(peerId: string, fallback?: string): string {
    if (peerId === selfId) {
      return nickname || session?.nickname || fallback || peerId;
    }
    return (
      peers.find((peer) => peer.clientId === peerId)?.nickname ??
      peerNamesRef.current[peerId] ??
      fallback ??
      peerId
    );
  }

  function getPeerPresence(peerId: string): PeerPresenceStatus {
    return getPeerPresenceStatus(
      socketStatus,
      peers.some((peer) => peer.clientId === peerId),
      directStates[peerId],
    );
  }

  const sidebarPeers = useMemo(
    () =>
      [...knownPeerIds].sort((left, right) => {
        const leftOnline = peers.some((peer) => peer.clientId === left);
        const rightOnline = peers.some((peer) => peer.clientId === right);
        if (leftOnline !== rightOnline) {
          return rightOnline ? 1 : -1;
        }

        const leftLast = (threadMessages[left] ?? []).at(-1)?.createdAt ?? 0;
        const rightLast = (threadMessages[right] ?? []).at(-1)?.createdAt ?? 0;
        return rightLast - leftLast;
      }),
    [knownPeerIds, peers, threadMessages],
  );

  const { meshRef, sendServerMessage, socketStatus } = useRoomConnection({
    activeRoom,
    roomConnectionNonce,
    session,
    nickname,
    onNetworkOffline: () => {
      relayUploadsRef.current?.pauseAllRelayUploads({
        reason: 'offline',
        notice: '网络已断开，未完成的服务端中继上传已暂停。',
      });
    },
    onNetworkOnline: () => {
      void relayUploadsRef.current?.flushPendingRelayAborts();
      relayUploadsRef.current?.resumeOfflinePausedRelayUploads();
    },
    onRoomDispose: (transport) => {
      relayUploadsRef.current?.abortAllRelayUploads({
        reason: 'cancelled locally',
        transport,
        updateUi: false,
      });
    },
    onIncomingFile: handleIncomingFile,
    onPeerPathChange: applyPeerPath,
    onPeerStateChange: applyPeerState,
    onRoomConnected: (roomId) => {
      setNotice(getDefaultNotice(roomId));
      relayUploadsRef.current?.flushPendingRelayAnnounces({ roomId });
    },
    onRoomReset: () => {
      resetRoomLocalState();
    },
    onServerEvent: handleServerEvent,
    onTransferUpdate: updateTransfer,
    prepareIncomingFileTarget,
    setNotice,
  });

  const relayUploads = useRelayUploads({
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
  });
  relayUploadsRef.current = relayUploads;

  const livePeerCount = useMemo(() => {
    const ids = new Set<string>();
    if (socketStatus === 'connected') {
      peers.forEach((peer) => ids.add(peer.clientId));
    }
    Object.entries(directStates).forEach(([peerId, state]) => {
      if (state === 'connected') {
        ids.add(peerId);
      }
    });
    return ids.size;
  }, [directStates, peers, socketStatus]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  useEffect(() => {
    unreadCountsRef.current = unreadCounts;
  }, [unreadCounts]);

  useEffect(() => {
    directPathsRef.current = directPaths;
  }, [directPaths]);

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  useEffect(() => {
    receiveDirectoryRef.current = receiveDirectory;
  }, [receiveDirectory]);

  useEffect(() => {
    if (canToggleTransferMode) {
      return;
    }

    if (transferModeTooltipTimerRef.current) {
      window.clearTimeout(transferModeTooltipTimerRef.current);
      transferModeTooltipTimerRef.current = null;
    }
    setTransferModeTooltip(null);
  }, [canToggleTransferMode]);

  useEffect(() => {
    window.localStorage.setItem('patrick-im:nickname', nickname);
  }, [nickname]);

  useEffect(() => {
    if (!isEditingNickname) {
      setNicknameDraft(nickname);
    }
  }, [isEditingNickname, nickname]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/session', {
          credentials: 'include',
        });
        if (!response.ok) {
          throw new Error(`session_${response.status}`);
        }

        const payload = (await response.json()) as SessionResponse;
        if (cancelled) {
          return;
        }

        setSession(payload);
        setSessionError('');
        if (!nickname) {
          setNickname(payload.nickname);
        }

        if (roomDraft.trim()) {
          const normalized = roomToSlug(roomDraft);
          setActiveRoom(normalized);
          setShowRoomPicker(false);
        } else {
          setShowRoomPicker(true);
        }
      } catch {
        if (!cancelled) {
          setSessionError('无法初始化匿名会话，请刷新页面重试。');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }

    void relayUploads.flushPendingRelayAborts();
  }, [session]);

  useEffect(() => {
    if (!session || socketStatus !== 'connected') {
      return;
    }

    relayUploads.flushPendingRelayAnnounces();
  }, [activeRoom, relayUploads, session, socketStatus]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const state = await loadReceiveDirectoryState();
      if (!cancelled) {
        setReceiveDirectory(state);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [activeThread, filteredMessages.length]);

  useEffect(() => {
    const composerElement = composerRef.current;
    if (!composerElement) {
      return;
    }

    composerElement.style.height = '0px';
    composerElement.style.height = `${Math.min(composerElement.scrollHeight, 168)}px`;
  }, [composer]);

  useEffect(() => {
    return () => {
      if (copiedMessageTimerRef.current) {
        window.clearTimeout(copiedMessageTimerRef.current);
        copiedMessageTimerRef.current = null;
      }
      if (transferModeTooltipTimerRef.current) {
        window.clearTimeout(transferModeTooltipTimerRef.current);
        transferModeTooltipTimerRef.current = null;
      }
      if (peerPathTooltipTimerRef.current) {
        window.clearTimeout(peerPathTooltipTimerRef.current);
        peerPathTooltipTimerRef.current = null;
      }
      if (shareFeedbackTimerRef.current) {
        window.clearTimeout(shareFeedbackTimerRef.current);
        shareFeedbackTimerRef.current = null;
      }
      if (noticeResetTimerRef.current) {
        window.clearTimeout(noticeResetTimerRef.current);
        noticeResetTimerRef.current = null;
      }
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    if (!activeRoom || socketStatus !== 'connected') {
      return;
    }

    setNotice((current) => {
      if (!/^正在进入房间\s+.+/.test(current)) {
        return current;
      }

      return `已进入房间 ${activeRoom}。全局聊天发给整个房间，切到设备会话后就是和该设备的私聊。`;
    });
  }, [activeRoom, socketStatus]);

  function addMessage(message: UiMessage, trackUnread = true): void {
    const result = appendMessageState({
      messages: messagesRef.current,
      message,
      selfId,
      activeThread: activeThreadRef.current,
      unreadCounts: unreadCountsRef.current,
      trackUnread,
    });

    if (!result.inserted) {
      return;
    }

    messagesRef.current = result.messages;
    setMessages(result.messages);
    if (result.unreadCounts !== unreadCountsRef.current) {
      replaceUnreadCounts(result.unreadCounts);
    }
  }

  function getDefaultNotice(roomId: string | null = activeRoom): string {
    return buildDefaultNotice(roomId);
  }

  function clearNoticeResetTimer(): void {
    if (noticeResetTimerRef.current) {
      window.clearTimeout(noticeResetTimerRef.current);
      noticeResetTimerRef.current = null;
    }
  }

  function clearShareFeedbackTimer(): void {
    if (shareFeedbackTimerRef.current) {
      window.clearTimeout(shareFeedbackTimerRef.current);
      shareFeedbackTimerRef.current = null;
    }
  }

  function showShareFeedback(message: string, durationMs = 1600): void {
    clearShareFeedbackTimer();
    setShareFeedback(message);
    shareFeedbackTimerRef.current = window.setTimeout(() => {
      setShareFeedback((current) => (current === message ? null : current));
      shareFeedbackTimerRef.current = null;
    }, durationMs);
  }

  function showTransientNotice(message: string, durationMs: number = TRANSIENT_NOTICE_RESET_MS): void {
    clearNoticeResetTimer();
    setNotice(message);
    noticeResetTimerRef.current = window.setTimeout(() => {
      setNotice((current) => (current === message ? getDefaultNotice() : current));
      noticeResetTimerRef.current = null;
    }, durationMs);
  }

  function updateTransfer(update: TransferUpdate): void {
    const result = reduceTransferUpdate({
      activeTransferNoticeId: activeTransferNoticeRef.current,
      closedTransferIds: closedTransferIdsRef.current,
      currentTransfers: transfersRef.current,
      getPeerDisplayName,
      update,
    });

    closedTransferIdsRef.current = result.closedTransferIds;
    if (result.resetActiveTransferNotice) {
      activeTransferNoticeRef.current = null;
    }
    if (result.noticeMessage) {
      showTransientNotice(result.noticeMessage, result.noticeDurationMs);
    }
    if (result.nextTransfers) {
      replaceTransfers(result.nextTransfers);
    }
  }

  function applyPeerState(peerId: string, nextState: DirectPeerState): void {
    setDirectStates((currentStates) => {
      const result = applyPeerStateUpdate({
        directPaths: directPathsRef.current,
        directStates: currentStates,
        nextState,
        peerId,
      });
      if (result.directPaths !== directPathsRef.current) {
        directPathsRef.current = result.directPaths;
        setDirectPaths(result.directPaths);
      }
      return result.directStates;
    });
  }

  function applyPeerPath(peerId: string, path: DirectPathInfo | null): void {
    setDirectPaths((current) => {
      const next = applyPeerPathUpdate({ directPaths: current, path, peerId });
      directPathsRef.current = next;
      return next;
    });
  }

  function replaceUnreadCounts(next: Record<string, number>): void {
    unreadCountsRef.current = next;
    setUnreadCounts(next);
  }

  function replaceTransfers(next: Record<string, TransferRow>): void {
    transfersRef.current = next;
    setTransfers(next);
  }

  function resetRoomLocalState(): void {
    peerNamesRef.current = {};
    messagesRef.current = [];
    transfersRef.current = {};
    directPathsRef.current = {};
    unreadCountsRef.current = {};
    closedTransferIdsRef.current.clear();
    setMessages([]);
    setPeers([]);
    setTransfers({});
    setDirectStates({});
    setDirectPaths({});
    setUnreadCounts({});
    setActiveThread(GLOBAL_THREAD);
  }

  async function prepareIncomingFileTarget(payload: {
    fileName: string;
    size: number;
  }): Promise<{
    mode: 'memory' | 'disk';
    fileHandle?: FileSystemFileHandle;
    writer?: FileSystemWritableFileStream;
  }> {
    const directoryHandle = await ensureDirectoryWritable(receiveDirectoryRef.current.handle);
    if (!directoryHandle) {
      if (payload.size >= LARGE_DIRECT_FILE_NOTICE_BYTES) {
        showTransientNotice(
          `正在接收大文件 ${payload.fileName}，当前未设置默认接收目录，会先走浏览器内存接收。建议先设置接收目录再收大文件。`,
          5600,
        );
      }
      return { mode: 'memory' };
    }

    const target = await createWritableFile(directoryHandle, payload.fileName);
    return {
      mode: 'disk',
      fileHandle: target.fileHandle,
      writer: target.writer,
    };
  }

  function handleIncomingFile(payload: IncomingFilePayload): void {
    const objectUrl = payload.blob ? URL.createObjectURL(payload.blob) : undefined;
    if (objectUrl) {
      objectUrlsRef.current.push(objectUrl);
    }

    const message: UiMessage = {
      id: payload.transferId,
      roomId: activeRoom ?? 'room',
      kind: 'direct-file',
      fromId: payload.remoteId,
      fromName: payload.remoteName,
      targetId: selfId ?? null,
      createdAt: Date.now(),
      transport: 'direct-p2p',
      file: {
        fileId: payload.transferId,
        fileName: payload.fileName,
        size: payload.size,
        contentType: payload.contentType,
        objectKey: '',
        fromId: payload.remoteId,
        fromName: payload.remoteName,
        createdAt: Date.now(),
        targetId: selfId ?? null,
        previewable: payload.contentType.startsWith('image/'),
      },
      localUrl: objectUrl,
      savedToDisk: payload.savedToDisk,
    };

    addMessage(message);

    if (payload.savedToDisk) {
      showTransientNotice(`已收到 ${payload.fileName}，并直接写入你设置的接收目录。`);
    } else {
      showTransientNotice(`已收到 ${payload.fileName}。`);
    }
  }

  function addSystemMessage(text: string, threadId: string = GLOBAL_THREAD): void {
    const message: UiMessage = {
      id: `system:${threadId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      roomId: activeRoom ?? 'room',
      kind: 'system',
      fromId: '__system__',
      fromName: 'System',
      targetId: threadId === GLOBAL_THREAD ? null : threadId,
      createdAt: Date.now(),
      transport: 'server-sync',
      text,
    };

    addMessage(message, false);
  }

  function markMessageCopied(messageId: string): void {
    setCopiedMessageId(messageId);
    if (copiedMessageTimerRef.current) {
      window.clearTimeout(copiedMessageTimerRef.current);
    }
    copiedMessageTimerRef.current = window.setTimeout(() => {
      setCopiedMessageId(null);
      copiedMessageTimerRef.current = null;
    }, 1800);
  }

  async function copyImageToClipboard(imageUrl: string): Promise<void> {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      throw new Error('clipboard_image_unsupported');
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error('clipboard_image_fetch_failed');
    }
    const blob = await response.blob();
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type || 'image/png']: blob,
      }),
    ]);
  }

  async function handleCopyMessage(message: UiMessage, imageUrl?: string): Promise<void> {
    try {
      if (message.text) {
        await navigator.clipboard.writeText(message.text);
        markMessageCopied(message.id);
        return;
      }

      if (message.file?.previewable && imageUrl) {
        await copyImageToClipboard(imageUrl);
        markMessageCopied(message.id);
      }
    } catch {
      if (message.text) {
        try {
          await navigator.clipboard.writeText(message.text);
          markMessageCopied(message.id);
          return;
        } catch {
          // Fall through to unified error notice below.
        }
      }
      setNotice('复制失败，请检查浏览器剪贴板权限。');
    }
  }

  function handleServerEvent(event: ServerToClientMessage): void {
    handleServerEventMessage(event, {
      activeRoom,
      selfId,
      acknowledgeRelayMessage: relayUploads.acknowledgeRelayMessage,
      addMessage,
      addSystemMessage,
      applyPeerState,
      clearThreadLocally,
      flushRelayAnnounces: (roomId) => {
        relayUploads.flushPendingRelayAnnounces({ roomId });
      },
      formatThreadClearRemoteNotice,
      getPeerDisplayName,
      getThreadKeyForClearedEvent,
      handleSignal: (fromId, payload, peerName) => {
        void meshRef.current?.handleSignal(fromId, payload, peerName);
      },
      replaceMessages: (nextMessages) => {
        messagesRef.current = nextMessages;
        setMessages(nextMessages);
        replaceUnreadCounts({});
      },
      replacePeers: (nextPeers) => {
        setPeers(nextPeers);
        nextPeers.forEach((peer) => meshRef.current?.ensurePeer(peer));
      },
      replacePeerNames: (peerNames) => {
        peerNamesRef.current = peerNames;
      },
      reconcileSnapshotPeers: (nextPeers) => {
        setDirectStates((currentStates) => {
          const result = reconcileSnapshotPeerState({
            directPaths: directPathsRef.current,
            directStates: currentStates,
            peers: nextPeers,
          });
          if (result.directPaths !== directPathsRef.current) {
            directPathsRef.current = result.directPaths;
            setDirectPaths(result.directPaths);
          }
          return result.directStates;
        });
      },
      setClearDialogOpen: setIsClearDialogOpen,
      setNotice,
      upsertPeer: (peer) => {
        const existed = peerNamesRef.current[peer.clientId];
        peerNamesRef.current[peer.clientId] = peer.nickname;
        setPeers((current) => upsertPeerList(current, peer));
        meshRef.current?.ensurePeer(peer);
        return Boolean(existed);
      },
      removePeer: (peerId) => {
        delete peerNamesRef.current[peerId];
        setPeers((current) => removePeerFromList(current, peerId));
        meshRef.current?.removePeer(peerId);
      },
    });
  }

  function createPendingAttachment(file: File): PendingAttachment {
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
    if (previewUrl) {
      objectUrlsRef.current.push(previewUrl);
    }
    return {
      id: crypto.randomUUID(),
      file,
      previewUrl,
    };
  }

  function appendPendingFiles(files: File[]): void {
    if (!files.length) {
      return;
    }

    setPendingFiles((current) => [...current, ...files.map((file) => createPendingAttachment(file))]);
  }

  function removePendingFile(id: string): void {
    setPendingFiles((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed?.previewUrl) {
        releaseObjectUrl(removed.previewUrl);
      }
      return current.filter((item) => item.id !== id);
    });
  }

  function switchToThread(threadKey: string): void {
    setActiveThread(threadKey);
    setUnreadCounts((current) => {
      const next = clearThreadUnreadCount(current, threadKey);
      unreadCountsRef.current = next;
      return next;
    });
    setIsSidebarOpen(false);
  }

  async function handleJoinRoom(rawRoom?: string): Promise<void> {
    if (!session) {
      return;
    }

    const normalized = roomToSlug(rawRoom ?? roomDraft);
    setRoomDraft(normalized);
    window.localStorage.setItem('patrick-im:last-room', normalized);
    window.history.replaceState(null, '', `#${encodeURIComponent(normalized)}`);
    setRecentRooms((current) => rememberRoom(normalized, current));
    setShowRoomPicker(false);
    setActiveThread(GLOBAL_THREAD);
    replaceUnreadCounts({});
    setActiveRoom(normalized);
    setRoomConnectionNonce((current) => current + 1);
    setNotice(`正在进入房间 ${normalized}...`);
  }

  async function handleCancelTransfer(transfer: TransferRow): Promise<void> {
    if (transfer.transport === 'direct-p2p') {
      meshRef.current?.cancelTransfer(transfer.id);
      return;
    }

    if (transfer.transport === 'server-relay') {
      await relayUploads.cancelRelayUpload(transfer.id);
    }
  }

  async function handlePauseTransfer(transfer: TransferRow): Promise<void> {
    if (transfer.transport !== 'server-relay') {
      return;
    }

    await relayUploads.pauseRelayUpload(transfer.id);
  }

  async function handleResumeTransfer(transfer: TransferRow): Promise<void> {
    if (transfer.transport !== 'server-relay') {
      return;
    }

    await relayUploads.resumeRelayUpload(transfer.id);
  }

  async function handleSingleFile(file: File, targetId: string | null, pendingAttachmentId?: string): Promise<void> {
    if (!session) {
      return;
    }

    const canDirect = canUseDirectTransfer({
      targetId,
      directState: targetId ? directStates[targetId] : undefined,
      fileSize: file.size,
      session,
      effectiveTransferMode,
    });

    if (canDirect && targetId) {
      const transferId = await meshRef.current?.sendDirectFile(targetId, file);
      if (!transferId) {
        throw new Error('direct_transfer_failed');
      }

      if (pendingAttachmentId) {
        removePendingFile(pendingAttachmentId);
      }

      const localUrl = URL.createObjectURL(file);
      objectUrlsRef.current.push(localUrl);

      addMessage(
        buildDirectFileMessage({
          activeRoom,
          contentType: file.type || 'application/octet-stream',
          fileName: file.name,
          fileSize: file.size,
          fromId: session.clientId,
          fromName: nickname || session.nickname,
          localUrl,
          targetId,
          transferId,
        }),
        false,
      );
      clearNoticeResetTimer();
      activeTransferNoticeRef.current = transferId;
      setNotice(`正在直连发送 ${file.name} 给 ${getPeerDisplayName(targetId)}。`);
      return;
    }

    await relayUploads.relayFile(file, targetId, pendingAttachmentId);
    if (targetId) {
      setNotice(`${file.name} 已加入服务端中继发送队列，正在发给 ${getPeerDisplayName(targetId)}。`);
    } else {
      setNotice(`${file.name} 已加入房间文件发送队列。`);
    }
  }

  async function handleSend(): Promise<void> {
    if (!selfId || !activeRoom || isSending) {
      return;
    }

    const { text, files } = collectSendPayload(composer, pendingFiles);
    if (!text && files.length === 0) {
      return;
    }

    setIsSending(true);

    try {
      if (text) {
        sendServerMessage({
          type: 'chat-send',
          text,
          targetId: activePeerId,
        });
      }

      for (const item of files) {
        await handleSingleFile(item.file, activePeerId, item.id);
      }

      setComposer('');
    } catch {
      setNotice('发送失败，请稍后重试。');
    } finally {
      setIsSending(false);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files: File[] = [];
    for (const item of event.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      event.preventDefault();
      appendPendingFiles(files);
    }
  }

  function handleDropFiles(files: File[]): void {
    appendPendingFiles(files);
    setNotice(`已添加 ${files.length} 个文件到发送列表。`);
  }

  function insertComposerNewline(): void {
    const composerElement = composerRef.current;
    if (!composerElement) {
      setComposer((current) => `${current}\n`);
      return;
    }

    const { selectionStart, selectionEnd } = composerElement;
    const before = composer.slice(0, selectionStart);
    const after = composer.slice(selectionEnd);
    const nextValue = `${before}\n${after}`;
    const nextCursor = selectionStart + 1;

    setComposer(nextValue);

    window.requestAnimationFrame(() => {
      composerElement.focus();
      composerElement.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || isComposing) {
      return;
    }

    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      event.preventDefault();
      insertComposerNewline();
      return;
    }

    event.preventDefault();
    void handleSend();
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    if (event.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      setIsDragging(false);
      dragCounterRef.current = 0;
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      handleDropFiles(files);
    }
  }

  async function handleCopyRoomLink(): Promise<void> {
    if (!roomLink) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(roomLink);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = roomLink;
        textArea.setAttribute('readonly', 'true');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!copied) {
          throw new Error('copy failed');
        }
      }
      showShareFeedback('已复制链接');
      showTransientNotice('房间链接已复制，对方打开后会自动进入这个房间。');
    } catch {
      showShareFeedback('复制失败');
      showTransientNotice('复制房间链接失败。');
    }
  }

  async function handlePickDirectory(): Promise<void> {
    const state = await pickReceiveDirectory();
    setReceiveDirectory(state);
    if (state.name) {
      setNotice(`已设置默认接收目录：${state.name}`);
    }
  }

  async function handleClearDirectory(): Promise<void> {
    await clearReceiveDirectory();
    setReceiveDirectory({
      handle: null,
      status: 'not-configured',
      name: '',
    });
    setNotice('已清除默认接收目录。');
  }

  async function handleSaveNickname(): Promise<void> {
    const next = nicknameDraft.trim();
    if (!next) {
      return;
    }
    setNickname(next);
    setIsEditingNickname(false);
    setNotice(`昵称已更新为 ${next}。`);
  }

  function releaseObjectUrl(url?: string): void {
    if (!url) {
      return;
    }

    URL.revokeObjectURL(url);
    objectUrlsRef.current = objectUrlsRef.current.filter((item) => item !== url);
    setPreviewImage((current) => (current === url ? null : current));
  }

  function clearThreadLocally(threadId: string): void {
    const next = clearThreadMessages({
      messages: messagesRef.current,
      selfId,
      threadId,
      releaseObjectUrl,
    });
    messagesRef.current = next;
    setMessages(next);
    setUnreadCounts((current) => {
      const nextUnreadCounts = clearThreadUnreadCount(current, threadId);
      unreadCountsRef.current = nextUnreadCounts;
      return nextUnreadCounts;
    });
    setTransfers((current) => {
      const nextTransfers = clearThreadTransfers(threadId, current);
      transfersRef.current = nextTransfers;
      return nextTransfers;
    });
  }

  function openClearCurrentThreadDialog(): void {
    setIsClearDialogOpen(true);
  }

  async function handleConfirmClearCurrentThread(): Promise<void> {
    if (!activeRoom || isClearingThread) {
      return;
    }

    const targetId = activePeerId;
    const threadId = activeThread;
    setIsClearingThread(true);

    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(activeRoom)}/threads/clear`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetId,
        }),
      });

      if (!response.ok) {
        throw new Error('clear_thread_failed');
      }

      const payload = (await response.json()) as ClearThreadResponse;
      clearThreadLocally(threadId);
      setIsClearDialogOpen(false);
      setNotice(
        formatThreadClearSuccessNotice({
          targetId: payload.targetId,
          removedMessages: payload.removedMessages,
          removedRelayFiles: payload.removedRelayFiles,
          getPeerDisplayName: (peerId) => getPeerDisplayName(peerId),
        }),
      );
    } catch {
      setNotice('清空失败，请稍后重试。');
    } finally {
      setIsClearingThread(false);
    }
  }

  if (sessionError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#eff6ff] p-6">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-slate-900">会话初始化失败</h2>
            <p className="text-sm text-slate-600">{sessionError}</p>
          </div>
          <Button onClick={() => window.location.reload()} className="w-full bg-[#1e3a8a] text-white hover:bg-[#1e3a8a]/90">
            重新加载
          </Button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#eff6ff] p-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">正在建立匿名会话</h2>
          <p className="mt-2 text-sm text-slate-600">正在向服务端申请匿名身份并准备进入房间...</p>
        </div>
      </div>
    );
  }

  if (showRoomPicker) {
    return (
      <RoomPicker
        roomDraft={roomDraft}
        recentRooms={recentRooms}
        currentRoom={activeRoom}
        onRoomDraftChange={setRoomDraft}
        onJoinRoom={(roomId) => {
          void handleJoinRoom(roomId);
        }}
      />
    );
  }

  const globalLastMessage = threadMessages[GLOBAL_THREAD]?.at(-1);
  const activePeerStatus = activePeerId ? directStates[activePeerId] : undefined;
  const activePeerPresence = activePeerId ? getPeerPresence(activePeerId) : null;
  const activePeerPath = activePeerId ? directPaths[activePeerId] : undefined;
  const activeSignalLabel = activePeerId
    ? peerSignalLabel(activePeerPresence ?? 'unknown')
    : socketStatusLabel(socketStatus);
  const transferModeTooltipText =
    transferModeTooltip === 'auto'
      ? '自动：只在局域网可直连时走 WebRTC，其余情况直接走中继。'
      : transferModeTooltip === 'relay-only'
        ? '中继：不尝试局域网直连，文件直接走云端中继。'
        : '';

  function scheduleTransferModeTooltip(mode: TransferMode): void {
    if (!canToggleTransferMode) {
      return;
    }

    if (transferModeTooltipTimerRef.current) {
      window.clearTimeout(transferModeTooltipTimerRef.current);
    }
    setTransferModeTooltip(null);
    transferModeTooltipTimerRef.current = window.setTimeout(() => {
      setTransferModeTooltip(mode);
      transferModeTooltipTimerRef.current = null;
    }, TRANSFER_MODE_TOOLTIP_DELAY_MS);
  }

  function clearTransferModeTooltip(): void {
    if (transferModeTooltipTimerRef.current) {
      window.clearTimeout(transferModeTooltipTimerRef.current);
      transferModeTooltipTimerRef.current = null;
    }
    setTransferModeTooltip(null);
  }

  function schedulePeerPathTooltip(peerId: string, scope: 'sidebar' | 'header'): void {
    if (directStates[peerId] !== 'connected') {
      return;
    }

    if (peerPathTooltipTimerRef.current) {
      window.clearTimeout(peerPathTooltipTimerRef.current);
    }
    setPeerPathTooltip(null);
    peerPathTooltipTimerRef.current = window.setTimeout(() => {
      setPeerPathTooltip({ peerId, scope });
      peerPathTooltipTimerRef.current = null;
    }, PEER_PATH_TOOLTIP_DELAY_MS);
  }

  function clearPeerPathTooltip(): void {
    if (peerPathTooltipTimerRef.current) {
      window.clearTimeout(peerPathTooltipTimerRef.current);
      peerPathTooltipTimerRef.current = null;
    }
    setPeerPathTooltip(null);
  }

  function renderPeerPathTooltip(peerId: string, align: 'left' | 'center') {
    const path = directPaths[peerId];

    return (
      <div
        className={cn(
          'pointer-events-none absolute z-20 w-[min(320px,calc(100vw-32px))] max-w-none rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-left text-[12px] leading-6 text-slate-600 shadow-[0_18px_40px_rgba(15,23,42,0.12)] backdrop-blur-md',
          align === 'center' ? 'left-1/2 top-[calc(100%+12px)] -translate-x-1/2' : 'left-0 top-[calc(100%+12px)]',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-0 h-3 w-3 -translate-y-1/2 rotate-45 border-l border-t border-slate-200 bg-white/95',
            align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-6',
          )}
        />
        <div className="text-[13px] font-semibold text-slate-900">{directPathLabel(path)}</div>
        <div className="mt-1 whitespace-normal break-words">{directPathDescription(path)}</div>
        <div className="mt-2 whitespace-normal break-words text-[11px] text-slate-500">
          本地 {candidateTypeLabel(path?.localCandidateType)} · 远端 {candidateTypeLabel(path?.remoteCandidateType)} ·{' '}
          {(path?.protocol ?? 'udp').toUpperCase()}
        </div>
        {path?.localAddress || path?.remoteAddress || path?.localCandidateType || path?.remoteCandidateType ? (
          <div className="mt-1 whitespace-normal break-words text-[11px] text-slate-400">
            {candidateAddressLabel('本地', path?.localCandidateType, path?.localAddress)} ·{' '}
            {candidateAddressLabel('远端', path?.remoteCandidateType, path?.remoteAddress)}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="relative h-screen w-full bg-[#eff6ff]"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-50 m-4 flex items-center justify-center rounded-xl border-4 border-dashed border-blue-500 bg-blue-900/50 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 text-xl font-medium text-white">
            <div className="rounded-full bg-blue-500/20 p-4">
              <Upload className="h-16 w-16 text-blue-300" />
            </div>
            <span>释放文件以添加到发送列表</span>
          </div>
        </div>
      ) : null}

      <div className="relative flex h-full w-full">
        <aside
          className={cn(
            'z-20 flex h-full w-full flex-col border-r border-slate-200 bg-white transition-transform duration-300 md:w-56 lg:w-64',
            'md:translate-x-0 md:relative',
            isSidebarOpen ? 'fixed inset-0 translate-x-0' : 'fixed -translate-x-full md:relative',
          )}
        >
          <div className="border-b border-slate-200 px-3 py-4 sm:px-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className={cn('h-2 w-2 rounded-full', socketStatusDotTone(socketStatus))} />
                <h2 className="truncate text-sm font-semibold">{livePeerCount} 在线设备</h2>
              </div>
              <Badge className={cn('h-7 shrink-0 px-3 text-[11px] font-medium shadow-sm', socketStatusTone(socketStatus))}>
                {socketStatusLabel(socketStatus)}
              </Badge>
              <button
                type="button"
                className="rounded-lg p-1.5 transition-colors hover:bg-slate-100 md:hidden"
                onClick={() => setIsSidebarOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
            <button
              type="button"
              className={cn(
                'relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all',
                activeThread === GLOBAL_THREAD
                  ? 'bg-[#1e3a8a] text-white'
                  : unreadCounts[GLOBAL_THREAD]
                    ? 'text-blue-900 shadow-lg shadow-green-200/50 ring-2 ring-green-400 hover:bg-blue-100'
                    : 'text-blue-900 hover:bg-blue-100',
              )}
              onClick={() => switchToThread(GLOBAL_THREAD)}
            >
              <div
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  activeThread === GLOBAL_THREAD ? 'bg-white/10 text-white' : 'bg-blue-100 text-blue-600',
                )}
              >
                <Globe className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">Global Chat</div>
                <div className={cn('truncate text-xs', activeThread === GLOBAL_THREAD ? 'text-white/70' : 'text-blue-500')}>
                  {globalLastMessage ? summarizeMessage(globalLastMessage) : 'Everyone'}
                </div>
              </div>
              {unreadCounts[GLOBAL_THREAD] ? (
                <div className="min-w-[20px] shrink-0 rounded-full bg-green-500 px-2 py-0.5 text-center text-xs font-semibold text-white">
                  {unreadCounts[GLOBAL_THREAD]}
                </div>
              ) : null}
            </button>

            {sidebarPeers.map((peerId) => {
              const state = directStates[peerId];
              const peerName = getPeerDisplayName(peerId);
              const presence = getPeerPresence(peerId);
              const signalLabel = peerSignalLabel(presence);
              const lastMessage = threadMessages[peerId]?.at(-1);
              const metaLabel = socketStatus === 'connected' ? (lastMessage ? summarizeMessage(lastMessage) : signalLabel) : signalLabel;
              const unread = unreadCounts[peerId] ?? 0;

              return (
                <button
                  key={peerId}
                  type="button"
                  className={cn(
                    'relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all',
                    activeThread === peerId
                      ? 'bg-[#1e3a8a] text-white'
                      : unread
                        ? 'text-blue-900 shadow-lg shadow-green-200/50 ring-2 ring-green-400 hover:bg-blue-100'
                        : 'text-blue-900 hover:bg-blue-100',
                  )}
                  onClick={() => switchToThread(peerId)}
                >
                  <div className="relative shrink-0">
                    <div
                      className={cn(
                        'flex h-9 w-9 items-center justify-center rounded-lg text-xs font-semibold',
                        activeThread === peerId ? 'bg-white/10 text-white' : 'bg-[#1e3a8a] text-white',
                      )}
                    >
                      {getInitials(peerName)}
                    </div>
                    <div
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2',
                        activeThread === peerId ? 'border-[#1e3a8a]' : 'border-white',
                        peerDotTone(state, presence),
                      )}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{peerName}</div>
                    <div className="relative">
                      <div
                        className={cn('truncate text-xs', activeThread === peerId ? 'text-white/70' : 'text-blue-500')}
                        onMouseEnter={() => schedulePeerPathTooltip(peerId, 'sidebar')}
                        onMouseLeave={clearPeerPathTooltip}
                        onFocus={() => schedulePeerPathTooltip(peerId, 'sidebar')}
                        onBlur={clearPeerPathTooltip}
                      >
                        {peerStateLabel(state)}
                      </div>
                      {peerPathTooltip?.peerId === peerId && peerPathTooltip.scope === 'sidebar'
                        ? renderPeerPathTooltip(peerId, 'left')
                        : null}
                    </div>
                    <div className={cn('truncate text-[11px]', activeThread === peerId ? 'text-white/60' : 'text-slate-400')}>
                      {metaLabel}
                    </div>
                  </div>
                  {unread ? (
                    <div className="min-w-[20px] shrink-0 rounded-full bg-green-500 px-2 py-0.5 text-center text-xs font-semibold text-white">
                      {unread}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        </aside>

        {isSidebarOpen ? (
          <div className="fixed inset-0 z-10 bg-black/20 md:hidden" onClick={() => setIsSidebarOpen(false)} />
        ) : null}

        <section className="flex min-w-0 flex-1 flex-col bg-white">
          <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-3 sm:px-4">
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2 h-9 w-9 md:hidden"
              onClick={() => setIsSidebarOpen((current) => !current)}
            >
              <Menu className="h-5 w-5" />
            </Button>

            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold">
                {activeThread === GLOBAL_THREAD ? 'Global Chat' : getPeerDisplayName(activeThread)}
              </h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowRoomPicker(true)}
                  className={cn(
                    HEADER_BADGE_CLASS,
                    'inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 pl-3 pr-2 text-slate-700 transition-all hover:border-slate-300 hover:bg-slate-100',
                  )}
                  title="切换房间"
                >
                  <span>{activeRoom}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                </button>
                <Badge className={cn(HEADER_BADGE_CLASS, 'md:hidden', socketStatusTone(socketStatus))}>
                  {socketStatusLabel(socketStatus)}
                </Badge>
                {activePeerId ? (
                  <>
                    <div
                      className="relative"
                      onMouseEnter={() => schedulePeerPathTooltip(activePeerId, 'header')}
                      onMouseLeave={clearPeerPathTooltip}
                      onFocus={() => schedulePeerPathTooltip(activePeerId, 'header')}
                      onBlur={clearPeerPathTooltip}
                    >
                      <Badge className={cn(HEADER_BADGE_CLASS, peerBadgeTone(activePeerStatus))}>
                        {peerStateLabel(activePeerStatus)}
                      </Badge>
                      {peerPathTooltip?.peerId === activePeerId && peerPathTooltip.scope === 'header'
                        ? renderPeerPathTooltip(activePeerId, 'center')
                        : null}
                    </div>
                    <Badge className={cn(HEADER_BADGE_CLASS, 'border-slate-200 bg-slate-50 text-slate-600')}>
                      {activeSignalLabel}
                    </Badge>
                  </>
                ) : null}
                {receiveDirectoryBadgeText ? (
                  <Badge
                    className={cn(
                      HEADER_BADGE_CLASS,
                      'max-w-[260px] gap-1.5 pl-3 pr-1',
                      receiveDirectory.status === 'ready'
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-orange-200 bg-orange-50 text-orange-700',
                    )}
                    title={receiveDirectoryBadgeText}
                  >
                    <span className="min-w-0 truncate">{receiveDirectoryBadgeText}</span>
                    <button
                      type="button"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-70 transition-all hover:bg-black/5 hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleClearDirectory();
                      }}
                      title="清除默认接收目录"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </Badge>
                ) : null}
                <div className="flex items-center gap-1">
                  <span className="text-xs text-slate-500">{nickname}</span>
                  <button
                    type="button"
                    className="rounded p-1 transition-colors hover:bg-blue-100"
                    onClick={() => setIsEditingNickname(true)}
                    title="设置昵称"
                  >
                    <Edit2 className="h-3 w-3 text-slate-500" />
                  </button>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button
                onClick={() => void handlePickDirectory()}
                size="sm"
                variant="secondary"
                className="h-9 rounded-2xl border border-slate-200 bg-white px-3 text-xs text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:bg-slate-50"
                disabled={!supportsDirectoryPicker()}
                title={supportsDirectoryPicker() ? '设置默认接收目录' : '当前环境不支持默认接收目录'}
              >
                <FolderOpen className="mr-1 h-3.5 w-3.5" />
                收件目录
              </Button>
              <Button
                onClick={openClearCurrentThreadDialog}
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                title="清空当前会话"
                disabled={isClearingThread}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <div className="relative">
                <Button
                  onClick={() => void handleCopyRoomLink()}
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  title="分享房间链接"
                >
                  <ShareRoomIcon className="h-4 w-4" />
                </Button>
                {shareFeedback ? (
                  <div className="pointer-events-none absolute left-1/2 top-[calc(100%+10px)] z-20 -translate-x-1/2 rounded-xl border border-slate-200 bg-white/95 px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-[0_18px_40px_rgba(15,23,42,0.12)] backdrop-blur-md">
                    <span
                      aria-hidden="true"
                      className="absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-l border-t border-slate-200 bg-white/95"
                    />
                    {shareFeedback}
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <MessageList
            activeRoom={activeRoom}
            activeThread={activeThread}
            globalThread={GLOBAL_THREAD}
            filteredMessages={filteredMessages}
            selfId={selfId}
            copiedMessageId={copiedMessageId}
            onPreviewImage={setPreviewImage}
            onCopyMessage={handleCopyMessage}
            getPeerDisplayName={getPeerDisplayName}
            getInitials={getInitials}
            formatClockTime={formatClockTime}
            summarizeMessageTransport={transportLabel}
            transportBadgeTone={transportBadgeTone}
            messagesViewportRef={messagesViewportRef}
          />

          <TransferPanel
            transferRows={transferRows}
            getRelayTaskState={relayUploads.getRelayTaskState}
            onPauseTransfer={handlePauseTransfer}
            onResumeTransfer={handleResumeTransfer}
            onCancelTransfer={handleCancelTransfer}
            transportBadgeTone={transportBadgeTone}
            transportLabel={transportLabel}
            formatTransferSpeed={formatTransferSpeed}
            formatTransferNote={formatTransferNote}
            transferStatusLabel={transferStatusLabel}
          />

          <ComposerPanel
            pendingFiles={pendingFiles}
            composer={composer}
            isComposing={isComposing}
            activePeerId={activePeerId}
            canToggleTransferMode={canToggleTransferMode}
            effectiveTransferMode={effectiveTransferMode}
            isSending={isSending}
            notice={notice}
            socketStatus={socketStatus}
            transferModeTooltip={transferModeTooltip}
            transferModeTooltipText={transferModeTooltipText}
            composerRef={composerRef}
            onRemovePendingFile={removePendingFile}
            onAppendPendingFiles={appendPendingFiles}
            onSetTransferMode={setTransferMode}
            onScheduleTransferModeTooltip={scheduleTransferModeTooltip}
            onClearTransferModeTooltip={clearTransferModeTooltip}
            onComposerChange={setComposer}
            onPaste={handlePaste}
            onKeyDown={handleComposerKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onSend={() => {
              void handleSend();
            }}
            getPeerDisplayName={getPeerDisplayName}
          />
        </section>
      </div>

      <ImagePreviewDialog previewImage={previewImage} onClose={() => setPreviewImage(null)} />

      <ClearThreadDialog
        open={isClearDialogOpen}
        isClearingThread={isClearingThread}
        activePeerId={activePeerId}
        activePeerName={activePeerId ? getPeerDisplayName(activePeerId) : ''}
        onClose={() => setIsClearDialogOpen(false)}
        onConfirm={() => {
          void handleConfirmClearCurrentThread();
        }}
      />

      <EditNicknameDialog
        open={isEditingNickname}
        nicknameDraft={nicknameDraft}
        onNicknameDraftChange={setNicknameDraft}
        onClose={() => setIsEditingNickname(false)}
        onSave={() => {
          void handleSaveNickname();
        }}
      />
    </div>
  );
}
