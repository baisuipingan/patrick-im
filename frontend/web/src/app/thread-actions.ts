import { getMessageThreadKey } from '@/app/chat-formatters';
import type { TransferRow, UiMessage } from '@/app/types';

export function clearThreadMessages(options: {
  messages: UiMessage[];
  selfId: string | undefined;
  threadId: string;
  releaseObjectUrl: (url?: string) => void;
}): UiMessage[] {
  const { messages, selfId, threadId, releaseObjectUrl } = options;
  const removed = messages.filter((message) => getMessageThreadKey(message, selfId) === threadId);
  for (const message of removed) {
    releaseObjectUrl(message.localUrl);
  }

  return messages.filter((message) => getMessageThreadKey(message, selfId) !== threadId);
}

export function clearThreadTransfers(threadId: string, transfers: Record<string, TransferRow>): Record<string, TransferRow> {
  return Object.fromEntries(Object.entries(transfers).filter(([, transfer]) => transfer.peerId !== threadId));
}

export function formatThreadClearSuccessNotice(options: {
  targetId: string | null;
  removedMessages: number;
  removedRelayFiles: number;
  getPeerDisplayName: (peerId: string) => string;
}): string {
  const { targetId, removedMessages, removedRelayFiles, getPeerDisplayName } = options;
  const base = targetId ? `已清空与 ${getPeerDisplayName(targetId)} 的私聊记录` : '已清空当前房间的全局聊天记录';
  const relayInfo = removedRelayFiles > 0 ? `，并回收 ${removedRelayFiles} 个失去引用的中继文件` : '';

  if (removedMessages > 0) {
    return `${base}${relayInfo}。`;
  }

  return `${base}。当前没有可删除的云端消息，已一并清掉本地直传记录和进度面板。`;
}

export function formatThreadClearRemoteNotice(targetId: string | null, actorName: string): string {
  return targetId ? `${actorName} 清空了这条私聊记录。` : `${actorName} 清空了当前房间的全局聊天记录。`;
}
