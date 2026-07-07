import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function RoomPicker({
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
