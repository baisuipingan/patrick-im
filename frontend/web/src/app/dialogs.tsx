import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ImagePreviewDialog({
  previewImage,
  onClose,
}: {
  previewImage: string | null;
  onClose: () => void;
}) {
  if (!previewImage) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4" onClick={onClose}>
      <img src={previewImage} alt="Preview" className="max-h-full max-w-full object-contain" />
    </div>
  );
}

export function ClearThreadDialog({
  open,
  isClearingThread,
  activePeerId,
  activePeerName,
  onClose,
  onConfirm,
}: {
  open: boolean;
  isClearingThread: boolean;
  activePeerId: string | null;
  activePeerName: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => {
        if (!isClearingThread) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
            <Trash2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-slate-900">
              {activePeerId ? `清空与 ${activePeerName} 的私聊？` : '清空当前房间的全局聊天？'}
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {activePeerId
                ? `这会删除你与 ${activePeerName} 的私聊文字、定向文件和本地直传记录，对当前在线双方立即生效；失去引用的服务端中继文件会一起清理。`
                : '这会删除当前房间的全局文字记录和房间共享文件，对房间内所有在线成员立即生效；失去引用的服务端中继文件也会一起清理。'}
            </p>
            <p className="mt-2 text-xs text-slate-500">这个操作不可恢复。</p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary" size="sm" disabled={isClearingThread}>
            取消
          </Button>
          <Button
            onClick={onConfirm}
            size="sm"
            className="bg-rose-600 text-white hover:bg-rose-600/90"
            disabled={isClearingThread}
          >
            {isClearingThread ? '清空中...' : '确认清空'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function EditNicknameDialog({
  open,
  nicknameDraft,
  onNicknameDraftChange,
  onClose,
  onSave,
}: {
  open: boolean;
  nicknameDraft: string;
  onNicknameDraftChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <h3 className="mb-4 text-lg font-semibold">设置昵称</h3>
        <Input
          type="text"
          value={nicknameDraft}
          onChange={(event) => onNicknameDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onSave();
            }
          }}
          placeholder="输入昵称..."
          autoFocus
          className="mb-4"
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary" size="sm">
            取消
          </Button>
          <Button onClick={onSave} size="sm" className="bg-[#1e3a8a] text-white hover:bg-[#1e3a8a]/90">
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
