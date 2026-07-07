import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Download,
  Edit3,
  FileUp,
  Globe2,
  LogIn,
  Menu,
  MessageCircle,
  Paperclip,
  Send,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { ChatMessage, Peer, SendMessageRequest, ServerEvent, SessionResponse } from '@shared/protocol';
import { DirectMesh, type DirectState, type IncomingDirectFile } from './webrtc';
import {
  GLOBAL_THREAD,
  clearThreadMessages,
  normalizeRoomId,
  peerName,
  roomFromHash,
  threadForClearEvent,
  upsertMessage,
  visibleMessages,
} from './app-model';
import { buildWsUrl, cn, formatBytes, formatClock } from './lib/utils';

type SocketState = 'idle' | 'connecting' | 'online' | 'offline';

interface UploadState {
  fileName: string;
  progress: number;
  status: 'uploading' | 'done' | 'failed';
}

interface Notice {
  tone: 'info' | 'error' | 'success';
  text: string;
}

const NICKNAME_KEY = 'patrick-im:nickname';

async function apiJSON<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const message = await readError(response);
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `request failed: ${response.status}`;
  } catch {
    return `request failed: ${response.status}`;
  }
}

function initialNickname(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(NICKNAME_KEY) ?? '';
}

export default function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [roomInput, setRoomInput] = useState(() => roomFromHash('111'));
  const [activeRoom, setActiveRoom] = useState(() => roomFromHash('111'));
  const [nicknameDraft, setNicknameDraft] = useState(initialNickname);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadId, setThreadId] = useState(GLOBAL_THREAD);
  const [composer, setComposer] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [socketState, setSocketState] = useState<SocketState>('idle');
  const [directStates, setDirectStates] = useState<Record<string, DirectState>>({});
  const [isSending, setIsSending] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [notice, setNotice] = useState<Notice>({ tone: 'info', text: 'ready' });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const directMeshRef = useRef<DirectMesh | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  const selfId = session?.clientId ?? '';
  const otherPeers = useMemo(() => peers.filter((peer) => peer.clientId !== selfId), [peers, selfId]);
  const threadMessages = useMemo(
    () => (selfId ? visibleMessages(messages, selfId, threadId) : []),
    [messages, selfId, threadId],
  );
  const roomPath = encodeURIComponent(activeRoom);
  const activePeerName = threadId === GLOBAL_THREAD ? '房间聊天' : peerName(otherPeers, threadId);
  const activeDirectState = threadId === GLOBAL_THREAD ? undefined : directStates[threadId];
  const canSendDirectFile = Boolean(selectedFile && threadId !== GLOBAL_THREAD && activeDirectState === 'direct');

  useEffect(() => {
    let cancelled = false;
    apiJSON<SessionResponse>('/api/session')
      .then(async (payload) => {
        if (cancelled) {
          return;
        }
        const storedNickname = initialNickname();
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
      .catch(() => {
        if (!cancelled) {
          setNotice({ tone: 'error', text: 'session failed' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      objectUrlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const nextRoom = roomFromHash(activeRoom);
      setRoomInput(nextRoom);
      setActiveRoom(nextRoom);
      setThreadId(GLOBAL_THREAD);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [activeRoom]);

  useEffect(() => {
    if (!session || !activeRoom) {
      return;
    }
    let cancelled = false;
    setMessages([]);
    setPeers([]);
    setSocketState('connecting');
    apiJSON<{ messages: ChatMessage[] }>(`/api/rooms/${roomPath}/messages`)
      .then((payload) => {
        if (!cancelled) {
          setMessages(payload.messages ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNotice({ tone: 'error', text: 'history failed' });
        }
      });

    const ws = new WebSocket(buildWsUrl(`/api/rooms/${roomPath}/ws`), [
      'patrick-im',
      `patrick-im-session.${session.sessionToken ?? ''}`,
    ]);
    const mesh = new DirectMesh({
      selfId: session.clientId,
      selfName: session.nickname,
      roomId: activeRoom,
      iceServers: session.iceServers ?? [],
      sendSignal: (targetId, payload) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'signal', targetId, payload }));
        }
      },
      onStateChange: (peerId, state) => {
        setDirectStates((current) => ({ ...current, [peerId]: state }));
      },
      onIncomingFile: (file) => {
        objectUrlsRef.current.push(file.url);
        setMessages((current) => upsertMessage(current, directFileToMessage(file)));
        setNotice({ tone: 'success', text: `${file.fileName} 已通过直连接收` });
      },
    });
    directMeshRef.current = mesh;
    wsRef.current = ws;
    ws.onopen = () => setSocketState('online');
    ws.onerror = () => setSocketState('offline');
    ws.onclose = () => setSocketState('offline');
    ws.onmessage = (event) => {
      let payload: ServerEvent;
      try {
        payload = JSON.parse(event.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (payload.type === 'presence') {
        const nextPeers = payload.peers ?? [];
        setPeers(nextPeers);
        mesh.setPeers(nextPeers);
        return;
      }
      if (payload.type === 'signal' && payload.fromId && payload.payload) {
        void mesh.handleSignal(payload.fromId, payload.payload);
        return;
      }
      if (payload.type === 'message' && payload.message) {
        setMessages((current) => upsertMessage(current, payload.message!));
        return;
      }
      if (payload.type === 'messages-cleared') {
        const clearedThread = threadForClearEvent(session.clientId, payload.actorId, payload.targetId);
        setMessages((current) => clearThreadMessages(current, session.clientId, clearedThread));
      }
    };
    return () => {
      cancelled = true;
      mesh.close();
      setDirectStates({});
      ws.close();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      if (directMeshRef.current === mesh) {
        directMeshRef.current = null;
      }
    };
  }, [activeRoom, roomPath, session]);

  function enterRoom(event?: FormEvent) {
    event?.preventDefault();
    const nextRoom = normalizeRoomId(roomInput);
    setActiveRoom(nextRoom);
    setRoomInput(nextRoom);
    setThreadId(GLOBAL_THREAD);
    window.location.hash = encodeURIComponent(nextRoom);
  }

  async function saveNickname() {
    const nickname = nicknameDraft.trim();
    if (!nickname) {
      return;
    }
    const renamed = await apiJSON<SessionResponse>('/api/session', {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    });
    window.localStorage.setItem(NICKNAME_KEY, renamed.nickname);
    setSession(renamed);
    directMeshRef.current?.setSelfName(renamed.nickname);
    setNotice({ tone: 'success', text: 'nickname saved' });
  }

  async function sendText() {
    const text = composer.trim();
    if (!text || !session || isSending) {
      return;
    }
    setIsSending(true);
    try {
      const body: SendMessageRequest = {
        text,
        targetId: threadId === GLOBAL_THREAD ? null : threadId,
      };
      const message = await apiJSON<ChatMessage>(`/api/rooms/${roomPath}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMessages((current) => upsertMessage(current, message));
      setComposer('');
      setNotice({ tone: 'success', text: '已发送' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '发送失败' });
    } finally {
      setIsSending(false);
    }
  }

  async function sendFile() {
    if (!selectedFile || !session || isSending) {
      return;
    }
    const file = selectedFile;
    if (canSendDirectFile && directMeshRef.current) {
      setIsSending(true);
      setUpload({ fileName: file.name, progress: 0, status: 'uploading' });
      try {
        const sent = await directMeshRef.current.sendFile(threadId, file);
        if (sent) {
          const url = URL.createObjectURL(file);
          objectUrlsRef.current.push(url);
          setMessages((current) => upsertMessage(current, localDirectFileMessage(file, url, activeRoom, session, threadId)));
          setSelectedFile(null);
          setUpload({ fileName: file.name, progress: 100, status: 'done' });
          setNotice({ tone: 'success', text: '已通过 WebRTC 直连发送' });
          setIsSending(false);
          return;
        }
      } catch {
      }
      setIsSending(false);
      setNotice({ tone: 'info', text: '直连不可用，改用服务器发送' });
    }
    sendServerFile(file);
  }

  function sendServerFile(file: File) {
    const form = new FormData();
    form.append('file', file);
    if (threadId !== GLOBAL_THREAD) {
      form.append('targetId', threadId);
    }
    const xhr = new XMLHttpRequest();
    setIsSending(true);
    setUpload({ fileName: file.name, progress: 0, status: 'uploading' });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUpload({ fileName: file.name, progress: Math.round((event.loaded / event.total) * 100), status: 'uploading' });
      }
    };
    xhr.onload = () => {
      setIsSending(false);
      if (xhr.status < 200 || xhr.status >= 300) {
        setUpload({ fileName: file.name, progress: 100, status: 'failed' });
        setNotice({ tone: 'error', text: '上传失败' });
        return;
      }
      const message = JSON.parse(xhr.responseText) as ChatMessage;
      setMessages((current) => upsertMessage(current, message));
      setSelectedFile(null);
      setUpload({ fileName: file.name, progress: 100, status: 'done' });
      setNotice({ tone: 'success', text: '文件已发送' });
    };
    xhr.onerror = () => {
      setIsSending(false);
      setUpload({ fileName: file.name, progress: 100, status: 'failed' });
      setNotice({ tone: 'error', text: '上传失败' });
    };
    xhr.open('POST', `/api/rooms/${roomPath}/files`);
    xhr.send(form);
  }

  async function clearCurrentThread() {
    if (!session) {
      return;
    }
    const target = threadId === GLOBAL_THREAD ? '' : `?targetId=${encodeURIComponent(threadId)}`;
    try {
      await apiJSON(`/api/rooms/${roomPath}/messages${target}`, { method: 'DELETE' });
      setMessages((current) => clearThreadMessages(current, session.clientId, threadId));
      setNotice({ tone: 'success', text: '已清空' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '清空失败' });
    }
  }

  const canSendText = Boolean(composer.trim()) && !isSending && Boolean(session);
  const canSendFile = Boolean(selectedFile) && !isSending && Boolean(session);

  return (
    <div className="app-shell">
      <aside className={cn('sidebar', sidebarOpen && 'sidebar-open')}>
        <div className="brand-row">
          <div className="brand-mark">P</div>
          <div>
            <div className="brand-title">Patrick-IM</div>
            <div className="brand-subtitle">{otherPeers.length} 台其他设备在线</div>
          </div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="close sidebar">
            <X size={18} />
          </button>
        </div>

        <form className="room-form" onSubmit={enterRoom}>
          <input value={roomInput} onChange={(event) => setRoomInput(event.target.value)} aria-label="room id" />
          <button className="icon-button" type="submit" aria-label="enter room">
            <LogIn size={18} />
          </button>
        </form>

        <nav className="thread-list">
          <button
            className={cn('thread-button', threadId === GLOBAL_THREAD && 'thread-active')}
            onClick={() => setThreadId(GLOBAL_THREAD)}
          >
            <Globe2 size={18} />
            <span>
              <strong>房间聊天</strong>
              <small>所有人</small>
            </span>
          </button>
          {otherPeers.map((peer) => (
            <button
              key={peer.clientId}
              className={cn('thread-button', threadId === peer.clientId && 'thread-active')}
              onClick={() => setThreadId(peer.clientId)}
            >
              <Users size={18} />
              <span>
                <strong>{peer.nickname}</strong>
                <small>{peer.clientId.slice(0, 8)} · {directStateLabel(directStates[peer.clientId])}</small>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="chat-main">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="open sidebar">
            <Menu size={20} />
          </button>
          <div>
            <h1>{activePeerName}</h1>
            <div className="room-line">
              <span>#{activeRoom}</span>
              <span className={cn('status-pill', socketState === 'online' ? 'online' : 'offline')}>
                {socketState === 'online' ? <Wifi size={14} /> : <WifiOff size={14} />}
                {socketLabel(socketState)}
              </span>
              {threadId !== GLOBAL_THREAD ? <span className="status-pill">{directStateLabel(activeDirectState)}</span> : null}
            </div>
          </div>
          <div className="profile-box">
            <input value={nicknameDraft} onChange={(event) => setNicknameDraft(event.target.value)} aria-label="nickname" />
            <button className="icon-button" onClick={saveNickname} aria-label="save nickname">
              <Edit3 size={17} />
            </button>
          </div>
        </header>

        <section className="messages-panel">
          {threadMessages.length === 0 ? (
            <div className="empty-state">
              <MessageCircle size={34} />
              <span>还没有消息</span>
            </div>
          ) : (
            threadMessages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                mine={message.senderId === selfId}
                senderName={message.senderId === selfId ? session?.nickname || 'Me' : message.senderName}
              />
            ))
          )}
        </section>

        {upload ? (
          <div className={cn('upload-row', upload.status)}>
            <FileUp size={18} />
            <span>{upload.fileName}</span>
            <div className="upload-track">
              <div style={{ width: `${upload.progress}%` }} />
            </div>
            <strong>{upload.progress}%</strong>
          </div>
        ) : null}

        <footer className="composer">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
          />
          <button className="icon-button" onClick={() => fileInputRef.current?.click()} aria-label="pick file">
            <Paperclip size={20} />
          </button>
          <div className="composer-stack">
            {selectedFile ? (
              <div className="selected-file">
                <span>{selectedFile.name}</span>
                <small>{formatBytes(selectedFile.size)}</small>
                <button onClick={() => setSelectedFile(null)} aria-label="remove file">
                  <X size={14} />
                </button>
              </div>
            ) : null}
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendText();
                }
              }}
              placeholder={threadId === GLOBAL_THREAD ? '输入房间消息...' : `给 ${activePeerName} 发消息...`}
            />
          </div>
          {selectedFile ? (
            <button className="send-button" disabled={!canSendFile} onClick={() => void sendFile()}>
              <FileUp size={18} />
              {canSendDirectFile ? '直连发送' : '上传'}
            </button>
          ) : (
            <button className="send-button" disabled={!canSendText} onClick={() => void sendText()}>
              <Send size={18} />
              发送
            </button>
          )}
          <button className="icon-button danger" onClick={() => void clearCurrentThread()} aria-label="clear thread">
            <Trash2 size={18} />
          </button>
        </footer>

        <div className={cn('notice', notice.tone)}>{notice.text}</div>
      </main>
    </div>
  );
}

function MessageBubble({ message, mine, senderName }: { message: ChatMessage; mine: boolean; senderName: string }) {
  return (
    <article className={cn('message-bubble', mine && 'mine')}>
      <div className="message-meta">
        <strong>{senderName}</strong>
        <span>{formatClock(message.createdAt)}</span>
      </div>
      {message.kind === 'text' ? <p>{message.text}</p> : null}
      {message.kind === 'file' && message.file ? (
        <a className="file-message" href={message.file.url} target="_blank" rel="noreferrer">
          <Download size={18} />
          <span>
            <strong>{message.file.fileName}</strong>
            <small>{formatBytes(message.file.size)}</small>
          </span>
        </a>
      ) : null}
    </article>
  );
}

function socketLabel(state: SocketState): string {
  switch (state) {
    case 'online':
      return '实时在线';
    case 'connecting':
      return '连接中';
    case 'offline':
      return '实时离线';
    default:
      return '准备中';
  }
}

function directStateLabel(state?: DirectState): string {
  switch (state) {
    case 'direct':
      return 'WebRTC 直连';
    case 'connecting':
      return '直连建立中';
    case 'offline':
      return '服务器发送';
    default:
      return '服务器发送';
  }
}

function localDirectFileMessage(
  file: File,
  url: string,
  roomId: string,
  session: SessionResponse,
  targetId: string,
): ChatMessage {
  const id = `direct-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  return {
    id,
    roomId,
    kind: 'file',
    senderId: session.clientId,
    senderName: session.nickname,
    targetId,
    createdAt: Date.now(),
    file: {
      id,
      fileName: file.name || 'file',
      size: file.size,
      contentType: file.type || 'application/octet-stream',
      url,
      previewable: isPreviewable(file.type),
    },
  };
}

function directFileToMessage(file: IncomingDirectFile): ChatMessage {
  return {
    id: `direct-${file.id}`,
    roomId: file.roomId,
    kind: 'file',
    senderId: file.senderId,
    senderName: file.senderName,
    targetId: file.targetId,
    createdAt: file.createdAt,
    file: {
      id: file.id,
      fileName: file.fileName,
      size: file.size,
      contentType: file.contentType,
      url: file.url,
      previewable: isPreviewable(file.contentType),
    },
  };
}

function isPreviewable(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('image/');
}
