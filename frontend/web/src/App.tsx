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
  Send,
  Trash2,
  Upload,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import type {
  ClientToServerMessage,
  ChatMessage,
  ClearThreadResponse,
  DirectPeerState,
  RelayAbortUploadRequest,
  RelayDiscardUploadRequest,
  RelayPresignedPart,
  RelayUploadPartResponse,
  RelayUploadResponse,
  ServerToClientMessage,
  SessionResponse,
  TransferMode,
} from '@shared/protocol';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  clearReceiveDirectory,
  createWritableFile,
  ensureDirectoryWritable,
  loadReceiveDirectoryState,
  pickReceiveDirectory,
  supportsDirectoryPicker,
  type StoredDirectoryState,
} from '@/lib/file-system';
import { buildWsUrl, cn, formatBytes, roomToSlug } from '@/lib/utils';
import { PeerMesh, type DirectPathInfo, type IncomingFilePayload, type TransferUpdate } from '@/lib/peer-mesh';

const GLOBAL_THREAD = '__global__';
const RECENT_ROOMS_KEY = 'patrick-im:recent-rooms';
const WS_HEARTBEAT_INTERVAL_MS = 15_000;
const WS_HEARTBEAT_STALE_AFTER_MS = 55_000;
const WS_WATCHDOG_INTERVAL_MS = 5_000;
const WS_RESUME_PROBE_INTERVAL_MS = 3_000;
const WS_CONNECT_TIMEOUT_MS = 12_000;
const WS_RECONNECT_BASE_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 30_000;
const TRANSFER_MODE_TOOLTIP_DELAY_MS = 500;
const PEER_PATH_TOOLTIP_DELAY_MS = 500;
const TRANSIENT_NOTICE_RESET_MS = 2600;
// Public relay uploads to the HK server are usually RTT-bound, so 8 parallel 8 MiB
// parts make better use of the uplink than the previous smaller window.
const RELAY_UPLOAD_CONCURRENCY = 8;
const LARGE_DIRECT_FILE_NOTICE_BYTES = 256 * 1024 * 1024;
const DEFAULT_NOTICE = '把两个浏览器打开到同一个房间后，就可以开始发文字、图片和文件了。';
const HEADER_BADGE_CLASS = 'h-7 rounded-full px-3 text-[12px] font-medium shadow-sm';
const PENDING_RELAY_ABORTS_KEY = 'patrick-im:pending-relay-aborts';

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

interface UiMessage extends ChatMessage {
  localUrl?: string;
  savedToDisk?: boolean;
}

interface TransferRow extends TransferUpdate {
  id: string;
  startedAt: number;
  speedBytesPerSecond?: number;
  lastProgressAt?: number;
  lastProgressBytes?: number;
}

interface PendingAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

interface RelayUploadTask {
  transferId: string;
  fileName: string;
  uploadToken: string;
  roomId: string;
  peerId: string;
  peerName: string;
  totalBytes: number;
  cancelled: boolean;
  xhrs: Set<XMLHttpRequest>;
}

interface PendingRelayAbortTicket {
  uploadToken: string;
  createdAt: number;
}

type SocketStatus = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'paused' | 'closed' | 'error';
type PeerPresenceStatus = 'online' | 'offline' | 'recovering' | 'unknown';

function isRelayUploadCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === 'relay_upload_cancelled';
}

function createRelayUploadCancelledError(): Error {
  return new Error('relay_upload_cancelled');
}

function loadPendingRelayAbortTickets(): PendingRelayAbortTicket[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(PENDING_RELAY_ABORTS_KEY);
    const parsed = stored ? (JSON.parse(stored) as PendingRelayAbortTicket[]) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const seen = new Set<string>();
    return parsed.filter((item) => {
      if (!item || typeof item.uploadToken !== 'string' || !item.uploadToken) {
        return false;
      }
      if (seen.has(item.uploadToken)) {
        return false;
      }
      seen.add(item.uploadToken);
      return true;
    });
  } catch {
    return [];
  }
}

function storePendingRelayAbortTickets(tickets: PendingRelayAbortTicket[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(PENDING_RELAY_ABORTS_KEY, JSON.stringify(tickets.slice(-64)));
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

function uploadPresignedPartWithProgress(
  part: RelayPresignedPart,
  chunk: Blob,
  onProgress: (loaded: number) => void,
  task: RelayUploadTask,
): Promise<RelayUploadPartResponse> {
  return new Promise<RelayUploadPartResponse>((resolve, reject) => {
    if (task.cancelled) {
      reject(createRelayUploadCancelledError());
      return;
    }

    const xhr = new XMLHttpRequest();
    task.xhrs.add(xhr);
    xhr.open('PUT', part.url, true);
    for (const header of part.headers) {
      xhr.setRequestHeader(header.name, header.value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded);
      }
    };
    xhr.onabort = () => {
      task.xhrs.delete(xhr);
      reject(createRelayUploadCancelledError());
    };
    xhr.onerror = () => {
      task.xhrs.delete(xhr);
      reject(new Error('upload_part_failed'));
    };
    xhr.onload = () => {
      task.xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('etag') ?? xhr.getResponseHeader('ETag');
        if (!etag) {
          reject(new Error('upload_part_missing_etag'));
          return;
        }
        resolve({
          partNumber: part.partNumber,
          etag,
        });
      } else {
        reject(new Error(`upload_part_failed_${xhr.status}`));
      }
    };

    if (task.cancelled) {
      xhr.abort();
      return;
    }

    xhr.send(chunk);
  });
}

async function uploadRelayPartsConcurrently(options: {
  file: File;
  chunkSizeBytes: number;
  partUrls: RelayPresignedPart[];
  onProgress: (transferredBytes: number, totalParts: number) => void;
  task: RelayUploadTask;
}): Promise<RelayUploadPartResponse[]> {
  const { file, chunkSizeBytes, partUrls, onProgress, task } = options;
  const chunks: Array<{ partNumber: number; chunk: Blob }> = [];
  const partUrlByNumber = new Map(partUrls.map((part) => [part.partNumber, part]));

  for (let offset = 0, partNumber = 1; offset < file.size; offset += chunkSizeBytes, partNumber += 1) {
    chunks.push({
      partNumber,
      chunk: file.slice(offset, Math.min(file.size, offset + chunkSizeBytes)),
    });
  }

  const uploadedParts: RelayUploadPartResponse[] = [];
  const loadedByPart = new Map<number, number>();
  const totalParts = chunks.length;
  let aggregateLoadedBytes = 0;
  let cursor = 0;

  const setPartLoaded = (partNumber: number, loaded: number) => {
    const previous = loadedByPart.get(partNumber) ?? 0;
    loadedByPart.set(partNumber, loaded);
    aggregateLoadedBytes += loaded - previous;
    onProgress(Math.min(file.size, aggregateLoadedBytes), totalParts);
  };

  const uploadNext = async (): Promise<void> => {
    if (task.cancelled) {
      throw createRelayUploadCancelledError();
    }

    const current = chunks[cursor];
    cursor += 1;
    if (!current) {
      return;
    }

    const partUrl = partUrlByNumber.get(current.partNumber);
    if (!partUrl) {
      throw new Error(`upload_part_url_missing_${current.partNumber}`);
    }

    const part = await uploadPresignedPartWithProgress(partUrl, current.chunk, (loaded) => {
      setPartLoaded(current.partNumber, loaded);
    }, task);
    setPartLoaded(current.partNumber, current.chunk.size);
    uploadedParts.push(part);
    await uploadNext();
  };

  await Promise.all(
    Array.from({ length: Math.min(RELAY_UPLOAD_CONCURRENCY, chunks.length) }, () => uploadNext()),
  );

  uploadedParts.sort((left, right) => left.partNumber - right.partNumber);
  return uploadedParts;
}

function getRoomShareLink(roomId: string): string {
  return `${window.location.origin}/#${encodeURIComponent(roomId)}`;
}

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase() || '??';
}

function formatClockTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatAgo(timestamp: number): string {
  const diffSeconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return '刚刚';
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)} 分钟前`;
  }
  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)} 小时前`;
  }
  return `${Math.floor(diffSeconds / 86400)} 天前`;
}

function socketStatusLabel(status: SocketStatus): string {
  switch (status) {
    case 'idle':
      return '信令未连接';
    case 'connecting':
      return '信令连接中';
    case 'reconnecting':
      return '信令重连中';
    case 'connected':
      return '信令在线';
    case 'paused':
      return '信令待恢复';
    case 'closed':
      return '信令离线';
    case 'error':
      return '信令异常';
    default:
      return status;
  }
}

function socketStatusTone(status: SocketStatus): string {
  switch (status) {
    case 'connected':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'connecting':
    case 'reconnecting':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'paused':
      return 'border-slate-200 bg-slate-100 text-slate-600';
    case 'error':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    case 'closed':
      return 'border-slate-200 bg-slate-100 text-slate-600';
    default:
      return 'border-slate-200 bg-slate-100 text-slate-600';
  }
}

function socketStatusDotTone(status: SocketStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500';
    case 'connecting':
    case 'reconnecting':
      return 'bg-amber-500';
    case 'paused':
      return 'bg-slate-400';
    case 'error':
      return 'bg-rose-500';
    case 'closed':
      return 'bg-slate-400';
    default:
      return 'bg-slate-400';
  }
}

function getPeerPresenceStatus(
  socketStatus: SocketStatus,
  isOnline: boolean,
  directState: DirectPeerState | undefined,
): PeerPresenceStatus {
  if (directState === 'connected') {
    return 'online';
  }

  if (socketStatus === 'connected') {
    return isOnline ? 'online' : 'offline';
  }

  if (socketStatus === 'connecting' || socketStatus === 'reconnecting' || socketStatus === 'paused') {
    return 'recovering';
  }

  return 'unknown';
}

function peerSignalLabel(status: PeerPresenceStatus): string {
  switch (status) {
    case 'online':
      return '对方在线';
    case 'offline':
      return '对方离线';
    case 'recovering':
      return '在线状态恢复中';
    case 'unknown':
      return '在线状态未知';
    default:
      return status;
  }
}

function peerStateLabel(state: DirectPeerState | undefined): string {
  switch (state) {
    case 'connecting':
      return 'P2P 建立中';
    case 'connected':
      return 'P2P 已连接';
    case 'failed':
      return 'P2P 改走中继';
    case 'offline':
      return 'P2P 未连接';
    default:
      return 'P2P 未连接';
  }
}

function directPathLabel(path?: DirectPathInfo | null): string {
  switch (path?.kind) {
    case 'lan':
      return '局域网直连';
    case 'stun':
      return 'STUN 打洞';
    case 'turn':
      return 'TURN 中继';
    case 'unknown':
      return '链路未知';
    default:
      return '识别中';
  }
}

function directPathDescription(path?: DirectPathInfo | null): string {
  switch (path?.kind) {
    case 'lan':
      return '当前是 host-host，本地网络直连。';
    case 'stun':
      return '当前通过 STUN 打洞建立直连，不是纯局域网。';
    case 'turn':
      return '当前实际经过 TURN 中继，这种情况通常会慢很多。';
    case 'unknown':
      return '已经连上，但浏览器还没明确识别出链路类型。';
    default:
      return '正在读取当前 WebRTC candidate pair。';
  }
}

function candidateTypeLabel(type?: string): string {
  switch (type) {
    case 'host':
      return 'host';
    case 'srflx':
      return 'srflx';
    case 'prflx':
      return 'prflx';
    case 'relay':
      return 'relay';
    default:
      return type ?? '-';
  }
}

function peerDotTone(state: DirectPeerState | undefined, presence: PeerPresenceStatus): string {
  if (state === 'connected') {
    return 'bg-emerald-500';
  }

  if (state === 'connecting') {
    return 'bg-amber-500';
  }

  if (state === 'failed') {
    return 'bg-orange-400';
  }

  switch (presence) {
    case 'online':
      return 'bg-sky-500';
    case 'recovering':
      return 'bg-amber-400';
    case 'unknown':
      return 'bg-slate-400';
    case 'offline':
    default:
      return 'bg-slate-400';
  }
}

function peerBadgeTone(state: DirectPeerState | undefined): string {
  switch (state) {
    case 'connected':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'connecting':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'failed':
      return 'border-orange-200 bg-orange-50 text-orange-700';
    case 'offline':
      return 'border-slate-200 bg-slate-100 text-slate-500';
    default:
      return '';
  }
}

function transferStatusLabel(status: TransferRow['status']): string {
  switch (status) {
    case 'pending':
      return '等待中';
    case 'streaming':
      return '传输中';
    case 'complete':
      return '已完成';
    case 'failed':
      return '失败';
    case 'declined':
      return '被拒绝';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}

function transportLabel(transport: ChatMessage['transport'] | TransferRow['transport']): string {
  switch (transport) {
    case 'direct-p2p':
      return 'P2P 直连';
    case 'server-relay':
      return '服务端中继';
    case 'server-sync':
      return '服务端同步';
    default:
      return transport;
  }
}

function transportBadgeTone(transport: ChatMessage['transport'] | TransferRow['transport']): string {
  switch (transport) {
    case 'direct-p2p':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'server-relay':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'server-sync':
      return 'border-sky-200 bg-sky-50 text-sky-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
}

function formatTransferNote(note?: string): string | undefined {
  if (!note) {
    return undefined;
  }

  switch (note) {
    case 'saved directly to receive directory':
      return '已直接写入接收目录';
    case 'receiver asked to use relay mode':
      return '对方要求改走服务端中继';
    case 'receiver declined':
      return '对方已拒绝接收';
    case 'data channel error':
      return '数据通道异常';
    case 'transfer interrupted':
      return '传输中断';
    case 'stream failed':
      return '传输失败';
    case 'The object is in an invalid state.':
      return '直连通道在传输中失效了，常见于浏览器兼容或分片过大';
    case 'direct channel closed during transfer':
      return '直连通道在传输中被关闭了';
    case 'waiting for receiver confirmation':
      return '发送端已发完，等待接收端确认';
    case 'receiver confirmation is delayed':
      return '接收端确认较慢，继续等待中';
    case 'receiver is finalizing file':
      return '接收端已收齐，正在写入文件';
    case 'receiver finalization is taking longer than expected':
      return '接收端正在写入文件，耗时比预期更久';
    case 'receiver confirmation timed out':
      return '等待接收端确认超时（已等待 10 分钟）';
    case 'receiver finalization timed out':
      return '接收端长时间未完成写入（已等待 10 分钟）';
    case 'transfer_interrupted':
      return '接收端报告传输中断';
    case 'receiver_write_failed':
      return '接收端写入文件失败';
    case 'receiver reported failure':
      return '接收端报告传输失败';
    case 'cancelled locally':
      return '已取消';
    case 'cancelled by remote':
      return '对方已取消';
    default:
      return note;
  }
}

function formatTransferSpeed(speedBytesPerSecond?: number): string | undefined {
  if (!speedBytesPerSecond || !Number.isFinite(speedBytesPerSecond) || speedBytesPerSecond <= 0) {
    return undefined;
  }

  return `${formatBytes(speedBytesPerSecond)}/s`;
}

function getMessageThreadKey(message: ChatMessage, selfId?: string): string {
  if (!selfId) {
    return message.targetId ?? GLOBAL_THREAD;
  }

  if (!message.targetId) {
    return GLOBAL_THREAD;
  }

  return message.fromId === selfId ? message.targetId : message.fromId;
}

function summarizeMessage(message: ChatMessage): string {
  if (message.text) {
    return message.text;
  }

  if (message.file) {
    return message.file.previewable ? `[图片] ${message.file.fileName}` : `[文件] ${message.file.fileName}`;
  }

  return '新消息';
}

function getThreadKeyForClearedEvent(
  targetId: string | null,
  actorId: string,
  selfId?: string,
): string {
  if (!targetId) {
    return GLOBAL_THREAD;
  }

  if (!selfId) {
    return targetId;
  }

  return actorId === selfId ? targetId : actorId;
}

function buildRoomWebSocketUrl(roomId: string, nickname: string): string {
  const url = new URL(buildWsUrl(`/api/rooms/${roomId}/ws`));
  if (nickname.trim()) {
    url.searchParams.set('nickname', nickname.trim());
  }
  return url.toString();
}

function RoomPicker({
  roomDraft,
  recentRooms,
  currentRoom,
  onRoomDraftChange,
  onJoinRoom,
}: {
  roomDraft: string;
  recentRooms: string[];
  currentRoom: string | null;
  onRoomDraftChange: (value: string) => void;
  onJoinRoom: (roomId?: string) => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#eff6ff] p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">加入房间</h1>
          <p className="mt-2 text-sm text-slate-600">输入房间号，或者从最近使用过的房间里继续。</p>
          {currentRoom ? (
            <div className="mt-3">
              <Badge className="border-blue-200 bg-blue-50 text-blue-700">当前房间：{currentRoom}</Badge>
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          <Input
            value={roomDraft}
            onChange={(event) => onRoomDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onJoinRoom(roomDraft);
              }
            }}
            placeholder="输入房间号..."
            className="h-10 rounded-lg"
          />
          <Button
            onClick={() => onJoinRoom(roomDraft)}
            className="h-10 w-full bg-[#1e3a8a] text-white hover:bg-[#1e3a8a]/90"
          >
            加入房间
          </Button>
        </div>

        {recentRooms.length > 0 ? (
          <>
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-white px-3 text-slate-500">最近使用</span>
              </div>
            </div>

            <div className="space-y-2">
              {recentRooms.map((room) => (
                <button
                  key={room}
                  type="button"
                  onClick={() => onJoinRoom(room)}
                  className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-left transition-colors hover:bg-blue-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">{room}</div>
                    <div className="mt-1 text-xs text-slate-500">点击直接进入这个房间</div>
                  </div>
                  <Badge className="border-slate-200 bg-slate-50 text-slate-600">房间</Badge>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
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
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('idle');
  const [composer, setComposer] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [peers, setPeers] = useState<Array<{ clientId: string; nickname: string; joinedAt: number }>>([]);
  const [transferMode, setTransferMode] = useState<TransferMode>('auto');
  const [directStates, setDirectStates] = useState<Record<string, DirectPeerState>>({});
  const [directPaths, setDirectPaths] = useState<Record<string, DirectPathInfo>>({});
  const [transfers, setTransfers] = useState<Record<string, TransferRow>>({});
  const [notice, setNotice] = useState(DEFAULT_NOTICE);
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

  const wsRef = useRef<WebSocket | null>(null);
  const meshRef = useRef<PeerMesh | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const dragCounterRef = useRef(0);
  const objectUrlsRef = useRef<string[]>([]);
  const peerNamesRef = useRef<Record<string, string>>({});
  const socketStatusRef = useRef<SocketStatus>('idle');
  const receiveDirectoryRef = useRef<StoredDirectoryState>({
    handle: null,
    status: supportsDirectoryPicker() ? 'not-configured' : 'unsupported',
    name: '',
  });
  const messagesRef = useRef<UiMessage[]>([]);
  const activeRoomRef = useRef<string | null>(null);
  const activeThreadRef = useRef<string>(GLOBAL_THREAD);
  const relayAbortQueueRef = useRef<PendingRelayAbortTicket[]>(loadPendingRelayAbortTickets());
  const copiedMessageTimerRef = useRef<number | null>(null);
  const transferModeTooltipTimerRef = useRef<number | null>(null);
  const peerPathTooltipTimerRef = useRef<number | null>(null);
  const shareFeedbackTimerRef = useRef<number | null>(null);
  const relayUploadTasksRef = useRef<Map<string, RelayUploadTask>>(new Map());
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
  const noticeResetTimerRef = useRef<number | null>(null);
  const activeTransferNoticeRef = useRef<string | null>(null);

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

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  useEffect(() => {
    socketStatusRef.current = socketStatus;
  }, [socketStatus]);

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

  useEffect(() => {
    if (!session) {
      return;
    }

    void flushPendingRelayAborts();
  }, [session]);

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
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (connectTimeoutTimerRef.current) {
        window.clearTimeout(connectTimeoutTimerRef.current);
        connectTimeoutTimerRef.current = null;
      }
      if (heartbeatTimerRef.current) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      if (watchdogTimerRef.current) {
        window.clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
      if (resumeProbeTimerRef.current) {
        window.clearInterval(resumeProbeTimerRef.current);
        resumeProbeTimerRef.current = null;
      }
      if (noticeResetTimerRef.current) {
        window.clearTimeout(noticeResetTimerRef.current);
        noticeResetTimerRef.current = null;
      }
      connectStartedAtRef.current = null;
      meshRef.current?.close();
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  useEffect(() => {
    if (!activeRoom || !session) {
      return;
    }

    const mesh = new PeerMesh({
      localClientId: session.clientId,
      iceServers: session.iceServers,
      directFileSoftLimitBytes: session.directFileSoftLimitBytes,
      prepareIncomingFileTarget,
      sendSignal: (targetId, payload) => {
        sendServerMessage({
          type: 'signal',
          targetId,
          payload,
        });
      },
      onPeerStateChange: applyPeerState,
      onIncomingFile: handleIncomingFile,
      onPeerPathChange: applyPeerPath,
      onTransferUpdate: updateTransfer,
    });

    meshRef.current = mesh;
    peerNamesRef.current = {};
    setSocketStatus('connecting');
    setMessages([]);
    messagesRef.current = [];
    setPeers([]);
    setTransfers({});
    setDirectStates({});
    setDirectPaths({});
    setUnreadCounts({});
    setActiveThread(GLOBAL_THREAD);
    reconnectAttemptRef.current = 0;
    hasConnectedOnceRef.current = false;
    clearReconnectTimer();

    let disposed = false;
    let intentionallyClosed = false;

    const setSignalStatus = (next: SocketStatus) => {
      socketStatusRef.current = next;
      setSocketStatus(next);
    };

    const stopHeartbeatLoop = () => {
      if (heartbeatTimerRef.current) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      if (watchdogTimerRef.current) {
        window.clearInterval(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    };

    const clearConnectTimeout = () => {
      if (connectTimeoutTimerRef.current) {
        window.clearTimeout(connectTimeoutTimerRef.current);
        connectTimeoutTimerRef.current = null;
      }
      connectStartedAtRef.current = null;
    };

    const retireSocket = (socket: WebSocket | null, closeCode = 4000, closeReason = 'replace socket') => {
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

      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(closeCode, closeReason);
      }
    };

    const canAttemptConnection = () => {
      if (disposed || intentionallyClosed) {
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
    };

    const isSocketConnectingTooLong = (socket: WebSocket | null): boolean => {
      if (!socket || socket.readyState !== WebSocket.CONNECTING || connectStartedAtRef.current === null) {
        return false;
      }

      return Date.now() - connectStartedAtRef.current >= WS_CONNECT_TIMEOUT_MS;
    };

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

      const ws = new WebSocket(buildRoomWebSocketUrl(activeRoom, nickname || session.nickname));
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
          nickname: nickname || session.nickname,
        });

        setNotice(getDefaultNotice(activeRoom));
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

        handleServerEvent(payload);
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
          setNotice('会话已失效，请刷新页面重试。');
          return;
        }

        if (event.code === 4409) {
          setSignalStatus('closed');
          setNotice('当前页面的信令连接已被新的连接替换。');
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
      void flushPendingRelayAborts();
      if (document.visibilityState !== 'visible') {
        return;
      }

      reconnectAttemptRef.current = 0;
      connectWebSocket(Boolean(wsRef.current));
    };

    const handleOffline = () => {
      abortAllRelayUploads({
        reason: 'cancelled locally',
        transport: 'fetch',
        updateUi: true,
        notice: '网络已断开，未完成的服务端中继上传已取消。',
      });
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
      abortAllRelayUploads({
        reason: 'cancelled locally',
        transport: 'beacon',
        updateUi: false,
      });
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
      abortAllRelayUploads({
        reason: 'cancelled locally',
        transport: 'fetch',
        updateUi: false,
      });
      mesh.close();
      meshRef.current = null;
    };
  }, [activeRoom, roomConnectionNonce, session]);

  useEffect(() => {
    if (!session || socketStatus !== 'connected') {
      return;
    }

    sendServerMessage({
      type: 'set-profile',
      nickname: nickname || session.nickname,
    });
  }, [nickname, session, socketStatus]);

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

  function sendServerMessage(payload: ClientToServerMessage): boolean {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return false;
    }
    wsRef.current.send(JSON.stringify(payload));
    return true;
  }

  function addMessage(message: UiMessage, trackUnread = true): void {
    if (messagesRef.current.some((item) => item.id === message.id)) {
      return;
    }

    const next = [...messagesRef.current, message];
    messagesRef.current = next;
    setMessages(next);

    if (!trackUnread || message.fromId === selfId) {
      return;
    }

    const key = getMessageThreadKey(message, selfId);
    if (key !== activeThreadRef.current) {
      setUnreadCounts((current) => ({
        ...current,
        [key]: (current[key] ?? 0) + 1,
      }));
    }
  }

  function getDefaultNotice(roomId: string | null = activeRoom): string {
    if (!roomId) {
      return DEFAULT_NOTICE;
    }
    return `已进入房间 ${roomId}。全局聊天发给整个房间，切到设备会话后就是和该设备的私聊。`;
  }

  function clearNoticeResetTimer(): void {
    if (noticeResetTimerRef.current) {
      window.clearTimeout(noticeResetTimerRef.current);
      noticeResetTimerRef.current = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
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
    if (update.direction === 'upload' && update.transport === 'direct-p2p') {
      if (update.status === 'complete' && activeTransferNoticeRef.current === update.transferId) {
        activeTransferNoticeRef.current = null;
        showTransientNotice(`${update.fileName} 已直连发送给 ${getPeerDisplayName(update.peerId, update.peerName)}。`);
      } else if (
        (update.status === 'failed' || update.status === 'declined') &&
        activeTransferNoticeRef.current === update.transferId
      ) {
        activeTransferNoticeRef.current = null;
        showTransientNotice(
          update.status === 'declined'
            ? `${update.fileName} 对方未接受直连，请切到中继后重发。`
            : `${update.fileName} 直连发送失败，请重试或切到中继。`,
          3200,
        );
      }
    }

    if (update.status === 'cancelled') {
      if (activeTransferNoticeRef.current === update.transferId) {
        activeTransferNoticeRef.current = null;
      }
      showTransientNotice(
        update.note === 'cancelled by remote'
          ? `${update.fileName} 已被对方取消。`
          : `${update.fileName} 已取消${update.direction === 'upload' ? '发送' : '接收'}。`,
      );
    }

    if (update.status === 'complete' || update.status === 'cancelled') {
      setTransfers((current) => {
        if (!(update.transferId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[update.transferId];
        return next;
      });
      return;
    }

    setTransfers((current) => {
      const existing = current[update.transferId];
      const now = Date.now();
      let speedBytesPerSecond = existing?.speedBytesPerSecond;
      let lastProgressAt = existing?.lastProgressAt ?? now;
      let lastProgressBytes = existing?.lastProgressBytes ?? update.transferredBytes;

      if (update.status === 'streaming') {
        const baseBytes = existing?.lastProgressBytes ?? update.transferredBytes;
        const baseAt = existing?.lastProgressAt ?? now;
        const deltaBytes = Math.max(0, update.transferredBytes - baseBytes);
        const deltaMs = now - baseAt;

        if (deltaBytes > 0 && deltaMs >= 250) {
          const instantSpeed = deltaBytes / (deltaMs / 1000);
          speedBytesPerSecond =
            typeof existing?.speedBytesPerSecond === 'number'
              ? existing.speedBytesPerSecond * 0.45 + instantSpeed * 0.55
              : instantSpeed;
          lastProgressAt = now;
          lastProgressBytes = update.transferredBytes;
        } else if (!existing) {
          lastProgressAt = now;
          lastProgressBytes = update.transferredBytes;
        }

        if (update.note === 'waiting for receiver confirmation') {
          speedBytesPerSecond = undefined;
        }
      } else if (update.status !== 'pending') {
        speedBytesPerSecond = undefined;
      }

      return {
        ...current,
        [update.transferId]: {
          ...update,
          id: update.transferId,
          startedAt: existing?.startedAt ?? now,
          speedBytesPerSecond,
          lastProgressAt,
          lastProgressBytes,
        },
      };
    });
  }

  function applyPeerState(peerId: string, nextState: DirectPeerState): void {
    setDirectStates((current) => ({
      ...current,
      [peerId]: nextState,
    }));

    if (nextState !== 'connected') {
      setDirectPaths((current) => {
        if (!(peerId in current)) {
          return current;
        }

        const next = { ...current };
        delete next[peerId];
        return next;
      });
    }
  }

  function applyPeerPath(peerId: string, path: DirectPathInfo | null): void {
    setDirectPaths((current) => {
      if (!path) {
        if (!(peerId in current)) {
          return current;
        }

        const next = { ...current };
        delete next[peerId];
        return next;
      }

      return {
        ...current,
        [peerId]: path,
      };
    });
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
    switch (event.type) {
      case 'room-snapshot': {
        const peerNames = Object.fromEntries(event.peers.map((peer) => [peer.clientId, peer.nickname]));
        for (const message of event.messages) {
          peerNames[message.fromId] = message.fromName;
          if (message.targetId) {
            peerNames[message.targetId] = peerNames[message.targetId] ?? message.targetId;
          }
        }
        peerNamesRef.current = peerNames;
        messagesRef.current = event.messages;
        setPeers(event.peers);
        setMessages(event.messages);
        setUnreadCounts({});
        event.peers.forEach((peer) => meshRef.current?.ensurePeer(peer));
        setNotice((current) =>
          /^正在进入房间\s+.+/.test(current)
            ? `已进入房间 ${activeRoom ?? event.roomId}。全局聊天发给整个房间，切到设备会话后就是和该设备的私聊。`
            : current,
        );
        break;
      }
      case 'peer-joined': {
        const existed = peerNamesRef.current[event.peer.clientId];
        peerNamesRef.current[event.peer.clientId] = event.peer.nickname;
        setPeers((current) => {
          const next = current.filter((peer) => peer.clientId !== event.peer.clientId);
          next.push(event.peer);
          return next.sort((left, right) => left.joinedAt - right.joinedAt);
        });
        meshRef.current?.ensurePeer(event.peer);
        if (!existed) {
          addSystemMessage(`${event.peer.nickname} 进入了房间。`);
        }
        break;
      }
      case 'peer-left': {
        const peerName = getPeerDisplayName(event.clientId, peerNamesRef.current[event.clientId]);
        delete peerNamesRef.current[event.clientId];
        setPeers((current) => current.filter((peer) => peer.clientId !== event.clientId));
        meshRef.current?.removePeer(event.clientId);
        applyPeerState(event.clientId, 'offline');
        addSystemMessage(`${peerName} 离开了房间。`);
        break;
      }
      case 'chat-event':
        addMessage(event.message);
        break;
      case 'thread-cleared': {
        const clearedThread = getThreadKeyForClearedEvent(event.targetId, event.actorId, selfId);
        clearThreadLocally(clearedThread);
        if (event.actorId === selfId) {
          setIsClearDialogOpen(false);
        } else {
          setNotice(formatThreadClearRemoteNotice(event.targetId, getPeerDisplayName(event.actorId, event.actorName)));
        }
        break;
      }
      case 'signal':
        void meshRef.current?.handleSignal(
          event.fromId,
          event.payload,
          peerNamesRef.current[event.fromId],
        );
        break;
      case 'error':
        setNotice(event.message);
        break;
      default:
        break;
    }
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
      if (!(threadKey in current)) {
        return current;
      }
      const next = { ...current };
      delete next[threadKey];
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
    setUnreadCounts({});
    setActiveRoom(normalized);
    setRoomConnectionNonce((current) => current + 1);
    setNotice(`正在进入房间 ${normalized}...`);
  }

  function setRelayAbortQueue(next: PendingRelayAbortTicket[]): void {
    relayAbortQueueRef.current = next;
    storePendingRelayAbortTickets(next);
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

  async function discardCompletedRelayUpload(uploadToken: string): Promise<void> {
    try {
      await fetch('/api/files/discard', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          uploadToken,
        } satisfies RelayDiscardUploadRequest),
      });
    } catch {
      // Best effort cleanup. If discard fails, the object remains unreachable from chat.
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

  async function flushPendingRelayAborts(): Promise<void> {
    const tickets = [...relayAbortQueueRef.current];
    for (const ticket of tickets) {
      await postRelayAbort(ticket.uploadToken);
    }
  }

  function abortRelayTask(
    task: RelayUploadTask,
    options: {
      reason: string;
      transport: 'fetch' | 'keepalive' | 'beacon';
      updateUi: boolean;
      notice?: string;
    },
  ): void {
    if (task.cancelled) {
      return;
    }

    task.cancelled = true;
    task.xhrs.forEach((xhr) => xhr.abort());
    task.xhrs.clear();
    dispatchRelayAbort(task.uploadToken, options.transport);
    relayUploadTasksRef.current.delete(task.transferId);

    if (options.updateUi) {
      updateTransfer({
        transferId: task.transferId,
        peerId: task.peerId,
        peerName: task.peerName,
        fileName: task.fileName,
        totalBytes: task.totalBytes,
        transferredBytes: transfers[task.transferId]?.transferredBytes ?? 0,
        direction: 'upload',
        transport: 'server-relay',
        status: 'cancelled',
        note: options.reason,
      });
    }

    if (options.notice) {
      showTransientNotice(options.notice, 3200);
    }
  }

  function abortAllRelayUploads(options: {
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
      abortRelayTask(task, options);
    }
  }

  async function cancelRelayUpload(transferId: string): Promise<boolean> {
    const task = relayUploadTasksRef.current.get(transferId);
    if (!task) {
      return false;
    }

    abortRelayTask(task, {
      reason: 'cancelled locally',
      transport: 'fetch',
      updateUi: true,
    });
    return true;
  }

  async function handleCancelTransfer(transfer: TransferRow): Promise<void> {
    if (transfer.transport === 'direct-p2p') {
      meshRef.current?.cancelTransfer(transfer.id);
      return;
    }

    if (transfer.transport === 'server-relay') {
      await cancelRelayUpload(transfer.id);
    }
  }

  async function relayFile(file: File, targetId: string | null, pendingAttachmentId?: string): Promise<void> {
    const roomId = activeRoom;
    if (!roomId) {
      return;
    }

    const peerId = targetId ?? GLOBAL_THREAD;
    const peerName = targetId ? getPeerDisplayName(targetId) : '整个房间';

    const uploadRequest = await fetch('/api/files/upload-request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        roomId,
        fileName: file.name,
        contentType: file.type,
        size: file.size,
        targetId,
      }),
    });

    if (!uploadRequest.ok) {
      throw new Error('upload_request_failed');
    }

    const payload = (await uploadRequest.json()) as RelayUploadResponse;
    const uploadedParts: RelayUploadPartResponse[] = [];
    const task: RelayUploadTask = {
      transferId: payload.fileId,
      fileName: file.name,
      uploadToken: payload.uploadToken,
      roomId,
      peerId,
      peerName,
      totalBytes: file.size,
      cancelled: false,
      xhrs: new Set(),
    };

    if (activeRoomRef.current !== roomId) {
      dispatchRelayAbort(task.uploadToken, 'fetch');
      return;
    }

    relayUploadTasksRef.current.set(payload.fileId, task);

    try {
      updateTransfer({
        transferId: payload.fileId,
        peerId,
        peerName,
        fileName: file.name,
        totalBytes: file.size,
        transferredBytes: 0,
        direction: 'upload',
        transport: 'server-relay',
        status: 'pending',
        note: '等待直传到中继存储',
      });
      if (pendingAttachmentId) {
        removePendingFile(pendingAttachmentId);
      }

      uploadedParts.push(
        ...(
          await uploadRelayPartsConcurrently({
            file,
            chunkSizeBytes: payload.chunkSizeBytes,
            partUrls: payload.partUrls,
            task,
            onProgress: (transferredBytes, totalParts) => {
              updateTransfer({
                transferId: payload.fileId,
                peerId,
                peerName,
                fileName: file.name,
                totalBytes: file.size,
                transferredBytes,
                direction: 'upload',
                transport: 'server-relay',
                status: 'streaming',
                note: totalParts > 1 ? `正在直传到中继存储（共 ${totalParts} 个分片）` : '正在直传到中继存储',
              });
            },
          })
        ),
      );

      if (task.cancelled) {
        return;
      }

      const completeResponse = await fetch('/api/files/complete', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          uploadToken: payload.uploadToken,
          parts: uploadedParts,
        }),
      });

      if (!completeResponse.ok) {
        throw new Error('upload_complete_failed');
      }

      if (task.cancelled) {
        return;
      }

      const completed = (await completeResponse.json()) as Pick<RelayUploadResponse, 'fileId' | 'objectKey'>;

      const canAnnounce =
        !task.cancelled &&
        activeRoomRef.current === roomId &&
        sendServerMessage({
          type: 'relay-file-announced',
          file: {
            fileId: completed.fileId,
            fileName: file.name,
            size: file.size,
            contentType: file.type || 'application/octet-stream',
            objectKey: completed.objectKey,
            targetId,
          },
        });

      if (!canAnnounce) {
        await discardCompletedRelayUpload(task.uploadToken);
        return;
      }

      updateTransfer({
        transferId: payload.fileId,
        peerId,
        peerName,
        fileName: file.name,
        totalBytes: file.size,
        transferredBytes: file.size,
        direction: 'upload',
        transport: 'server-relay',
        status: 'complete',
        note: '已同步到聊天记录',
      });
    } catch (error) {
      if (isRelayUploadCancelledError(error) || task.cancelled) {
        return;
      }
      throw error;
    } finally {
      relayUploadTasksRef.current.delete(payload.fileId);
    }
  }

  async function handleSingleFile(file: File, targetId: string | null, pendingAttachmentId?: string): Promise<void> {
    if (!session) {
      return;
    }

    const canDirect =
      targetId !== null &&
      directStates[targetId] === 'connected' &&
      file.size <= session.directFileSoftLimitBytes &&
      effectiveTransferMode !== 'relay-only';

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
        {
          id: transferId,
          roomId: activeRoom ?? 'room',
          kind: 'direct-file',
          fromId: session.clientId,
          fromName: nickname || session.nickname,
          targetId,
          createdAt: Date.now(),
          transport: 'direct-p2p',
          file: {
            fileId: transferId,
            fileName: file.name,
            size: file.size,
            contentType: file.type || 'application/octet-stream',
            objectKey: '',
            fromId: session.clientId,
            fromName: nickname || session.nickname,
            createdAt: Date.now(),
            targetId,
            previewable: file.type.startsWith('image/'),
          },
          localUrl,
        },
        false,
      );
      clearNoticeResetTimer();
      activeTransferNoticeRef.current = transferId;
      setNotice(`正在直连发送 ${file.name} 给 ${getPeerDisplayName(targetId)}。`);
      return;
    }

    await relayFile(file, targetId, pendingAttachmentId);
    if (targetId) {
      setNotice(`${file.name} 当前改走服务端中继发送给 ${getPeerDisplayName(targetId)}。`);
    } else {
      setNotice(`${file.name} 已作为房间文件发送。`);
    }
  }

  async function handleSend(): Promise<void> {
    if (!selfId || !activeRoom || isSending) {
      return;
    }

    const text = composer.trim();
    const files = [...pendingFiles];
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
    const removed = messagesRef.current.filter((message) => getMessageThreadKey(message, selfId) === threadId);
    for (const message of removed) {
      releaseObjectUrl(message.localUrl);
    }

    const next = messagesRef.current.filter((message) => getMessageThreadKey(message, selfId) !== threadId);
    messagesRef.current = next;
    setMessages(next);
    setUnreadCounts((current) => {
      if (!(threadId in current)) {
        return current;
      }
      const copy = { ...current };
      delete copy[threadId];
      return copy;
    });
    setTransfers((current) =>
      Object.fromEntries(Object.entries(current).filter(([, transfer]) => transfer.peerId !== threadId)),
    );
  }

  function formatThreadClearSuccessNotice(
    targetId: string | null,
    removedMessages: number,
    removedRelayFiles: number,
  ): string {
    const base = targetId
      ? `已清空与 ${getPeerDisplayName(targetId)} 的私聊记录`
      : '已清空当前房间的全局聊天记录';
    const relayInfo =
      removedRelayFiles > 0 ? `，并回收 ${removedRelayFiles} 个失去引用的中继文件` : '';

    if (removedMessages > 0) {
      return `${base}${relayInfo}。`;
    }

    return `${base}。当前没有可删除的云端消息，已一并清掉本地直传记录和进度面板。`;
  }

  function formatThreadClearRemoteNotice(targetId: string | null, actorName: string): string {
    return targetId
      ? `${actorName} 清空了这条私聊记录。`
      : `${actorName} 清空了当前房间的全局聊天记录。`;
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
      setNotice(formatThreadClearSuccessNotice(payload.targetId, payload.removedMessages, payload.removedRelayFiles));
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
      ? '自动：优先尝试直连，失败时再回退到中继。'
      : transferModeTooltip === 'relay-only'
        ? '中继：不尝试直连，文件直接走云端中继。'
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

          <div ref={messagesViewportRef} className="flex-1 overflow-y-auto bg-[#eff6ff] px-3 py-3 sm:px-4 sm:py-4">
            {filteredMessages.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-8 shadow-sm">
                <div className="text-lg font-semibold text-slate-900">
                  {activeThread === GLOBAL_THREAD ? '这个房间还没有消息' : '这个设备会话还没有记录'}
                </div>
                <div className="mt-2 text-sm leading-7 text-slate-500">
                  {activeThread === GLOBAL_THREAD
                    ? '发一条文字试试，或者把文件拖进页面底部的发送区域。'
                    : '给这个设备发一条私聊消息，或者直接发送文件，相关记录都会显示在这里。'}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:gap-4">
                {filteredMessages.map((message) => {
                  if (message.kind === 'system') {
                    return (
                      <div key={message.id} className="flex flex-col items-center gap-1 py-1 text-center">
                        <div className="rounded-full bg-white/80 px-3 py-1 text-xs text-slate-500 shadow-sm">
                          {message.text}
                        </div>
                        <span className="text-[11px] text-slate-400">{formatClockTime(message.createdAt)}</span>
                      </div>
                    );
                  }

                  const isMine = message.fromId === selfId;
                  const senderName = isMine ? 'Me' : getPeerDisplayName(message.fromId, message.fromName);
                  const isImage = Boolean(message.file?.previewable);
                  const imageSrc = isImage
                    ? message.localUrl ??
                      (activeRoom && message.file ? `/api/files/${activeRoom}/${message.file.fileId}/access` : undefined)
                    : undefined;
                  const downloadUrl = message.savedToDisk
                    ? undefined
                    : message.localUrl
                      ? message.localUrl
                      : message.kind === 'relay-file' && activeRoom && message.file
                        ? `/api/files/${activeRoom}/${message.file.fileId}/access`
                        : undefined;
                  const canCopyMessage = Boolean(message.text) || (isImage && Boolean(imageSrc));

                  return (
                    <div
                      key={message.id}
                      className={cn(
                        'group flex message-slide-in',
                        isMine ? 'self-end max-w-[85%] sm:max-w-[75%]' : 'self-start max-w-[85%] gap-2 sm:max-w-[75%]',
                      )}
                    >
                      {!isMine ? (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-200 text-xs font-semibold text-slate-700">
                          {getInitials(senderName)}
                        </div>
                      ) : null}

                      <div className={cn('flex flex-col gap-1', isMine ? 'items-end' : 'items-start')}>
                        {!isMine ? <span className="px-3 text-xs font-medium text-slate-600">{senderName}</span> : null}

                        <div className="max-w-full">
                          <div
                            className={cn(
                              'max-w-full overflow-hidden whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed shadow-sm',
                              isMine
                                ? 'rounded-br-md bg-blue-600 text-white'
                                : 'rounded-bl-md border border-slate-200 bg-white text-slate-900',
                            )}
                            style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                          >
                            {message.text ? <span>{message.text}</span> : null}

                            {message.file ? (
                              <div className="space-y-3">
                                <div
                                  className={cn(
                                    'flex items-start gap-3 rounded-lg p-3',
                                    isMine ? 'bg-white/10' : 'bg-slate-50',
                                  )}
                                >
                                  <div
                                    className={cn(
                                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                                      isMine ? 'bg-white/10 text-white' : 'bg-slate-200 text-slate-600',
                                    )}
                                  >
                                    {isImage ? <ImageIcon className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-medium">{message.file.fileName}</div>
                                    <div className={cn('mt-1 text-xs', isMine ? 'text-white/70' : 'text-slate-500')}>
                                      {formatBytes(message.file.size)} · 传输方式：{transportLabel(message.transport)}
                                    </div>
                                    <div className="mt-2">
                                      <Badge
                                        className={cn(
                                          'h-5 px-2 text-[10px]',
                                          isMine ? 'border-white/20 bg-white/10 text-white' : transportBadgeTone(message.transport),
                                        )}
                                      >
                                        {transportLabel(message.transport)}
                                      </Badge>
                                    </div>
                                    {message.savedToDisk ? (
                                      <div className={cn('mt-2 text-xs', isMine ? 'text-emerald-100' : 'text-emerald-700')}>
                                        文件已直接写入接收目录
                                      </div>
                                    ) : null}
                                  </div>
                                </div>

                                {imageSrc ? (
                                  <img
                                    src={imageSrc}
                                    alt={message.file.fileName}
                                    className="max-h-80 w-auto max-w-full cursor-zoom-in rounded-lg object-contain"
                                    onClick={() => setPreviewImage(imageSrc)}
                                  />
                                ) : null}

                                {downloadUrl ? (
                                  <a
                                    href={downloadUrl}
                                    download={message.file.fileName}
                                    className={cn(
                                      'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold transition-all',
                                      isMine
                                        ? 'border-white/15 bg-white/10 text-white hover:bg-white/20'
                                        : 'border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50',
                                    )}
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                    下载文件
                                  </a>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 px-1">
                          <span className="px-2 text-[11px] text-slate-500">{formatClockTime(message.createdAt)}</span>
                          {canCopyMessage ? (
                            <button
                              type="button"
                              onClick={() => void handleCopyMessage(message, imageSrc)}
                              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-slate-200 bg-white/85 px-2.5 text-[11px] font-semibold text-slate-600 shadow-sm backdrop-blur transition-all hover:border-slate-300 hover:bg-white hover:text-slate-900"
                              title="复制消息"
                            >
                              {copiedMessageId === message.id ? (
                                <>
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                                  <span>已复制</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5" />
                                  <span>复制</span>
                                </>
                              )}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {transferRows.length > 0 ? (
            <div className="border-t border-slate-200 bg-white px-4 py-3">
              {transferRows.map((transfer) => {
                const percent =
                  transfer.totalBytes > 0
                    ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100))
                    : 0;
                const isDone = transfer.status === 'complete';
                const isFailed = transfer.status === 'failed' || transfer.status === 'declined';
                const canCancel = transfer.status === 'pending' || transfer.status === 'streaming';

                return (
                  <div key={transfer.id} className="mb-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <div
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-lg text-white',
                            transfer.direction === 'upload' ? 'bg-slate-900' : 'bg-emerald-600',
                          )}
                        >
                          {transfer.direction === 'upload' ? (
                            <Upload className="h-4 w-4" />
                          ) : (
                            <FolderOpen className="h-4 w-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{transfer.fileName}</span>
                            <Badge className="h-4 border-slate-200 bg-slate-50 px-1.5 text-[10px] text-slate-600">
                              {transfer.direction === 'upload' ? '→' : '←'} {transfer.peerName}
                            </Badge>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {formatBytes(transfer.transferredBytes)} / {formatBytes(transfer.totalBytes)}
                            {transfer.status === 'streaming' && formatTransferSpeed(transfer.speedBytesPerSecond)
                              ? ` · ${formatTransferSpeed(transfer.speedBytesPerSecond)}`
                              : ''}
                            {' · '}
                            {formatTransferNote(transfer.note) ?? transferStatusLabel(transfer.status)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {canCancel ? (
                          <button
                            type="button"
                            onClick={() => void handleCancelTransfer(transfer)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 shadow-sm transition-all hover:border-slate-300 hover:bg-white hover:text-slate-900"
                            title="取消传输"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        ) : null}
                        <Badge className={cn('h-5 px-2 text-[10px]', transportBadgeTone(transfer.transport))}>
                          {transportLabel(transfer.transport)}
                        </Badge>
                        {isDone ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                        ) : isFailed ? (
                          <Badge className="border-rose-200 bg-rose-50 text-rose-700">
                            {transferStatusLabel(transfer.status)}
                          </Badge>
                        ) : (
                          <LoaderCircle className="h-5 w-5 animate-spin text-slate-700" />
                        )}
                        <span className="ml-1 text-xs font-semibold text-slate-900">
                          {transfer.status === 'pending' ? '等待' : `${percent}%`}
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={cn('h-full transition-all duration-300', isFailed ? 'bg-rose-500' : 'bg-slate-900')}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="border-t border-slate-200 bg-white">
            {pendingFiles.length > 0 ? (
              <div className="flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
                {pendingFiles.map((item) => (
                  <div
                    key={item.id}
                    className="relative inline-flex max-w-[240px] items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 pr-12 shadow-sm"
                  >
                    {item.previewUrl ? (
                      <div className="relative">
                        <img src={item.previewUrl} alt={item.file.name} className="h-10 w-10 rounded-xl object-cover" />
                        <ImageIcon className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded bg-black/55 p-0.5 text-white" />
                      </div>
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                        <FileText className="h-6 w-6" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-slate-900">{item.file.name}</div>
                      <div className="mt-0.5 text-xs text-slate-500">{formatBytes(item.file.size)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removePendingFile(item.id)}
                      className="absolute right-3 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 shadow-sm transition-all hover:border-slate-300 hover:bg-white hover:text-slate-900"
                      title="移除"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="flex items-end gap-2 px-3 py-3 sm:px-4">
              <label className="group inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[16px] border border-slate-200 bg-white text-slate-700 shadow-[0_8px_18px_rgba(15,23,42,0.07)] transition-all hover:border-slate-300 hover:bg-slate-50 hover:shadow-[0_12px_24px_rgba(15,23,42,0.12)]">
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    const files = event.target.files ? Array.from(event.target.files) : [];
                    appendPendingFiles(files);
                    event.target.value = '';
                  }}
                  title="发送文件"
                />
                <div className="pointer-events-none inline-flex h-full w-full items-center justify-center rounded-[16px]">
                  <Paperclip className="h-[22px] w-[22px]" />
                </div>
              </label>

              <div className="relative">
                <div
                  className={cn(
                    'relative inline-grid h-10 w-[134px] grid-cols-2 items-center rounded-full border border-slate-200 bg-slate-100 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_18px_rgba(15,23,42,0.05)] transition-colors',
                    !canToggleTransferMode && 'opacity-95',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'pointer-events-none absolute inset-y-1 w-[calc(50%-4px)] rounded-full border border-slate-900 bg-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.14),0_8px_18px_rgba(15,23,42,0.18)] transition-[left] duration-200 ease-out',
                      !canToggleTransferMode && 'shadow-[0_1px_2px_rgba(15,23,42,0.1),0_6px_14px_rgba(15,23,42,0.14)]',
                    )}
                    style={{
                      left: effectiveTransferMode === 'relay-only' ? 'calc(50% + 2px)' : '4px',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      clearTransferModeTooltip();
                      if (canToggleTransferMode) {
                        setTransferMode('auto');
                      }
                    }}
                    onMouseEnter={() => scheduleTransferModeTooltip('auto')}
                    onMouseLeave={clearTransferModeTooltip}
                    onFocus={() => scheduleTransferModeTooltip('auto')}
                    onBlur={clearTransferModeTooltip}
                    disabled={!canToggleTransferMode}
                    className={cn(
                      'relative z-10 inline-flex h-8 items-center justify-center rounded-full border border-transparent px-0 text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed',
                      effectiveTransferMode === 'auto'
                        ? 'text-white'
                        : canToggleTransferMode
                          ? 'text-slate-600 hover:text-slate-900'
                          : 'text-slate-500',
                    )}
                  >
                    自动
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearTransferModeTooltip();
                      if (canToggleTransferMode) {
                        setTransferMode('relay-only');
                      }
                    }}
                    onMouseEnter={() => scheduleTransferModeTooltip('relay-only')}
                    onMouseLeave={clearTransferModeTooltip}
                    onFocus={() => scheduleTransferModeTooltip('relay-only')}
                    onBlur={clearTransferModeTooltip}
                    disabled={!canToggleTransferMode}
                    className={cn(
                      'relative z-10 inline-flex h-8 items-center justify-center rounded-full border border-transparent px-0 text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed',
                      effectiveTransferMode === 'relay-only'
                        ? 'text-white'
                        : canToggleTransferMode
                          ? 'text-slate-600 hover:text-slate-900'
                          : 'text-slate-500',
                    )}
                  >
                    中继
                  </button>
                </div>
                {transferModeTooltip ? (
                  <div
                    className={cn(
                      'pointer-events-none absolute bottom-[calc(100%+14px)] z-20 max-w-[240px] rounded-2xl border border-slate-200 bg-white/95 px-3.5 py-2.5 text-[13px] leading-5 text-slate-600 shadow-[0_18px_40px_rgba(15,23,42,0.12)] backdrop-blur-md',
                      transferModeTooltip === 'relay-only' ? 'right-0' : 'left-0',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute top-full h-3 w-3 -translate-y-1/2 rotate-45 border-b border-r border-slate-200 bg-white/95',
                        transferModeTooltip === 'relay-only' ? 'right-8' : 'left-8',
                      )}
                    />
                    {transferModeTooltipText}
                  </div>
                ) : null}
              </div>

              <textarea
                ref={composerRef}
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onPaste={handlePaste}
                onKeyDown={handleComposerKeyDown}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                rows={1}
                placeholder={
                  activePeerId
                    ? `给 ${getPeerDisplayName(activePeerId)} 发私聊消息，或直接发送文件`
                    : '输入房间消息...'
                }
                className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2 py-[11px] text-[15px] leading-6 outline-none placeholder:text-slate-400"
              />

              <Button
                onClick={() => void handleSend()}
                variant="secondary"
                className="h-11 min-w-[52px] shrink-0 rounded-2xl border-0 bg-slate-900 px-3 text-white shadow-[0_16px_30px_rgba(15,23,42,0.18)] ring-0 transition-all hover:bg-slate-800 hover:shadow-[0_18px_34px_rgba(15,23,42,0.24)] disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none sm:min-w-[92px] sm:px-4"
                disabled={isSending || (!composer.trim() && pendingFiles.length === 0) || socketStatus !== 'connected'}
              >
                <span className="flex items-center gap-2">
                  <Send className="h-4 w-4" />
                  <span className="hidden text-sm font-semibold sm:inline">发送</span>
                </span>
              </Button>
            </div>

            <div className="border-t border-slate-200 bg-white px-4 py-2 text-xs text-slate-500">{notice}</div>
          </div>
        </section>
      </div>

      {previewImage ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setPreviewImage(null)}
        >
          <img src={previewImage} alt="Preview" className="max-h-full max-w-full object-contain" />
        </div>
      ) : null}

      {isClearDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => {
            if (!isClearingThread) {
              setIsClearDialogOpen(false);
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-slate-900">
                  {activePeerId ? `清空与 ${getPeerDisplayName(activePeerId)} 的私聊？` : '清空当前房间的全局聊天？'}
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {activePeerId
                    ? `这会删除你与 ${getPeerDisplayName(activePeerId)} 的私聊文字、定向文件和本地直传记录，对当前在线双方立即生效；失去引用的服务端中继文件会一起清理。`
                    : '这会删除当前房间的全局文字记录和房间共享文件，对房间内所有在线成员立即生效；失去引用的服务端中继文件也会一起清理。'}
                </p>
                <p className="mt-2 text-xs text-slate-500">这个操作不可恢复。</p>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button
                onClick={() => setIsClearDialogOpen(false)}
                variant="secondary"
                size="sm"
                disabled={isClearingThread}
              >
                取消
              </Button>
              <Button
                onClick={() => void handleConfirmClearCurrentThread()}
                size="sm"
                className="bg-rose-600 text-white hover:bg-rose-600/90"
                disabled={isClearingThread}
              >
                {isClearingThread ? '清空中...' : '确认清空'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {isEditingNickname ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setIsEditingNickname(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-semibold">设置昵称</h3>
            <Input
              type="text"
              value={nicknameDraft}
              onChange={(event) => setNicknameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleSaveNickname();
                }
              }}
              placeholder="输入昵称..."
              autoFocus
              className="mb-4"
            />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setIsEditingNickname(false)} variant="secondary" size="sm">
                取消
              </Button>
              <Button onClick={() => void handleSaveNickname()} size="sm" className="bg-[#1e3a8a] text-white hover:bg-[#1e3a8a]/90">
                保存
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
