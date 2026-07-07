import type { ClipboardEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  Pause,
  Play,
  Send,
  Upload,
  X,
} from 'lucide-react';
import type { DirectPeerState, TransferMode } from '@shared/protocol';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn, formatBytes } from '@/lib/utils';
import type { PendingAttachment, SocketStatus, TransferRow, UiMessage } from '@/app/types';

export function MessageList({
  activeRoom,
  activeThread,
  globalThread,
  filteredMessages,
  selfId,
  copiedMessageId,
  onPreviewImage,
  onCopyMessage,
  getPeerDisplayName,
  getInitials,
  formatClockTime,
  summarizeMessageTransport,
  transportBadgeTone,
  messagesViewportRef,
}: {
  activeRoom: string | null;
  activeThread: string;
  globalThread: string;
  filteredMessages: UiMessage[];
  selfId?: string;
  copiedMessageId: string | null;
  onPreviewImage: (url: string) => void;
  onCopyMessage: (message: UiMessage, imageUrl?: string) => Promise<void>;
  getPeerDisplayName: (peerId: string, fallback?: string) => string;
  getInitials: (name: string) => string;
  formatClockTime: (timestamp: number) => string;
  summarizeMessageTransport: (transport: UiMessage['transport']) => string;
  transportBadgeTone: (transport: UiMessage['transport']) => string;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={messagesViewportRef} className="flex-1 overflow-y-auto bg-[#eff6ff] px-3 py-3 sm:px-4 sm:py-4">
      {filteredMessages.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-8 shadow-sm">
          <div className="text-lg font-semibold text-slate-900">
            {activeThread === globalThread ? '这个房间还没有消息' : '这个设备会话还没有记录'}
          </div>
          <div className="mt-2 text-sm leading-7 text-slate-500">
            {activeThread === globalThread
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
                (message.file ? `/api/files/${message.file.fileId}` : undefined)
              : undefined;
            const downloadUrl = message.savedToDisk
              ? undefined
              : message.localUrl
                ? message.localUrl
                : message.kind === 'relay-file' && message.file
                  ? `/api/files/${message.file.fileId}`
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
                                {formatBytes(message.file.size)} · 传输方式：{summarizeMessageTransport(message.transport)}
                              </div>
                              <div className="mt-2">
                                <Badge
                                  className={cn(
                                    'h-5 px-2 text-[10px]',
                                    isMine
                                      ? 'border-white/20 bg-white/10 text-white'
                                      : transportBadgeTone(message.transport),
                                  )}
                                >
                                  {summarizeMessageTransport(message.transport)}
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
                              onClick={() => onPreviewImage(imageSrc)}
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
                        onClick={() => void onCopyMessage(message, imageSrc)}
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
  );
}

export function TransferPanel({
  transferRows,
  getRelayTaskState,
  onPauseTransfer,
  onResumeTransfer,
  onCancelTransfer,
  transportBadgeTone,
  transportLabel,
  formatTransferSpeed,
  formatTransferNote,
  transferStatusLabel,
}: {
  transferRows: TransferRow[];
  getRelayTaskState: (transferId: string) => 'uploading' | 'paused' | 'completing' | 'awaiting-sync' | 'failed' | null;
  onPauseTransfer: (transfer: TransferRow) => Promise<void>;
  onResumeTransfer: (transfer: TransferRow) => Promise<void>;
  onCancelTransfer: (transfer: TransferRow) => Promise<void>;
  transportBadgeTone: (transport: TransferRow['transport']) => string;
  transportLabel: (transport: TransferRow['transport']) => string;
  formatTransferSpeed: (speedBytesPerSecond?: number) => string | undefined;
  formatTransferNote: (note?: string) => string | undefined;
  transferStatusLabel: (status: TransferRow['status']) => string;
}) {
  if (transferRows.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3">
      {transferRows.map((transfer) => {
        const relayTaskState = getRelayTaskState(transfer.id);
        const percent =
          transfer.totalBytes > 0 ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100)) : 0;
        const isDone = transfer.status === 'complete';
        const isFailed = transfer.status === 'failed' || transfer.status === 'declined';
        const isPaused = transfer.status === 'paused';
        const canPause =
          transfer.transport === 'server-relay' &&
          transfer.direction === 'upload' &&
          transfer.status === 'streaming' &&
          relayTaskState === 'uploading';
        const canResume =
          transfer.transport === 'server-relay' &&
          transfer.direction === 'upload' &&
          transfer.status === 'paused' &&
          relayTaskState === 'paused';
        const canCancel =
          transfer.status === 'pending' || transfer.status === 'streaming' || transfer.status === 'paused';

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
                {canPause ? (
                  <button
                    type="button"
                    onClick={() => void onPauseTransfer(transfer)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 shadow-sm transition-all hover:border-slate-300 hover:bg-white hover:text-slate-900"
                    title="暂停传输"
                  >
                    <Pause className="h-4 w-4" />
                  </button>
                ) : null}
                {canResume ? (
                  <button
                    type="button"
                    onClick={() => void onResumeTransfer(transfer)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 shadow-sm transition-all hover:border-slate-300 hover:bg-white hover:text-slate-900"
                    title="继续传输"
                  >
                    <Play className="h-4 w-4" />
                  </button>
                ) : null}
                {canCancel ? (
                  <button
                    type="button"
                    onClick={() => void onCancelTransfer(transfer)}
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
                  <Badge className="border-rose-200 bg-rose-50 text-rose-700">{transferStatusLabel(transfer.status)}</Badge>
                ) : isPaused ? (
                  <Pause className="h-5 w-5 text-slate-500" />
                ) : (
                  <LoaderCircle className="h-5 w-5 animate-spin text-slate-700" />
                )}
                <span className="ml-1 text-xs font-semibold text-slate-900">
                  {transfer.status === 'pending' ? '等待' : transfer.status === 'paused' ? '暂停' : `${percent}%`}
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
  );
}

export function ComposerPanel({
  pendingFiles,
  composer,
  isComposing,
  activePeerId,
  canToggleTransferMode,
  effectiveTransferMode,
  isSending,
  notice,
  socketStatus,
  transferModeTooltip,
  transferModeTooltipText,
  composerRef,
  onRemovePendingFile,
  onAppendPendingFiles,
  onSetTransferMode,
  onScheduleTransferModeTooltip,
  onClearTransferModeTooltip,
  onComposerChange,
  onPaste,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onSend,
  getPeerDisplayName,
}: {
  pendingFiles: PendingAttachment[];
  composer: string;
  isComposing: boolean;
  activePeerId: string | null;
  canToggleTransferMode: boolean;
  effectiveTransferMode: TransferMode;
  isSending: boolean;
  notice: string;
  socketStatus: SocketStatus;
  transferModeTooltip: TransferMode | null;
  transferModeTooltipText: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onRemovePendingFile: (id: string) => void;
  onAppendPendingFiles: (files: File[]) => void;
  onSetTransferMode: (mode: TransferMode) => void;
  onScheduleTransferModeTooltip: (mode: TransferMode) => void;
  onClearTransferModeTooltip: () => void;
  onComposerChange: (value: string) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onSend: () => void;
  getPeerDisplayName: (peerId: string, fallback?: string) => string;
}) {
  return (
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
                onClick={() => onRemovePendingFile(item.id)}
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
              onAppendPendingFiles(files);
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
                onClearTransferModeTooltip();
                if (canToggleTransferMode) {
                  onSetTransferMode('auto');
                }
              }}
              onMouseEnter={() => onScheduleTransferModeTooltip('auto')}
              onMouseLeave={onClearTransferModeTooltip}
              onFocus={() => onScheduleTransferModeTooltip('auto')}
              onBlur={onClearTransferModeTooltip}
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
                onClearTransferModeTooltip();
                if (canToggleTransferMode) {
                  onSetTransferMode('relay-only');
                }
              }}
              onMouseEnter={() => onScheduleTransferModeTooltip('relay-only')}
              onMouseLeave={onClearTransferModeTooltip}
              onFocus={() => onScheduleTransferModeTooltip('relay-only')}
              onBlur={onClearTransferModeTooltip}
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
          onChange={(event) => onComposerChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          rows={1}
          placeholder={activePeerId ? `给 ${getPeerDisplayName(activePeerId)} 发私聊消息，或直接发送文件` : '输入房间消息...'}
          className="min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2 py-[11px] text-[15px] leading-6 outline-none placeholder:text-slate-400"
          data-composing={isComposing ? 'true' : 'false'}
        />

        <Button
          onClick={onSend}
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
  );
}
