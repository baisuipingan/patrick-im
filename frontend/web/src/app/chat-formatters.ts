import type { ChatMessage, DirectPeerState, TransferMode } from '@shared/protocol';
import type { PeerPresenceStatus, SocketStatus, TransferRow } from '@/app/types';
import { formatBytes } from '@/lib/utils';

const GLOBAL_THREAD = '__global__';

export function socketStatusLabel(status: SocketStatus): string {
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

export function socketStatusTone(status: SocketStatus): string {
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

export function socketStatusDotTone(status: SocketStatus): string {
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

export function getPeerPresenceStatus(
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

export function peerSignalLabel(status: PeerPresenceStatus): string {
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

export function peerStateLabel(state: DirectPeerState | undefined): string {
  switch (state) {
    case 'connected':
      return '局域网直连';
    default:
      return '中继模式';
  }
}

export function directPathLabel(path?: { kind?: 'lan' | 'stun' | 'turn' | 'unknown' } | null): string {
  switch (path?.kind) {
    case 'lan':
      return '局域网直连';
    case 'stun':
      return '公网直连';
    case 'turn':
      return '中继';
    case 'unknown':
      return '局域网直连';
    default:
      return '识别中';
  }
}

export function directPathDescription(path?: { kind?: 'lan' | 'stun' | 'turn' | 'unknown' } | null): string {
  switch (path?.kind) {
    case 'lan':
      return '当前是局域网 WebRTC 直连。';
    case 'stun':
      return '当前是 STUN 打洞后的 WebRTC 直连，数据不经过中继服务器。';
    case 'turn':
      return '当前实际经过中继链路，这种情况通常会慢很多。';
    case 'unknown':
      return '当前未建立局域网直连，发送文件时会走中继。';
    default:
      return '当前未建立局域网直连，发送文件时会走中继。';
  }
}

export function candidateTypeLabel(type?: string): string {
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

export function candidateAddressLabel(side: '本地' | '远端', type?: string, address?: string): string {
  if (address) {
    return `${side} ${address}`;
  }

  if (type === 'host') {
    return `${side} 浏览器已隐藏`;
  }

  return `${side} -`;
}

export function peerDotTone(state: DirectPeerState | undefined, presence: PeerPresenceStatus): string {
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

export function peerBadgeTone(state: DirectPeerState | undefined): string {
  switch (state) {
    case 'connected':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700';
  }
}

export function transferStatusLabel(status: TransferRow['status']): string {
  switch (status) {
    case 'pending':
      return '等待中';
    case 'paused':
      return '已暂停';
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

export function transportLabel(transport: ChatMessage['transport'] | TransferRow['transport']): string {
  switch (transport) {
    case 'direct-p2p':
      return '局域网直连';
    case 'server-relay':
      return '中继';
    case 'server-sync':
      return '聊天同步';
    default:
      return transport;
  }
}

export function transportBadgeTone(transport: ChatMessage['transport'] | TransferRow['transport']): string {
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

export function formatTransferNote(note?: string): string | undefined {
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
    case '已暂停，可继续':
      return '已暂停，可继续';
    case '网络已断开，上传已暂停，恢复后可继续':
      return '网络中断，已暂停';
    default:
      return note;
  }
}

export function formatTransferSpeed(speedBytesPerSecond?: number): string | undefined {
  if (!speedBytesPerSecond || !Number.isFinite(speedBytesPerSecond) || speedBytesPerSecond <= 0) {
    return undefined;
  }

  return `${formatBytes(speedBytesPerSecond)}/s`;
}

export function getMessageThreadKey(message: ChatMessage, selfId?: string): string {
  if (!selfId) {
    return message.targetId ?? GLOBAL_THREAD;
  }

  if (!message.targetId) {
    return GLOBAL_THREAD;
  }

  return message.fromId === selfId ? message.targetId : message.fromId;
}

export function summarizeMessage(message: ChatMessage): string {
  if (message.text) {
    return message.text;
  }

  if (message.file) {
    return message.file.previewable ? `[图片] ${message.file.fileName}` : `[文件] ${message.file.fileName}`;
  }

  return '新消息';
}

export function getThreadKeyForClearedEvent(
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

export function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase() || '??';
}

export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function formatAgo(timestamp: number): string {
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
