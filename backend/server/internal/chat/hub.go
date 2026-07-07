package chat

import (
	"sync"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
)

const clientBufferSize = 32

type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[string]*subscriber
}

type subscriber struct {
	peer protocol.Peer
	ch   chan protocol.ServerToClientMessage
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]map[string]*subscriber{}}
}

func (h *Hub) Join(roomID string, peer protocol.Peer) (<-chan protocol.ServerToClientMessage, func()) {
	h.mu.Lock()
	room := h.rooms[roomID]
	if room == nil {
		room = map[string]*subscriber{}
		h.rooms[roomID] = room
	}
	if current := room[peer.ClientID]; current != nil {
		close(current.ch)
	}
	sub := &subscriber{peer: peer, ch: make(chan protocol.ServerToClientMessage, clientBufferSize)}
	room[peer.ClientID] = sub
	presence := protocol.ServerToClientMessage{Type: "presence", RoomID: roomID, Peers: peersFor(room)}
	h.publishLocked(roomID, nil, presence)
	h.mu.Unlock()

	leave := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		room := h.rooms[roomID]
		if room == nil || room[peer.ClientID] != sub {
			return
		}
		delete(room, peer.ClientID)
		close(sub.ch)
		if len(room) == 0 {
			delete(h.rooms, roomID)
			return
		}
		h.publishLocked(roomID, nil, protocol.ServerToClientMessage{Type: "presence", RoomID: roomID, Peers: peersFor(room)})
	}
	return sub.ch, leave
}

func (h *Hub) Publish(roomID string, recipients []string, event protocol.ServerToClientMessage) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	h.publishLocked(roomID, recipients, event)
}

func (h *Hub) Peers(roomID string) []protocol.Peer {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return peersFor(h.rooms[roomID])
}

func (h *Hub) publishLocked(roomID string, recipients []string, event protocol.ServerToClientMessage) {
	room := h.rooms[roomID]
	if len(room) == 0 {
		return
	}
	allowed := map[string]struct{}{}
	for _, id := range recipients {
		allowed[id] = struct{}{}
	}
	for clientID, sub := range room {
		if len(allowed) > 0 {
			if _, ok := allowed[clientID]; !ok {
				continue
			}
		}
		select {
		case sub.ch <- event:
		default:
		}
	}
}

func peersFor(room map[string]*subscriber) []protocol.Peer {
	if len(room) == 0 {
		return []protocol.Peer{}
	}
	peers := make([]protocol.Peer, 0, len(room))
	for _, sub := range room {
		peers = append(peers, sub.peer)
	}
	return peers
}
