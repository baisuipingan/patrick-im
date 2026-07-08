import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import {
  Check,
  Copy,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  ImageIcon,
  Loader2,
  LogIn,
  Menu,
  MessageSquare,
  Paperclip,
  Pause,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  Share2,
  Trash2,
  Upload,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  AttachmentView,
  ConversationClearedPayload,
  ConversationView,
  Envelope,
  MemberUpdatedPayload,
  MessageAckPayload,
  MessageCreatedPayload,
  MessageView,
  Peer,
  RoomDetail,
  RoomMemberView,
  RoomSnapshotPayload,
  RoomUpdatedPayload,
  RoomSummary,
  ServerEvent,
  SessionResponse,
  SignalEnvelope,
  UnreadUpdatedPayload,
  WebRTCSignalPayload,
} from '@shared/protocol';
import { normalizeRoomId, roomFromHash } from './app-model';
import {
  createTextAttachmentFile,
  isTextWithinHardLimit,
  shouldSendTextAsAttachment,
} from './features/chat/send-actions';
import {
  clearReceiveDirectory,
  createWritableFile,
  ensureDirectoryWritable,
  loadReceiveDirectoryState,
  pickReceiveDirectory,
  type StoredDirectoryState,
} from './lib/file-system';
import { buildWsUrl, cn, formatBytes, formatClock } from './lib/utils';
import {
  DirectMesh,
  type DirectFileProgress,
  type DirectPeerSnapshot,
  type DirectState,
  type IncomingDirectFile,
  type IncomingDirectFileSink,
} from './webrtc';

type ConnectionState = 'idle' | 'connecting' | 'online' | 'offline' | 'error';
type NoticeTone = 'info' | 'success' | 'error';
type TransferStatus = 'queued' | 'uploading' | 'receiving' | 'paused' | 'done' | 'failed' | 'cancelled';
type TransferTransport = 'server' | 'p2p';
type TransferDirection = 'send' | 'receive';

interface Notice {
  tone: NoticeTone;
  text: string;
}

interface PendingAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

interface TransferRow {
  id: string;
  fileName: string;
  conversationId: string;
  peerId?: string;
  transport: TransferTransport;
  direction: TransferDirection;
  totalBytes: number;
  transferredBytes: number;
  status: TransferStatus;
  startedAt: number;
  updatedAt: number;
  error?: string;
  canPause?: boolean;
  canRetry?: boolean;
}

interface RetryableTransfer {
  file: File;
  conversationId: string;
  messageType?: 'txt_file';
}

type PendingWebRTCSignal = Envelope<WebRTCSignalPayload>;

interface SaveFilePicker {
  createWritable: () => Promise<FileSystemWritableFileStream>;
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveFilePicker>;
};

const NICKNAME_KEY = 'patrick-im:nickname';
const LAST_ROOM_KEY = 'patrick-im:last-room';
const RECENT_ROOMS_KEY = 'patrick-im:recent-rooms';
const DIRECT_CONNECT_WAIT_MS = 10000;
const TRANSFER_CANCELLED_MESSAGE = '已取消';
const MAX_PENDING_WEBRTC_SIGNALS = 200;

const EMPTY_RECEIVE_DIRECTORY: StoredDirectoryState = {
  handle: null,
  status: 'not-configured',
  name: '',
};

function readLocalStorage(key: string, fallback = ''): string {
  if (typeof window === 'undefined') {
    return fallback;
  }
  return window.localStorage.getItem(key) ?? fallback;
}

function recentRooms(): string[] {
  try {
    const raw = readLocalStorage(RECENT_ROOMS_KEY, '[]');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberRecentRoom(roomId: string): string[] {
  const next = [roomId, ...recentRooms().filter((item) => item !== roomId)].slice(0, 8);
  window.localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(next));
  window.localStorage.setItem(LAST_ROOM_KEY, roomId);
  return next;
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `请求失败：${response.status}`;
  } catch {
    return `请求失败：${response.status}`;
  }
}

function readXHRError(xhr: XMLHttpRequest): string {
  try {
    const payload = JSON.parse(xhr.responseText) as { error?: string };
    if (payload.error) {
      return payload.error;
    }
  } catch {
    // Fall through to a status based message.
  }
  if (xhr.status === 413) {
    return '文件超过服务端上传上限';
  }
  return xhr.status > 0 ? `上传失败：${xhr.status}` : '上传失败';
}

async function apiJSON<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as T;
}

function newLocalId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export default function App() {
  const initialRoom = normalizeRoomId(
    roomFromHash(readLocalStorage(LAST_ROOM_KEY, 'lobby')),
  );
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [roomInput, setRoomInput] = useState(initialRoom);
  const [activeRoom, setActiveRoom] = useState(initialRoom);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [recentRoomList, setRecentRoomList] = useState<string[]>(() => recentRooms());
  const [roomDetail, setRoomDetail] = useState<RoomDetail | null>(null);
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('');
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, MessageView[]>>({});
  const [composer, setComposer] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const [transfers, setTransfers] = useState<Record<string, TransferRow>>({});
  const [peers, setPeers] = useState<Peer[]>([]);
  const [directStates, setDirectStates] = useState<Record<string, DirectState>>({});
  const [directSnapshots, setDirectSnapshots] = useState<Record<string, DirectPeerSnapshot>>({});
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [notice, setNotice] = useState<Notice>({ tone: 'info', text: '准备就绪' });
  const [nicknameDraft, setNicknameDraft] = useState(() => readLocalStorage(NICKNAME_KEY));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [receiveDirectory, setReceiveDirectory] = useState<StoredDirectoryState>(EMPTY_RECEIVE_DIRECTORY);
  const [clearingConversationId, setClearingConversationId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const uploadXhrsRef = useRef<Record<string, XMLHttpRequest>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const directMeshRef = useRef<DirectMesh | null>(null);
  const pendingWebRTCSignalsRef = useRef<PendingWebRTCSignal[]>([]);
  const pausedTransfersRef = useRef<Record<string, boolean>>({});
  const transferAbortControllersRef = useRef<Record<string, AbortController>>({});
  const retryableTransfersRef = useRef<Record<string, RetryableTransfer>>({});
  const cancelledTransfersRef = useRef<Record<string, boolean>>({});
  const receiveDirectoryRef = useRef<StoredDirectoryState>(EMPTY_RECEIVE_DIRECTORY);
  const conversationsRef = useRef<ConversationView[]>([]);
  const transfersRef = useRef<Record<string, TransferRow>>({});
  const directStatesRef = useRef<Record<string, DirectState>>({});
  const sessionRef = useRef<SessionResponse | null>(null);
  const localMessagesRef = useRef<Record<string, MessageView[]>>({});
  const clearedConversationsRef = useRef<Record<string, number>>({});
  const activeConversationIdRef = useRef('');

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? conversations[0],
    [activeConversationId, conversations],
  );
  const activeMessages = activeConversation ? (messagesByConversation[activeConversation.id] ?? []) : [];
  const transferRows = useMemo(
    () => Object.values(transfers).sort((left, right) => right.updatedAt - left.updatedAt),
    [transfers],
  );

  useEffect(() => {
    activeConversationIdRef.current = activeConversation?.id ?? '';
  }, [activeConversation?.id]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  useEffect(() => {
    directStatesRef.current = directStates;
  }, [directStates]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    receiveDirectoryRef.current = receiveDirectory;
  }, [receiveDirectory]);

  useEffect(() => {
    let cancelled = false;
    void loadReceiveDirectoryState()
      .then((state) => {
        if (cancelled) {
          return;
        }
        receiveDirectoryRef.current = state;
        setReceiveDirectory(state);
      })
      .catch(() => {
        if (!cancelled) {
          setReceiveDirectory({ handle: null, status: 'unsupported', name: '' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiJSON<SessionResponse>('/api/session')
      .then(async (payload) => {
        if (cancelled) {
          return;
        }
        const storedNickname = readLocalStorage(NICKNAME_KEY);
        if (storedNickname && storedNickname !== payload.nickname) {
          const renamed = await apiJSON<SessionResponse>('/api/session', {
            method: 'PATCH',
            body: JSON.stringify({ nickname: storedNickname }),
          });
          if (!cancelled) {
            setSession(renamed);
            setNicknameDraft(renamed.nickname);
          }
          return;
        }
        setSession(payload);
        setNicknameDraft(payload.nickname);
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice({ tone: 'error', text: error instanceof Error ? error.message : '会话初始化失败' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      Object.values(uploadXhrsRef.current).forEach((xhr) => xhr.abort());
      Object.values(transferAbortControllersRef.current).forEach((controller) => controller.abort());
      directMeshRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const next = roomFromHash(activeRoom);
      void enterRoom(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [activeRoom, session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    void enterRoom(activeRoom);
    void refreshRooms();
  }, [session]);

  useEffect(() => {
    if (!session || !activeRoom) {
      return;
    }
    setConnectionState('connecting');
    const token = encodeURIComponent(session.sessionToken ?? '');
    const ws = new WebSocket(buildWsUrl(`/api/rooms/${encodeURIComponent(activeRoom)}/ws?token=${token}`), ['patrick-im']);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnectionState('online');
      flushPendingWebRTCSignals(ws);
    };
    ws.onerror = () => setConnectionState('error');
    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      setConnectionState('offline');
    };
    ws.onmessage = (event) => {
      handleSocketMessage(event.data);
    };
    return () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      pendingWebRTCSignalsRef.current = pendingWebRTCSignalsRef.current.filter((item) => item.room_id !== activeRoom);
      ws.close();
    };
  }, [activeRoom, session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const mesh = new DirectMesh({
      selfId: session.clientId,
      selfName: session.nickname,
      roomId: activeRoom,
      iceServers: session.iceServers,
      sendSignal: sendWebRTCSignal,
      onStateChange: (peerId, state) => {
        setDirectStates((current) => ({ ...current, [peerId]: state }));
      },
      onPeerSnapshot: (peerId, snapshot) => {
        setDirectSnapshots((current) => ({ ...current, [peerId]: snapshot }));
      },
      onIncomingFileStart: updateIncomingDirectProgress,
      onIncomingFileProgress: updateIncomingDirectProgress,
      onIncomingFileError: markIncomingDirectFileFailed,
      createIncomingFileSink: createIncomingDirectFileSink,
      onIncomingFile: (file) => {
        void acceptIncomingDirectFile(file);
      },
    });
    directMeshRef.current?.close();
    setDirectStates({});
    setDirectSnapshots({});
    directMeshRef.current = mesh;
    mesh.setPeers(peers);
    return () => {
      mesh.close();
      if (directMeshRef.current === mesh) {
        directMeshRef.current = null;
      }
    };
  }, [activeRoom, session?.clientId]);

  useEffect(() => {
    if (session) {
      directMeshRef.current?.setSelfName(session.nickname);
    }
  }, [session?.nickname]);

  useEffect(() => {
    directMeshRef.current?.setPeers(peers);
  }, [peers]);

  useEffect(() => {
    if (!activeConversation) {
      return;
    }
    void loadMessages(activeConversation.id);
    void markRead(activeConversation.id);
  }, [activeConversation?.id]);

  async function refreshRooms() {
    const payload = await apiJSON<{ rooms: RoomSummary[] }>('/api/rooms');
    setRooms(payload.rooms ?? []);
  }

  function applyRoomDetail(detail: RoomDetail) {
    const currentActiveID = activeConversationIdRef.current;
    const nextConversations = (detail.conversations ?? []).map((item) =>
      item.id === currentActiveID ? { ...item, unreadCount: 0 } : item,
    );
    setRoomDetail(detail);
    setConversations(nextConversations);
    setActiveConversationId((current) =>
      nextConversations.some((item) => item.id === current) ? current : (nextConversations[0]?.id ?? ''),
    );
  }

  async function enterRoom(rawRoom: string) {
    if (!session) {
      return;
    }
    const roomId = normalizeRoomId(rawRoom);
    setRoomInput(roomId);
    setActiveRoom(roomId);
    window.history.replaceState(null, '', `#${encodeURIComponent(roomId)}`);
    setRecentRoomList(rememberRecentRoom(roomId));
    try {
      const detail = await apiJSON<RoomDetail>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ roomId }),
      });
      applyRoomDetail(detail);
      await refreshRooms();
      setNotice({ tone: 'success', text: `已进入房间 ${roomId}` });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '进入房间失败' });
    }
  }

  async function refreshRoomDetail() {
    if (!session || !activeRoom) {
      return;
    }
    const detail = await apiJSON<RoomDetail>(`/api/rooms/${encodeURIComponent(activeRoom)}`);
    applyRoomDetail(detail);
    await refreshRooms();
  }

  async function loadMessages(conversationId: string) {
    const requestedAt = Date.now();
    const payload = await apiJSON<{ messages: MessageView[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    const clearedAt = clearedConversationsRef.current[conversationId] ?? 0;
    if (clearedAt > requestedAt) {
      return;
    }
    const messages = mergeMessages(payload.messages ?? [], localMessagesRef.current[conversationId] ?? []);
    setMessagesByConversation((current) => ({
      ...current,
      [conversationId]: messages,
    }));
  }

  async function markRead(conversationId: string) {
    try {
      const updated = await apiJSON<ConversationView>(`/api/conversations/${encodeURIComponent(conversationId)}/read`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setConversations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      await refreshRooms();
    } catch {
      // Read state is helpful but not worth interrupting the chat surface.
    }
  }

  async function saveNickname() {
    const nickname = nicknameDraft.trim();
    if (!nickname) {
      return;
    }
    try {
      const renamed = await apiJSON<SessionResponse>('/api/session', {
        method: 'PATCH',
        body: JSON.stringify({ nickname }),
      });
      window.localStorage.setItem(NICKNAME_KEY, renamed.nickname);
      setSession(renamed);
      setNotice({ tone: 'success', text: '昵称已保存' });
      await refreshRoomDetail();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '昵称保存失败' });
    }
  }

  function sendWebRTCSignal(targetId: string, signal: SignalEnvelope) {
    const envelope: Envelope<WebRTCSignalPayload> = {
      type: webRTCSignalType(signal),
      request_id: newLocalId('webrtc'),
      room_id: activeRoom,
      conversation_id: activeConversationIdRef.current || undefined,
      payload: { targetId, signal },
      created_at: Date.now(),
    };
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pendingWebRTCSignalsRef.current = [...pendingWebRTCSignalsRef.current, envelope].slice(-MAX_PENDING_WEBRTC_SIGNALS);
      return;
    }
    ws.send(JSON.stringify(envelope));
  }

  function flushPendingWebRTCSignals(ws = wsRef.current) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const pending = pendingWebRTCSignalsRef.current;
    if (pending.length === 0) {
      return;
    }
    pendingWebRTCSignalsRef.current = [];
    for (const envelope of pending) {
      if (envelope.room_id !== activeRoom) {
        continue;
      }
      ws.send(JSON.stringify(envelope));
    }
  }

  function updateIncomingDirectProgress(progress: DirectFileProgress) {
    const now = Date.now();
    setTransfers((current) => ({
      ...current,
      [progress.id]: {
        ...(current[progress.id] ?? {
          id: progress.id,
          conversationId: activeConversationIdRef.current,
          startedAt: now,
          transport: 'p2p',
          direction: 'receive',
        }),
        fileName: progress.fileName,
        peerId: progress.peerId,
        totalBytes: progress.size,
        transferredBytes: progress.transferredBytes,
        status: progress.error ? 'failed' : progress.transferredBytes >= progress.size ? 'done' : 'receiving',
        error: progress.error,
        updatedAt: now,
      },
    }));
  }

  function markIncomingDirectFileFailed(progress: DirectFileProgress) {
    updateIncomingDirectProgress({ ...progress, error: progress.error ?? '接收文件失败' });
    setNotice({ tone: 'error', text: `${progress.fileName} 接收失败` });
  }

  async function createIncomingDirectFileSink(file: IncomingDirectFile): Promise<IncomingDirectFileSink | null> {
    const directory = await ensureDirectoryWritable(receiveDirectoryRef.current);
    if (!directory) {
      return null;
    }
    const { fileHandle, writer } = await createWritableFile(directory, file.fileName);
    let closed = false;
    return {
      savedToDisk: true,
      async write(chunk) {
        await writer.write(chunk);
      },
      async close() {
        await writer.close();
        closed = true;
        if (file.contentType.toLowerCase().startsWith('image/')) {
          const storedFile = await fileHandle.getFile();
          return { url: URL.createObjectURL(storedFile) };
        }
        return {};
      },
      async abort() {
        if (!closed) {
          await writer.abort().catch(() => undefined);
          await directory.removeEntry(fileHandle.name).catch(() => undefined);
        }
      },
    };
  }

  async function acceptIncomingDirectFile(file: IncomingDirectFile) {
    try {
      const conversation = await resolveIncomingDirectConversation(file);
      const message = directFileMessage({
        id: file.id,
        roomId: file.roomId,
        conversationId: conversation.id,
        senderId: file.senderId,
        senderName: file.senderName,
        targetId: sessionRef.current?.clientId ?? file.targetId ?? null,
        fileName: file.fileName,
        size: file.size,
        contentType: file.contentType,
        url: file.url,
        createdAt: file.createdAt,
        savedToDisk: file.savedToDisk,
        type: file.messageType,
      });
      if (file.url) {
        objectUrlsRef.current.push(file.url);
      }
      upsertMessageView(message);
      setConversations((current) => {
        const next = upsertConversationAfterMessage(current, conversation, file.id, file.fileName, file.createdAt, activeConversationIdRef.current);
        conversationsRef.current = next;
        return next;
      });
      setTransfers((current) => ({
        ...current,
        [file.id]: {
          ...(current[file.id] ?? {
            id: file.id,
            conversationId: conversation.id,
            startedAt: file.createdAt,
            transport: 'p2p',
            direction: 'receive',
          }),
          fileName: file.fileName,
          peerId: file.senderId,
          conversationId: conversation.id,
          totalBytes: file.size,
          transferredBytes: file.size,
          status: 'done',
          error: undefined,
          updatedAt: Date.now(),
        },
      }));
      setNotice({
        tone: 'success',
        text: file.savedToDisk ? `${file.senderName} 发来文件，已保存：${file.fileName}` : `${file.senderName} 发来文件：${file.fileName}`,
      });
    } catch (error) {
      setTransfers((current) => ({
        ...current,
        [file.id]: {
          ...(current[file.id] ?? {
            id: file.id,
            conversationId: file.conversationId ?? activeConversationIdRef.current,
            startedAt: file.createdAt,
            transport: 'p2p',
            direction: 'receive',
          }),
          fileName: file.fileName,
          peerId: file.senderId,
          totalBytes: file.size,
          transferredBytes: file.size,
          status: 'failed',
          error: error instanceof Error ? error.message : '接收文件已完成，但写入聊天记录失败',
          updatedAt: Date.now(),
        },
      }));
      setNotice({ tone: 'error', text: `${file.fileName} 未写入聊天记录` });
    }
  }

  async function resolveIncomingDirectConversation(file: IncomingDirectFile): Promise<ConversationView> {
    const existingById = file.conversationId ? conversationsRef.current.find((item) => item.id === file.conversationId) : undefined;
    if (existingById) {
      return existingById;
    }
    const existingByPeer = conversationsRef.current.find((item) => item.peerUserId === file.senderId);
    if (existingByPeer) {
      return existingByPeer;
    }
    try {
      const conversation = await ensureDirectConversation(file.senderId);
      void refreshRoomDetail();
      return conversation;
    } catch (error) {
      const conversationId = file.conversationId || directConversationId(file.roomId, file.senderId, sessionRef.current?.clientId ?? file.targetId);
      if (!conversationId) {
        throw error;
      }
      const fallback: ConversationView = {
        id: conversationId,
        roomId: file.roomId,
        type: 'direct',
        title: file.senderName,
        peerUserId: file.senderId,
        lastMessageId: file.id,
        lastMessageText: file.fileName,
        lastMessageAt: file.createdAt,
        unreadCount: conversationId === activeConversationIdRef.current ? 0 : 1,
        updatedAt: file.createdAt,
      };
      setConversations((current) => {
        const next = current.some((item) => item.id === fallback.id) ? current : [fallback, ...current];
        conversationsRef.current = next;
        return next;
      });
      return fallback;
    }
  }

  async function ensureDirectConversation(peerUserId: string): Promise<ConversationView> {
    const existing = conversationsRef.current.find((item) => item.peerUserId === peerUserId);
    if (existing) {
      return existing;
    }
    const conversation = await apiJSON<ConversationView>(
      `/api/rooms/${encodeURIComponent(activeRoom)}/conversations/direct`,
      {
        method: 'POST',
        body: JSON.stringify({ peerUserId }),
      },
    );
    setConversations((current) => {
      const next = current.some((item) => item.id === conversation.id) ? current : [conversation, ...current];
      conversationsRef.current = next;
      return next;
    });
    return conversation;
  }

  async function openDirectConversation(peerUserId: string) {
    try {
      const conversation = await ensureDirectConversation(peerUserId);
      await refreshRoomDetail();
      setActiveConversationId(conversation.id);
      setNotice({ tone: 'success', text: `已打开与 ${conversation.title} 的私聊` });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '打开私聊失败' });
    }
  }

  async function sendMessage() {
    if (!activeConversation || !session) {
      return;
    }
    const text = composer.trim();
    const files = [...pendingFiles];
    if (!text && files.length === 0) {
      return;
    }
    if (text && !isTextWithinHardLimit(text)) {
      setNotice({ tone: 'error', text: '文本超过 1 MiB，请拆分后再发送' });
      return;
    }

    const textFile = text && shouldSendTextAsAttachment(text) ? createTextAttachmentFile(text) : null;
    const textToSend = textFile ? '' : text;
    const filesToSend: PendingAttachment[] = textFile
      ? [{ id: newLocalId('text-file'), file: textFile }, ...files]
      : files;

    try {
      if (textToSend) {
        const message = await apiJSON<MessageView>(
          `/api/conversations/${encodeURIComponent(activeConversation.id)}/messages`,
          {
            method: 'POST',
            body: JSON.stringify({
              clientMessageId: newLocalId('client-message'),
              type: 'text',
              text: textToSend,
            }),
          },
        );
        upsertMessageView(message);
      }
      for (const item of filesToSend) {
        const messageType = textFile && item.file === textFile ? 'txt_file' : undefined;
        await sendAttachment(activeConversation, item.file, messageType);
      }
      setComposer('');
      clearPendingFiles();
      await refreshRoomDetail();
      setNotice({ tone: 'success', text: '已发送' });
    } catch (error) {
      if (isCancelledTransferError(error)) {
        setNotice({ tone: 'info', text: TRANSFER_CANCELLED_MESSAGE });
        return;
      }
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '发送失败' });
    }
  }

  async function sendAttachment(conversation: ConversationView, file: File, messageType?: 'txt_file'): Promise<void> {
    const transferId = newLocalId('transfer');
    const startedAt = Date.now();
    cancelledTransfersRef.current[transferId] = false;
    retryableTransfersRef.current[transferId] = { file, conversationId: conversation.id, messageType };
    try {
      const sentDirect = await sendDirectAttachment(conversation, file, messageType, transferId, startedAt);
      if (!sentDirect) {
        if (isTransferCancelled(transferId)) {
          throw new Error(TRANSFER_CANCELLED_MESSAGE);
        }
        if (session && file.size > session.maxUploadBytes) {
          const error = `${file.name || '文件'} 超过服务端上传上限 ${formatBytes(session.maxUploadBytes)}，且 P2P 未完成`;
          setTransfers((current) => ({
            ...current,
            [transferId]: {
              ...(current[transferId] ?? {
                id: transferId,
                fileName: file.name || 'file',
                conversationId: conversation.id,
                direction: 'send',
                startedAt,
              }),
              transport: current[transferId]?.transport ?? 'server',
              totalBytes: file.size,
              transferredBytes: current[transferId]?.transferredBytes ?? 0,
              status: 'failed',
              error,
              updatedAt: Date.now(),
              canRetry: true,
            },
          }));
          throw new Error(error);
        }
        await uploadAttachment(conversation.id, file, messageType, transferId, startedAt);
      }
    } finally {
      delete cancelledTransfersRef.current[transferId];
    }
  }

  async function sendDirectAttachment(
    conversation: ConversationView,
    file: File,
    messageType?: 'txt_file',
    transferId = newLocalId('transfer'),
    startedAt = Date.now(),
  ): Promise<boolean> {
    const peerId = conversation.peerUserId;
    const mesh = directMeshRef.current;
    if (!peerId || !mesh || !session) {
      return false;
    }
    if (directStatesRef.current[peerId] !== 'direct') {
      if (directStatesRef.current[peerId] !== 'connecting') {
        return false;
      }
      const waitController = new AbortController();
      transferAbortControllersRef.current[transferId] = waitController;
      retryableTransfersRef.current[transferId] = { file, conversationId: conversation.id, messageType };
      setTransfers((current) => ({
        ...current,
        [transferId]: {
          id: transferId,
          fileName: file.name || 'file',
          conversationId: conversation.id,
          peerId,
          transport: 'p2p',
          direction: 'send',
          totalBytes: file.size,
          transferredBytes: 0,
          status: 'queued',
          startedAt,
          updatedAt: Date.now(),
          error: '等待直连建立',
          canRetry: true,
        },
      }));
      const connected = await waitForDirectPeer(peerId, DIRECT_CONNECT_WAIT_MS, waitController.signal);
      delete transferAbortControllersRef.current[transferId];
      if (waitController.signal.aborted || isTransferCancelled(transferId)) {
        throw new Error(TRANSFER_CANCELLED_MESSAGE);
      }
      if (!connected) {
        setTransfers((current) => ({
          ...current,
          [transferId]: {
            ...(current[transferId] ?? {
              id: transferId,
              fileName: file.name || 'file',
              conversationId: conversation.id,
              peerId,
              direction: 'send',
              totalBytes: file.size,
              transferredBytes: 0,
              startedAt,
            }),
            transport: 'server',
            status: 'queued',
            error: '直连未就绪，已改用服务端',
            updatedAt: Date.now(),
          },
        }));
        return false;
      }
    }
    const controller = new AbortController();
    transferAbortControllersRef.current[transferId] = controller;
    pausedTransfersRef.current[transferId] = false;
    retryableTransfersRef.current[transferId] = { file, conversationId: conversation.id, messageType };
    setTransfers((current) => ({
      ...current,
      [transferId]: {
        id: transferId,
        fileName: file.name || 'file',
        conversationId: conversation.id,
        peerId,
        transport: 'p2p',
        direction: 'send',
        totalBytes: file.size,
        transferredBytes: 0,
        status: 'uploading',
        startedAt,
        updatedAt: startedAt,
        canPause: true,
        canRetry: true,
      },
    }));
    try {
      const sent = await mesh.sendFile(peerId, file, {
        transferId,
        conversationId: conversation.id,
        messageType,
        signal: controller.signal,
        isPaused: () => pausedTransfersRef.current[transferId] === true,
        onProgress: (transferredBytes, totalBytes) => {
          setTransfers((current) => ({
            ...current,
            [transferId]: {
              ...current[transferId],
              transferredBytes,
              totalBytes,
              status: pausedTransfersRef.current[transferId] ? 'paused' : 'uploading',
              updatedAt: Date.now(),
            },
          }));
        },
      });
      if (!sent) {
        setTransfers((current) => ({
          ...current,
          [transferId]: {
            ...current[transferId],
            transport: 'server',
            transferredBytes: 0,
            status: 'queued',
            error: '直连不可用，已改用服务端',
            updatedAt: Date.now(),
          },
        }));
        delete transferAbortControllersRef.current[transferId];
        delete pausedTransfersRef.current[transferId];
        return false;
      }
      const url = URL.createObjectURL(file);
      objectUrlsRef.current.push(url);
      upsertMessageView(directFileMessage({
        id: transferId,
        roomId: conversation.roomId,
        conversationId: conversation.id,
        senderId: session.clientId,
        senderName: session.nickname,
        targetId: peerId,
        fileName: file.name || 'file',
        size: file.size,
        contentType: file.type || 'application/octet-stream',
        url,
        createdAt: startedAt,
        type: messageType,
      }));
      setTransfers((current) => ({
        ...current,
        [transferId]: {
          ...current[transferId],
          transferredBytes: file.size,
          status: 'done',
          updatedAt: Date.now(),
        },
      }));
      return true;
    } catch (error) {
      const aborted = controller.signal.aborted;
      setTransfers((current) => ({
        ...current,
        [transferId]: {
          ...current[transferId],
          transport: aborted ? current[transferId]?.transport : 'server',
          transferredBytes: aborted ? current[transferId]?.transferredBytes ?? 0 : 0,
          status: aborted ? 'cancelled' : 'queued',
          error: aborted ? '已取消' : '直连传输失败',
          updatedAt: Date.now(),
        },
      }));
      if (aborted) {
        throw new Error(TRANSFER_CANCELLED_MESSAGE);
      }
      return false;
    } finally {
      delete transferAbortControllersRef.current[transferId];
      delete pausedTransfersRef.current[transferId];
    }
  }

  function uploadAttachment(
    conversationId: string,
    file: File,
    messageType?: 'txt_file',
    transferId = newLocalId('transfer'),
    startedAt = Date.now(),
  ): Promise<MessageView> {
    retryableTransfersRef.current[transferId] = { file, conversationId, messageType };
    if (session && file.size > session.maxUploadBytes) {
      const error = `${file.name || '文件'} 超过服务端上传上限 ${formatBytes(session.maxUploadBytes)}`;
      setTransfers((current) => ({
        ...current,
        [transferId]: {
          ...(current[transferId] ?? { id: transferId, startedAt }),
          fileName: file.name || 'file',
          conversationId,
          transport: 'server',
          direction: 'send',
          totalBytes: file.size,
          transferredBytes: 0,
          status: 'failed',
          error,
          updatedAt: Date.now(),
          canRetry: true,
        },
      }));
      return Promise.reject(new Error(error));
    }
    setTransfers((current) => ({
      ...current,
      [transferId]: {
        ...(current[transferId] ?? { id: transferId, startedAt }),
        fileName: file.name || 'file',
        conversationId,
        transport: 'server',
        direction: 'send',
        totalBytes: file.size,
        transferredBytes: 0,
        status: 'queued',
        startedAt: current[transferId]?.startedAt ?? startedAt,
        updatedAt: startedAt,
        error: current[transferId]?.error,
        canRetry: true,
      },
    }));

    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      if (messageType) {
        form.append('messageType', messageType);
      }
      const xhr = new XMLHttpRequest();
      uploadXhrsRef.current[transferId] = xhr;
      xhr.upload.onprogress = (event) => {
        const loaded = event.lengthComputable ? Math.min(event.loaded, file.size) : 0;
        setTransfers((current) => ({
          ...current,
          [transferId]: {
            ...(current[transferId] ?? {
              id: transferId,
              fileName: file.name,
              conversationId,
              transport: 'server',
              direction: 'send',
              totalBytes: file.size,
              startedAt,
            }),
            transferredBytes: loaded,
            totalBytes: file.size,
            status: 'uploading',
            updatedAt: Date.now(),
          },
        }));
      };
      xhr.onload = () => {
        delete uploadXhrsRef.current[transferId];
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = readXHRError(xhr);
          setTransfers((current) => ({
            ...current,
            [transferId]: {
              ...current[transferId],
              status: 'failed',
              error,
              canRetry: true,
              updatedAt: Date.now(),
            },
          }));
          reject(new Error(error));
          return;
        }
        const message = JSON.parse(xhr.responseText) as MessageView;
        upsertMessageView(message);
        setTransfers((current) => ({
          ...current,
          [transferId]: {
            ...current[transferId],
            transferredBytes: file.size,
            totalBytes: file.size,
            status: 'done',
            canRetry: false,
            updatedAt: Date.now(),
          },
        }));
        resolve(message);
      };
      xhr.onerror = () => {
        delete uploadXhrsRef.current[transferId];
        setTransfers((current) => ({
          ...current,
          [transferId]: {
            ...current[transferId],
            status: 'failed',
            error: '网络异常',
            canRetry: true,
            updatedAt: Date.now(),
          },
        }));
        reject(new Error('上传失败'));
      };
      xhr.onabort = () => {
        delete uploadXhrsRef.current[transferId];
        setTransfers((current) => {
          if (!current[transferId]) {
            return current;
          }
          return {
            ...current,
            [transferId]: {
              ...current[transferId],
              status: 'cancelled',
              updatedAt: Date.now(),
            },
          };
        });
        reject(new Error('已取消'));
      };
      xhr.open('POST', `/api/conversations/${encodeURIComponent(conversationId)}/attachments`);
      xhr.send(form);
    });
  }

  function upsertMessageView(message: MessageView) {
    if (isLocalOnlyMessage(message)) {
      localMessagesRef.current = {
        ...localMessagesRef.current,
        [message.conversationId]: upsertMessageList(localMessagesRef.current[message.conversationId] ?? [], message),
      };
    }
    setMessagesByConversation((current) => {
      const list = current[message.conversationId] ?? [];
      const next = upsertMessageList(list, message);
      return { ...current, [message.conversationId]: next };
    });
  }

  function appendPendingFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    const next = files.map((file) => {
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (previewUrl) {
        objectUrlsRef.current.push(previewUrl);
      }
      return { id: newLocalId('pending'), file, previewUrl };
    });
    setPendingFiles((current) => [...current, ...next]);
    setNotice({ tone: 'info', text: `已添加 ${files.length} 个附件` });
  }

  function removePendingFile(id: string) {
    setPendingFiles((current) => current.filter((item) => item.id !== id));
  }

  function clearPendingFiles() {
    setPendingFiles([]);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
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

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const files = Array.from(event.dataTransfer.files);
    appendPendingFiles(files);
  }

  async function copyRoomLink() {
    const url = new URL(window.location.href);
    url.hash = encodeURIComponent(activeRoom);
    await navigator.clipboard.writeText(url.toString());
    setNotice({ tone: 'success', text: '房间链接已复制' });
  }

  async function copyMessage(message: MessageView) {
    try {
      if (message.text) {
        await navigator.clipboard.writeText(message.text);
      } else if (message.attachment?.previewable && typeof ClipboardItem !== 'undefined') {
        const response = await fetch(message.attachment.url);
        const blob = await response.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      } else if (message.attachment) {
        await navigator.clipboard.writeText(`${window.location.origin}${message.attachment.url}`);
      }
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId(null), 1600);
    } catch {
      setNotice({ tone: 'error', text: '复制失败，请检查浏览器权限' });
    }
  }

  async function saveAttachment(attachment: AttachmentView) {
    try {
      if (!attachment.url) {
        setNotice({ tone: 'success', text: '文件已在接收目录' });
        return;
      }
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error('下载失败');
      }
      const blob = await response.blob();
      await saveBlob(blob, attachment.fileName, attachment.contentType);
      setNotice({ tone: 'success', text: '文件已保存' });
    } catch (error) {
      if (isAbortError(error)) {
        setNotice({ tone: 'info', text: '已取消保存' });
        return;
      }
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '保存失败' });
    }
  }

  async function waitForDirectPeer(peerId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) {
        return false;
      }
      if (directStatesRef.current[peerId] === 'direct') {
        return true;
      }
      if (directStatesRef.current[peerId] === 'offline') {
        return false;
      }
      await delay(150);
    }
    return directStatesRef.current[peerId] === 'direct';
  }

  function cancelTransfer(id: string) {
    cancelledTransfersRef.current[id] = true;
    uploadXhrsRef.current[id]?.abort();
    transferAbortControllersRef.current[id]?.abort();
    setTransfers((current) => {
      const row = current[id];
      if (!row || row.status === 'done' || row.status === 'failed') {
        return current;
      }
      return {
        ...current,
        [id]: {
          ...row,
          status: 'cancelled',
          updatedAt: Date.now(),
        },
      };
    });
  }

  function isTransferCancelled(id: string): boolean {
    return cancelledTransfersRef.current[id] === true || transfersRef.current[id]?.status === 'cancelled';
  }

  function pauseTransfer(id: string) {
    if (!transferAbortControllersRef.current[id]) {
      return;
    }
    pausedTransfersRef.current[id] = true;
    setTransfers((current) => ({
      ...current,
      [id]: {
        ...current[id],
        status: 'paused',
        updatedAt: Date.now(),
      },
    }));
  }

  function resumeTransfer(id: string) {
    pausedTransfersRef.current[id] = false;
    setTransfers((current) => ({
      ...current,
      [id]: {
        ...current[id],
        status: 'uploading',
        updatedAt: Date.now(),
      },
    }));
  }

  async function retryTransfer(id: string) {
    const retryable = retryableTransfersRef.current[id];
    if (!retryable) {
      return;
    }
    const conversation = conversations.find((item) => item.id === retryable.conversationId);
    try {
      if (conversation) {
        await sendAttachment(conversation, retryable.file, retryable.messageType);
        return;
      }
      await uploadAttachment(retryable.conversationId, retryable.file, retryable.messageType);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '重试失败' });
    }
  }

  async function clearActiveConversation() {
    if (!activeConversation) {
      return;
    }
    const confirmed = window.confirm(`删除「${activeConversation.title}」及其中所有文字和文件？`);
    if (!confirmed) {
      return;
    }
    const conversationId = activeConversation.id;
    setClearingConversationId(conversationId);
    try {
      const response = await apiJSON<{ conversationId: string; removed: number; deleted: boolean }>(
        `/api/conversations/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' },
      );
      deleteConversationLocally(response.conversationId || conversationId, response.deleted);
      if (!response.deleted) {
        await loadMessages(response.conversationId || conversationId);
      }
      await refreshRoomDetail();
      await refreshRooms();
      setNotice({ tone: 'success', text: response.deleted ? '会话已删除' : `已删除 ${response.removed} 条消息` });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '删除失败' });
    } finally {
      setClearingConversationId((current) => (current === conversationId ? null : current));
    }
  }

  function clearConversationLocally(conversationId: string) {
    deleteConversationLocally(conversationId, false);
  }

  function deleteConversationLocally(conversationId: string, deleted: boolean) {
    clearedConversationsRef.current[conversationId] = Date.now();
    for (const [id, row] of Object.entries(transfersRef.current)) {
      if (row.conversationId !== conversationId) {
        continue;
      }
      uploadXhrsRef.current[id]?.abort();
      transferAbortControllersRef.current[id]?.abort();
      delete uploadXhrsRef.current[id];
      delete transferAbortControllersRef.current[id];
      delete pausedTransfersRef.current[id];
      delete retryableTransfersRef.current[id];
    }
    setMessagesByConversation((current) => {
      const nextLocalMessages = { ...localMessagesRef.current };
      if (!deleted) {
        nextLocalMessages[conversationId] = [];
        localMessagesRef.current = nextLocalMessages;
        return { ...current, [conversationId]: [] };
      }
      delete nextLocalMessages[conversationId];
      localMessagesRef.current = nextLocalMessages;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    const nextTransfers = Object.fromEntries(
      Object.entries(transfersRef.current).filter(([, row]) => row.conversationId !== conversationId),
    );
    transfersRef.current = nextTransfers;
    setTransfers(nextTransfers);

    const nextConversations = deleted
      ? conversationsRef.current.filter((item) => item.id !== conversationId)
      : conversationsRef.current.map((item) =>
          item.id === conversationId
            ? { ...item, lastMessageId: undefined, lastMessageText: undefined, lastMessageAt: 0, unreadCount: 0 }
            : item,
        );
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (deleted && activeConversationIdRef.current === conversationId) {
      const nextActive = nextConversations[0]?.id ?? '';
      activeConversationIdRef.current = nextActive;
      setActiveConversationId(nextActive);
    }
  }

  async function chooseReceiveDirectory() {
    try {
      const state = await pickReceiveDirectory();
      receiveDirectoryRef.current = state;
      setReceiveDirectory(state);
      setNotice({
        tone: state.status === 'ready' ? 'success' : 'info',
        text: state.status === 'ready' ? `接收目录已设置：${state.name}` : '接收目录需要浏览器授权',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      setNotice({ tone: 'error', text: '接收目录设置失败' });
    }
  }

  async function removeReceiveDirectory() {
    try {
      await clearReceiveDirectory();
      receiveDirectoryRef.current = EMPTY_RECEIVE_DIRECTORY;
      setReceiveDirectory(EMPTY_RECEIVE_DIRECTORY);
      setNotice({ tone: 'success', text: '已清除接收目录' });
    } catch {
      setNotice({ tone: 'error', text: '清除接收目录失败' });
    }
  }

  function switchConversation(conversationId: string) {
    setActiveConversationId(conversationId);
    activeConversationIdRef.current = conversationId;
    setConversations((current) =>
      current.map((item) => (item.id === conversationId ? { ...item, unreadCount: 0 } : item)),
    );
    void markRead(conversationId);
    setSidebarOpen(false);
  }

  function handleSocketMessage(data: unknown) {
    let payload: { type?: string };
    try {
      payload = JSON.parse(String(data)) as { type?: string };
    } catch {
      return;
    }
    if (handleEnvelopeMessage(payload)) {
      return;
    }
    const legacy = payload as ServerEvent;
    if (legacy.type === 'presence') {
      setPeers(legacy.peers ?? []);
      void refreshRoomDetail();
      return;
    }
    if (legacy.type === 'signal' && legacy.fromId && legacy.payload) {
      void directMeshRef.current?.handleSignal(legacy.fromId, legacy.payload);
      return;
    }
    if (legacy.type === 'message' && legacy.message) {
      void refreshRoomDetail();
      if (activeConversationIdRef.current) {
        void loadMessages(activeConversationIdRef.current);
      }
    }
  }

  function handleEnvelopeMessage(payload: { type?: string }): boolean {
    switch (payload.type) {
      case 'room_snapshot': {
        const envelope = payload as Envelope<RoomSnapshotPayload>;
        if (envelope.payload?.room) {
          applyRoomDetail(envelope.payload.room);
        }
        setPeers(envelope.payload?.peers ?? []);
        return true;
      }
      case 'member_updated': {
        const envelope = payload as Envelope<MemberUpdatedPayload>;
        setPeers(envelope.payload?.peers ?? []);
        void refreshRoomDetail();
        return true;
      }
      case 'room_updated': {
        const envelope = payload as Envelope<RoomUpdatedPayload>;
        if (envelope.payload?.room) {
          applyRoomDetail(envelope.payload.room);
        }
        void refreshRooms();
        return true;
      }
      case 'message_created': {
        const envelope = payload as Envelope<MessageCreatedPayload>;
        if (envelope.payload?.message) {
          upsertMessageView(envelope.payload.message);
          void refreshRoomDetail();
          if (envelope.payload.message.conversationId === activeConversationIdRef.current) {
            void markRead(envelope.payload.message.conversationId);
          }
        }
        return true;
      }
      case 'message_ack': {
        const envelope = payload as Envelope<MessageAckPayload>;
        if (envelope.error) {
          setNotice({ tone: 'error', text: envelope.error.message });
        } else if (envelope.payload?.message) {
          upsertMessageView(envelope.payload.message);
        }
        return true;
      }
      case 'unread_updated': {
        const envelope = payload as Envelope<UnreadUpdatedPayload>;
        if (envelope.payload?.conversation) {
          setConversations((current) =>
            current.map((item) => (item.id === envelope.payload?.conversation.id ? envelope.payload.conversation : item)),
          );
        }
        void refreshRooms();
        return true;
      }
      case 'conversation_cleared': {
        const envelope = payload as Envelope<ConversationClearedPayload>;
        if (envelope.payload?.conversationId) {
          deleteConversationLocally(envelope.payload.conversationId, envelope.payload.deleted);
          void refreshRoomDetail();
          void refreshRooms();
        }
        return true;
      }
      case 'webrtc_offer':
      case 'webrtc_answer':
      case 'webrtc_ice': {
        const envelope = payload as Envelope<WebRTCSignalPayload>;
        if (envelope.payload?.fromId && envelope.payload.signal) {
          void directMeshRef.current?.handleSignal(envelope.payload.fromId, envelope.payload.signal);
        }
        return true;
      }
      case 'transfer_updated':
        return true;
      default:
        return false;
    }
  }

  function submitRoom(event: FormEvent) {
    event.preventDefault();
    void enterRoom(roomInput);
  }

  return (
    <div
      className={cn('app-shell-v2', isDragging && 'is-dragging')}
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setIsDragging(false);
        }
      }}
      onDrop={handleDrop}
    >
      <Sidebar
        activeConversationId={activeConversation?.id ?? ''}
        activeRoom={activeRoom}
        connectionState={connectionState}
        conversations={conversations}
        onClose={() => setSidebarOpen(false)}
        onCopyRoomLink={() => void copyRoomLink()}
        onEnterRoom={submitRoom}
        onOpenSettings={() => setSettingsOpen(true)}
        onRoomInputChange={setRoomInput}
        onSelectConversation={switchConversation}
        recentRooms={recentRoomList}
        roomInput={roomInput}
        rooms={rooms}
        sidebarOpen={sidebarOpen}
      />

      <main className="chat-workbench">
        <ChatHeader
          activeConversation={activeConversation}
          activeRoom={activeRoom}
          connectionState={connectionState}
          nicknameDraft={nicknameDraft}
          onMenu={() => setSidebarOpen(true)}
          onClearConversation={() => void clearActiveConversation()}
          isClearingConversation={clearingConversationId === activeConversation?.id}
          onNicknameChange={setNicknameDraft}
          onRefresh={() => void refreshRoomDetail()}
          onSaveNickname={() => void saveNickname()}
        />

        <MessageTimeline
          messages={activeMessages}
          selfId={session?.clientId ?? ''}
          copiedMessageId={copiedMessageId}
          onCopyMessage={(message) => void copyMessage(message)}
          onSaveAttachment={(attachment) => void saveAttachment(attachment)}
        />

        <Composer
          composer={composer}
          composerRef={composerRef}
          fileInputRef={fileInputRef}
          pendingFiles={pendingFiles}
          onAttachFiles={appendPendingFiles}
          onComposerChange={setComposer}
          onPaste={handlePaste}
          onRemovePendingFile={removePendingFile}
          onSend={() => void sendMessage()}
        />

        <div className={cn('notice', notice.tone)}>{notice.text}</div>
      </main>

      <aside className="details-panel">
        <RoomDetails
          room={roomDetail}
          selfId={session?.clientId ?? ''}
          directStates={directStates}
          directSnapshots={directSnapshots}
          onOpenDirect={(peerId) => void openDirectConversation(peerId)}
        />
        <TransferPanel
          rows={transferRows}
          onCancel={cancelTransfer}
          onPause={pauseTransfer}
          onResume={resumeTransfer}
          onRetry={(id) => void retryTransfer(id)}
        />
      </aside>

      {isDragging ? (
        <div className="drop-overlay">
          <Upload size={32} />
          <span>松开发送文件</span>
        </div>
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          activeRoom={activeRoom}
          receiveDirectory={receiveDirectory}
          onChooseReceiveDirectory={() => void chooseReceiveDirectory()}
          onClearReceiveDirectory={() => void removeReceiveDirectory()}
          onClose={() => setSettingsOpen(false)}
          onCopyRoomLink={() => void copyRoomLink()}
        />
      ) : null}
    </div>
  );
}

function Sidebar(props: {
  activeConversationId: string;
  activeRoom: string;
  connectionState: ConnectionState;
  conversations: ConversationView[];
  onClose: () => void;
  onCopyRoomLink: () => void;
  onEnterRoom: (event: FormEvent) => void;
  onOpenSettings: () => void;
  onRoomInputChange: (value: string) => void;
  onSelectConversation: (conversationId: string) => void;
  recentRooms: string[];
  roomInput: string;
  rooms: RoomSummary[];
  sidebarOpen: boolean;
}) {
  return (
    <aside className={cn('workspace-sidebar', props.sidebarOpen && 'open')}>
      <div className="brand-strip">
        <div className="brand-mark">P</div>
        <div className="brand-copy">
          <strong>Patrick IM</strong>
          <span>{connectionLabel(props.connectionState)}</span>
        </div>
        <button className="icon-button mobile-only" onClick={props.onClose} aria-label="关闭侧栏">
          <X size={18} />
        </button>
      </div>

      <form className="room-switcher" onSubmit={props.onEnterRoom}>
        <input value={props.roomInput} onChange={(event) => props.onRoomInputChange(event.target.value)} />
        <button className="icon-button" type="submit" aria-label="进入房间">
          <LogIn size={17} />
        </button>
        <button className="icon-button" type="button" onClick={props.onCopyRoomLink} aria-label="复制房间链接">
          <Share2 size={17} />
        </button>
      </form>

      {props.recentRooms.length > 0 ? (
        <div className="recent-rooms">
          {props.recentRooms.map((room) => (
            <button key={room} onClick={() => props.onRoomInputChange(room)} className={cn(room === props.activeRoom && 'active')}>
              #{room}
            </button>
          ))}
        </div>
      ) : null}

      <section className="sidebar-section">
        <div className="section-title">
          <MessageSquare size={14} />
          会话
        </div>
        <div className="conversation-list">
          {props.conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={cn('conversation-item', conversation.id === props.activeConversationId && 'active')}
              onClick={() => props.onSelectConversation(conversation.id)}
            >
              <span className="conversation-icon">{conversation.type === 'room' ? <Users size={16} /> : <MessageSquare size={16} />}</span>
              <span className="conversation-main">
                <strong>{conversation.title}</strong>
                <small>{conversation.lastMessageText || '暂无消息'}</small>
              </span>
              {conversation.unreadCount > 0 ? <span className="unread-badge">{conversation.unreadCount}</span> : null}
            </button>
          ))}
        </div>
      </section>

      <section className="sidebar-section compact">
        <div className="section-title settings-title">
          <span>房间</span>
          <button className="settings-launch" type="button" onClick={props.onOpenSettings} aria-label="打开房间设置">
            <Settings size={18} />
          </button>
        </div>
        {props.rooms.map((room) => (
          <div className="room-summary" key={room.id}>
            <span>#{room.id}</span>
            {room.unreadCount > 0 ? <strong>{room.unreadCount}</strong> : null}
          </div>
        ))}
      </section>
    </aside>
  );
}

function SettingsDialog(props: {
  activeRoom: string;
  receiveDirectory: StoredDirectoryState;
  onChooseReceiveDirectory: () => void;
  onClearReceiveDirectory: () => void;
  onClose: () => void;
  onCopyRoomLink: () => void;
}) {
  const directoryReady = props.receiveDirectory.status === 'ready';
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-dialog-header">
          <div>
            <strong>房间设置</strong>
            <span>#{props.activeRoom}</span>
          </div>
          <button className="icon-button" onClick={props.onClose} aria-label="关闭设置">
            <X size={17} />
          </button>
        </header>

        <div className="settings-row">
          <div className="settings-row-main">
            <Share2 size={17} />
            <span>
              <strong>房间链接</strong>
              <small>#{props.activeRoom}</small>
            </span>
          </div>
          <button className="settings-action" onClick={props.onCopyRoomLink}>
            <Copy size={14} />
            复制
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-row-main">
            <HardDrive size={17} />
            <span>
              <strong>P2P 接收目录</strong>
              <small>{receiveDirectoryLabel(props.receiveDirectory)}</small>
            </span>
          </div>
          <div className="settings-actions">
            <button className="settings-action" onClick={props.onChooseReceiveDirectory}>
              <FolderOpen size={14} />
              {directoryReady ? '更换' : '选择'}
            </button>
            <button className="settings-action subtle" onClick={props.onClearReceiveDirectory} disabled={!props.receiveDirectory.handle}>
              <Trash2 size={14} />
              清除
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ChatHeader(props: {
  activeConversation?: ConversationView;
  activeRoom: string;
  connectionState: ConnectionState;
  isClearingConversation: boolean;
  nicknameDraft: string;
  onMenu: () => void;
  onClearConversation: () => void;
  onNicknameChange: (value: string) => void;
  onRefresh: () => void;
  onSaveNickname: () => void;
}) {
  return (
    <header className="chat-header">
      <button className="icon-button mobile-only" onClick={props.onMenu} aria-label="打开侧栏">
        <Menu size={19} />
      </button>
      <div className="chat-title">
        <h1>{props.activeConversation?.title ?? '房间聊天'}</h1>
        <div className="chat-meta">
          <span>#{props.activeRoom}</span>
          <span className={cn('status-chip', props.connectionState)}>
            {props.connectionState === 'online' ? <Wifi size={13} /> : <WifiOff size={13} />}
            {connectionLabel(props.connectionState)}
          </span>
        </div>
      </div>
      <div className="header-actions">
        <button className="icon-button" onClick={props.onRefresh} aria-label="刷新">
          <RefreshCw size={17} />
        </button>
        <button
          className="icon-button"
          onClick={props.onClearConversation}
          disabled={props.isClearingConversation}
          aria-label="删除当前会话"
        >
          {props.isClearingConversation ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
        </button>
        <input
          value={props.nicknameDraft}
          onChange={(event) => props.onNicknameChange(event.target.value)}
          aria-label="昵称"
        />
        <button className="icon-button" onClick={props.onSaveNickname} aria-label="保存昵称">
          <Check size={17} />
        </button>
      </div>
    </header>
  );
}

function MessageTimeline(props: {
  messages: MessageView[];
  selfId: string;
  copiedMessageId: string | null;
  onCopyMessage: (message: MessageView) => void;
  onSaveAttachment: (attachment: AttachmentView) => void;
}) {
  if (props.messages.length === 0) {
    return (
      <section className="message-timeline">
        <div className="empty-state">
          <MessageSquare size={34} />
          <span>还没有消息</span>
        </div>
      </section>
    );
  }
  return (
    <section className="message-timeline">
      {props.messages.map((message) => (
        <article key={message.id} className={cn('message-row', message.senderId === props.selfId && 'mine')}>
          <div className="message-bubble">
            <div className="message-meta">
              <strong>{message.senderName}</strong>
              <span>{formatClock(message.createdAt)}</span>
            </div>
            {message.text ? <p>{message.text}</p> : null}
            {message.attachment ? (
              <AttachmentMessage attachment={message.attachment} onSave={() => props.onSaveAttachment(message.attachment!)} />
            ) : null}
            <div className="message-actions">
              <button onClick={() => props.onCopyMessage(message)}>
                {props.copiedMessageId === message.id ? <Check size={14} /> : <Copy size={14} />}
                {props.copiedMessageId === message.id ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}

function AttachmentMessage({ attachment, onSave }: { attachment: AttachmentView; onSave: () => void }) {
  const savedToDisk = attachment.storageKind === 'p2p_disk';
  const hasUrl = Boolean(attachment.url);
  if (attachment.previewable && hasUrl) {
    return (
      <div className="attachment-card image">
        <a className="image-message" href={attachment.url} target="_blank" rel="noreferrer">
          <img src={attachment.url} alt={attachment.fileName} />
          <span>
            <ImageIcon size={14} />
            {attachment.fileName}
          </span>
        </a>
        <button onClick={onSave} disabled={savedToDisk} aria-label={savedToDisk ? '图片已保存' : '保存图片'}>
          {savedToDisk ? <Check size={14} /> : <Download size={14} />}
          {savedToDisk ? '已保存' : '保存'}
        </button>
      </div>
    );
  }
  const content = (
    <>
      <FileText size={20} />
      <span>
        <strong>{attachment.fileName}</strong>
        <small>{savedToDisk ? `已保存 · ${formatBytes(attachment.size)}` : formatBytes(attachment.size)}</small>
      </span>
    </>
  );
  return (
    <div className="attachment-card file">
      {hasUrl ? (
        <a className="file-message-v2" href={attachment.url} target="_blank" rel="noreferrer">
          {content}
        </a>
      ) : (
        <div className="file-message-v2 saved">{content}</div>
      )}
      <button onClick={onSave} disabled={savedToDisk && !hasUrl} aria-label={savedToDisk ? '文件已保存' : '保存文件'}>
        {savedToDisk ? <Check size={14} /> : <Download size={14} />}
        {savedToDisk ? '已保存' : '保存'}
      </button>
    </div>
  );
}

function Composer(props: {
  composer: string;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  pendingFiles: PendingAttachment[];
  onAttachFiles: (files: File[]) => void;
  onComposerChange: (value: string) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemovePendingFile: (id: string) => void;
  onSend: () => void;
}) {
  return (
    <footer className="composer-v2">
      <input
        ref={props.fileInputRef}
        type="file"
        hidden
        multiple
        onChange={(event) => props.onAttachFiles(Array.from(event.target.files ?? []))}
      />
      {props.pendingFiles.length > 0 ? (
        <div className="pending-attachments">
          {props.pendingFiles.map((item) => (
            <div className="pending-attachment" key={item.id}>
              {item.previewUrl ? <img src={item.previewUrl} alt="" /> : <FileText size={16} />}
              <span>{item.file.name || 'file'}</span>
              <small>{formatBytes(item.file.size)}</small>
              <button onClick={() => props.onRemovePendingFile(item.id)} aria-label="移除附件">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="composer-row">
        <button className="icon-button" onClick={() => props.fileInputRef.current?.click()} aria-label="选择文件">
          <Paperclip size={19} />
        </button>
        <textarea
          ref={props.composerRef}
          value={props.composer}
          onChange={(event) => props.onComposerChange(event.target.value)}
          onPaste={props.onPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              props.onSend();
            }
          }}
          placeholder="输入消息，粘贴图片或拖拽文件..."
        />
        <button className="send-button" onClick={props.onSend}>
          <Send size={18} />
          发送
        </button>
      </div>
    </footer>
  );
}

function RoomDetails({
  room,
  selfId,
  directStates,
  directSnapshots,
  onOpenDirect,
}: {
  room: RoomDetail | null;
  selfId: string;
  directStates: Record<string, DirectState>;
  directSnapshots: Record<string, DirectPeerSnapshot>;
  onOpenDirect: (peerId: string) => void;
}) {
  const members = room?.members ?? [];
  return (
    <section className="details-section">
      <div className="panel-heading">
        <Users size={15} />
        <strong>成员</strong>
        <span>{members.length}</span>
      </div>
      <div className="member-list">
        {members.map((member) => (
          <MemberRow
            key={member.userId}
            member={member}
            selfId={selfId}
            directState={directStates[member.userId]}
            directSnapshot={directSnapshots[member.userId]}
            onOpenDirect={onOpenDirect}
          />
        ))}
      </div>
    </section>
  );
}

function MemberRow({
  member,
  selfId,
  directState,
  directSnapshot,
  onOpenDirect,
}: {
  member: RoomMemberView;
  selfId: string;
  directState?: DirectState;
  directSnapshot?: DirectPeerSnapshot;
  onOpenDirect: (peerId: string) => void;
}) {
  const isSelf = member.userId === selfId;
  return (
    <div className="member-row">
      <span className={cn('presence-dot', member.online && 'online')} />
      <span>
        <strong>{member.nickname}</strong>
        <small>
          {member.online ? '在线' : `最后活跃 ${formatClock(member.lastSeenAt)}`}
          {directState ? ` · ${directStateLabel(directState)}` : ''}
          {directSnapshot ? ` · ${directSnapshotLabel(directSnapshot)}` : ''}
        </small>
      </span>
      {!isSelf ? (
        <button className="member-action" onClick={() => onOpenDirect(member.userId)} aria-label={`和 ${member.nickname} 私聊`}>
          <MessageSquare size={13} />
        </button>
      ) : null}
    </div>
  );
}

function TransferPanel({
  rows,
  onCancel,
  onPause,
  onResume,
  onRetry,
}: {
  rows: TransferRow[];
  onCancel: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <section className="details-section">
      <div className="panel-heading">
        <Upload size={15} />
        <strong>传输</strong>
        <span>{rows.length}</span>
      </div>
      <div className="transfer-list">
        {rows.length === 0 ? <div className="panel-empty">暂无传输</div> : null}
        {rows.map((row) => {
          const progress = row.totalBytes > 0 ? Math.round((row.transferredBytes / row.totalBytes) * 100) : 0;
          const speed = transferSpeed(row);
          const eta = transferETA(row, speed);
          return (
            <div className="transfer-row" key={row.id}>
              <div className="transfer-title">
                <strong>{row.fileName}</strong>
                <span>{row.transport === 'p2p' ? 'P2P' : '服务端'} · {transferLabel(row.status)}</span>
              </div>
              <div className="progress-track">
                <div style={{ width: `${Math.min(100, progress)}%` }} />
              </div>
              <div className="transfer-meta">
                <span>
                  {formatBytes(row.transferredBytes)} / {formatBytes(row.totalBytes)}
                </span>
                <span>{speed > 0 ? `${formatBytes(speed)}/s${eta ? ` · 剩余 ${eta}` : ''}` : row.direction === 'receive' ? '接收中' : '等待传输'}</span>
              </div>
              {row.error ? <div className={cn('transfer-note', row.status === 'failed' ? 'error' : '')}>{row.error}</div> : null}
              <div className="transfer-actions">
                {row.status === 'uploading' && row.canPause ? (
                  <button onClick={() => onPause(row.id)}>
                    <Pause size={13} />
                    暂停
                  </button>
                ) : null}
                {row.status === 'paused' ? (
                  <button onClick={() => onResume(row.id)}>
                    <Upload size={13} />
                    继续
                  </button>
                ) : null}
                {row.status === 'uploading' || row.status === 'queued' || row.status === 'paused' ? (
                  <button onClick={() => onCancel(row.id)}>
                    <Trash2 size={13} />
                    取消
                  </button>
                ) : row.status === 'failed' ? (
                  <button disabled={!row.canRetry} onClick={() => onRetry(row.id)}>
                    <RotateCcw size={13} />
                    重试
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function webRTCSignalType(signal: SignalEnvelope): 'webrtc_offer' | 'webrtc_answer' | 'webrtc_ice' {
  if (signal.candidate) {
    return 'webrtc_ice';
  }
  return signal.description?.type === 'answer' ? 'webrtc_answer' : 'webrtc_offer';
}

function directFileMessage(input: {
  id: string;
  roomId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  targetId: string | null;
  fileName: string;
  size: number;
  contentType: string;
  url?: string;
  createdAt: number;
  savedToDisk?: boolean;
  type?: 'txt_file';
}): MessageView {
  const previewable = input.contentType.toLowerCase().startsWith('image/');
  return {
    id: input.id,
    roomId: input.roomId,
    conversationId: input.conversationId,
    type: input.type ?? (previewable ? 'image' : 'file'),
    senderId: input.senderId,
    senderName: input.senderName,
    targetId: input.targetId,
    status: 'sent',
    createdAt: input.createdAt,
    attachment: {
      id: input.id,
      messageId: input.id,
      fileName: input.fileName,
      size: input.size,
      contentType: input.contentType,
      url: input.url ?? '',
      previewable,
      storageKind: input.savedToDisk ? 'p2p_disk' : 'p2p',
      createdAt: input.createdAt,
    },
  };
}

function upsertConversationAfterMessage(
  conversations: ConversationView[],
  conversation: ConversationView,
  messageId: string,
  text: string,
  createdAt: number,
  activeConversationId: string,
): ConversationView[] {
  const nextConversation: ConversationView = {
    ...conversation,
    lastMessageId: messageId,
    lastMessageText: text,
    lastMessageAt: createdAt,
    unreadCount: conversation.id === activeConversationId ? 0 : Math.max(1, conversation.unreadCount || 0),
    updatedAt: createdAt,
  };
  const exists = conversations.some((item) => item.id === conversation.id);
  const next = exists
    ? conversations.map((item) => (item.id === conversation.id ? { ...item, ...nextConversation } : item))
    : [nextConversation, ...conversations];
  return next.sort((left, right) => right.updatedAt - left.updatedAt);
}

function isLocalOnlyMessage(message: MessageView): boolean {
  const storageKind = message.attachment?.storageKind ?? '';
  return storageKind === 'p2p' || storageKind === 'p2p_disk';
}

function mergeMessages(serverMessages: MessageView[], localMessages: MessageView[]): MessageView[] {
  const merged = new Map<string, MessageView>();
  for (const message of serverMessages) {
    merged.set(message.id, message);
  }
  for (const message of localMessages) {
    merged.set(message.id, message);
  }
  return sortMessages([...merged.values()]);
}

function upsertMessageList(messages: MessageView[], message: MessageView): MessageView[] {
  const exists = messages.some((item) => item.id === message.id);
  const next = exists ? messages.map((item) => (item.id === message.id ? message : item)) : [...messages, message];
  return sortMessages(next);
}

function sortMessages(messages: MessageView[]): MessageView[] {
  return [...messages].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function directConversationId(roomId: string, left: string, right: string): string {
  return `direct:${roomId}:${[left, right].map((item) => item.trim()).sort().join(':')}`;
}

function receiveDirectoryLabel(state: StoredDirectoryState): string {
  switch (state.status) {
    case 'ready':
      return state.name || '已设置';
    case 'needs-permission':
      return state.name ? `${state.name} · 需要授权` : '需要授权';
    case 'unsupported':
      return '当前浏览器不支持';
    case 'not-configured':
    default:
      return '未设置';
  }
}

async function saveBlob(blob: Blob, fileName: string, contentType: string): Promise<void> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    const handle = await picker({
      suggestedName: fileName,
      types: [
        {
          description: contentType || 'application/octet-stream',
          accept: { [contentType || 'application/octet-stream']: [extensionFor(fileName)] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noreferrer';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isCancelledTransferError(error: unknown): boolean {
  return error instanceof Error && error.message === TRANSFER_CANCELLED_MESSAGE;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function extensionFor(fileName: string): string {
  const match = /\.[A-Za-z0-9]{1,12}$/.exec(fileName);
  return match?.[0] ?? '.bin';
}

function transferSpeed(row: TransferRow): number {
  const elapsedSeconds = Math.max(0, (row.updatedAt - row.startedAt) / 1000);
  if (elapsedSeconds <= 0 || row.transferredBytes <= 0 || row.status === 'paused') {
    return 0;
  }
  return row.transferredBytes / elapsedSeconds;
}

function transferETA(row: TransferRow, speed: number): string {
  if (speed <= 0 || row.totalBytes <= row.transferredBytes || row.status === 'done') {
    return '';
  }
  const seconds = Math.ceil((row.totalBytes - row.transferredBytes) / speed);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function directStateLabel(state: DirectState): string {
  switch (state) {
    case 'direct':
      return '已直连';
    case 'connecting':
      return '建立中';
    default:
      return '未直连';
  }
}

function directSnapshotLabel(snapshot: DirectPeerSnapshot): string {
  if (snapshot.state === 'direct') {
    return snapshot.channelState === 'open' ? 'DC open' : `DC ${snapshot.channelState ?? 'pending'}`;
  }
  const parts = [`ICE ${snapshot.iceConnectionState}`, `PC ${snapshot.connectionState}`];
  if (snapshot.reconnectAttempts > 0) {
    parts.push(`重试 ${snapshot.reconnectAttempts}`);
  }
  return parts.slice(0, 3).join(' / ');
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'online':
      return '实时在线';
    case 'connecting':
      return '连接中';
    case 'offline':
      return '离线';
    case 'error':
      return '连接异常';
    default:
      return '准备中';
  }
}

function transferLabel(status: TransferStatus): string {
  switch (status) {
    case 'queued':
      return '等待中';
    case 'uploading':
      return '上传中';
    case 'receiving':
      return '接收中';
    case 'paused':
      return '已暂停';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}
