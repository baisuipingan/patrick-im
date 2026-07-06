package realtime

import (
	"encoding/json"
	"sync"

	"github.com/google/uuid"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

const ClientQueueCapacity = 256

type ClientTx struct {
	send chan []byte
	once sync.Once
}

func NewClientTx() *ClientTx {
	return &ClientTx{send: make(chan []byte, ClientQueueCapacity)}
}

func (tx *ClientTx) Send(message []byte) bool {
	select {
	case tx.send <- message:
		return true
	default:
		tx.Close()
		return false
	}
}

func (tx *ClientTx) Close() {
	tx.once.Do(func() {
		close(tx.send)
	})
}

func (tx *ClientTx) C() <-chan []byte {
	return tx.send
}

type peerSession struct {
	ConnectionID string
	ClientID     string
	Nickname     string
	JoinedAt     uint64
	LastSeenAt   uint64
	Tx           *ClientTx
}

type roomRuntime struct {
	Peers map[string]*peerSession
}

type JoinResult struct {
	ConnectionID string
	Peers        []protocol.RoomPeer
	JoinedPeer   protocol.RoomPeer
	ReplacedTx   *ClientTx
}

type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*roomRuntime
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]*roomRuntime{}}
}

func (h *Hub) JoinRoom(roomID, clientID, nickname string, tx *ClientTx) JoinResult {
	joinedAt := util.NowMS()
	connectionID := uuid.NewString()
	fallback := clientID
	if len(fallback) > 4 {
		fallback = fallback[:4]
	}
	sanitized := util.SanitizeNickname(nickname, fallback)

	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[roomID]
	if room == nil {
		room = &roomRuntime{Peers: map[string]*peerSession{}}
		h.rooms[roomID] = room
	}
	var replaced *ClientTx
	if current := room.Peers[clientID]; current != nil {
		replaced = current.Tx
	}
	room.Peers[clientID] = &peerSession{
		ConnectionID: connectionID,
		ClientID:     clientID,
		Nickname:     sanitized,
		JoinedAt:     joinedAt,
		LastSeenAt:   joinedAt,
		Tx:           tx,
	}
	peers := make([]protocol.RoomPeer, 0, len(room.Peers)-1)
	for id, peer := range room.Peers {
		if id == clientID {
			continue
		}
		peers = append(peers, protocol.RoomPeer{ClientID: peer.ClientID, Nickname: peer.Nickname, JoinedAt: peer.JoinedAt})
	}
	return JoinResult{
		ConnectionID: connectionID,
		Peers:        peers,
		JoinedPeer: protocol.RoomPeer{
			ClientID: clientID,
			Nickname: sanitized,
			JoinedAt: joinedAt,
		},
		ReplacedTx: replaced,
	}
}

func (h *Hub) IsCurrentConnection(roomID, clientID, connectionID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.rooms[roomID]
	if room == nil || room.Peers[clientID] == nil {
		return false
	}
	return room.Peers[clientID].ConnectionID == connectionID
}

func (h *Hub) IsClientConnected(roomID, clientID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.rooms[roomID]
	return room != nil && room.Peers[clientID] != nil
}

func (h *Hub) DisplayNameFor(roomID, clientID string) (string, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.rooms[roomID]
	if room == nil || room.Peers[clientID] == nil {
		return "", false
	}
	return room.Peers[clientID].Nickname, true
}

func (h *Hub) Touch(roomID, clientID, connectionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[roomID]
	if room == nil || room.Peers[clientID] == nil {
		return
	}
	if room.Peers[clientID].ConnectionID == connectionID {
		room.Peers[clientID].LastSeenAt = util.NowMS()
	}
}

func (h *Hub) RenamePeer(roomID, clientID, connectionID, nickname string) (*protocol.RoomPeer, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[roomID]
	if room == nil || room.Peers[clientID] == nil {
		return nil, false
	}
	peer := room.Peers[clientID]
	if peer.ConnectionID != connectionID {
		return nil, false
	}
	next := util.SanitizeNickname(nickname, peer.Nickname)
	peer.LastSeenAt = util.NowMS()
	if next == peer.Nickname {
		return nil, false
	}
	peer.Nickname = next
	return &protocol.RoomPeer{ClientID: peer.ClientID, Nickname: peer.Nickname, JoinedAt: peer.JoinedAt}, true
}

func (h *Hub) ResolveSignalTarget(roomID, fromID, connectionID, targetID string) *ClientTx {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.rooms[roomID]
	if room == nil || room.Peers[fromID] == nil || room.Peers[fromID].ConnectionID != connectionID {
		return nil
	}
	target := room.Peers[targetID]
	if target == nil {
		return nil
	}
	return target.Tx
}

func (h *Hub) LeaveRoom(roomID, clientID, connectionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[roomID]
	if room == nil || room.Peers[clientID] == nil {
		return false
	}
	if room.Peers[clientID].ConnectionID != connectionID {
		return false
	}
	delete(room.Peers, clientID)
	if len(room.Peers) == 0 {
		delete(h.rooms, roomID)
	}
	return true
}

func (h *Hub) Broadcast(roomID string, except *string, only []string, payload protocol.ServerToClientMessage) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	allowed := map[string]struct{}{}
	if len(only) > 0 {
		for _, id := range only {
			allowed[id] = struct{}{}
		}
	}
	targets := h.targets(roomID, except, allowed)
	for _, target := range targets {
		target.Send(encoded)
	}
}

func (h *Hub) SendJSON(tx *ClientTx, payload protocol.ServerToClientMessage) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	return tx.Send(encoded)
}

func (h *Hub) targets(roomID string, except *string, only map[string]struct{}) []*ClientTx {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.rooms[roomID]
	if room == nil {
		return nil
	}
	out := make([]*ClientTx, 0, len(room.Peers))
	for clientID, peer := range room.Peers {
		if except != nil && *except == clientID {
			continue
		}
		if len(only) > 0 {
			if _, ok := only[clientID]; !ok {
				continue
			}
		}
		out = append(out, peer.Tx)
	}
	return out
}
