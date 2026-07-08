package chat

import (
	"sync"
	"time"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
)

const clientBufferSize = 512

type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[string]*subscriber
}

type subscriber struct {
	peer protocol.Peer
	ch   chan any
}

func NewHub() *Hub {
	return &Hub{rooms: map[string]map[string]*subscriber{}}
}

func (h *Hub) Join(roomID string, peer protocol.Peer) (<-chan any, func()) {
	h.mu.Lock()
	room := h.rooms[roomID]
	if room == nil {
		room = map[string]*subscriber{}
		h.rooms[roomID] = room
	}
	if current := room[peer.ClientID]; current != nil {
		close(current.ch)
	}
	sub := &subscriber{peer: peer, ch: make(chan any, clientBufferSize)}
	room[peer.ClientID] = sub
	peers := peersFor(room)
	presence := protocol.ServerToClientMessage{Type: "presence", RoomID: roomID, Peers: peers}
	h.publishLocked(roomID, nil, presence)
	h.publishLocked(roomID, nil, protocol.NewEnvelope("member_updated", "", roomID, "", protocol.MemberUpdatedPayload{Peers: peers}, time.Now().UnixMilli()))
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
		peers := peersFor(room)
		h.publishLocked(roomID, nil, protocol.ServerToClientMessage{Type: "presence", RoomID: roomID, Peers: peers})
		h.publishLocked(roomID, nil, protocol.NewEnvelope("member_updated", "", roomID, "", protocol.MemberUpdatedPayload{Peers: peers}, time.Now().UnixMilli()))
	}
	return sub.ch, leave
}

func (h *Hub) Publish(roomID string, recipients []string, event any) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	h.publishLocked(roomID, recipients, event)
}

func (h *Hub) PublishReliable(roomID string, recipients []string, event any, timeout time.Duration) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.publishLockedReliable(roomID, recipients, event, timeout)
}

func (h *Hub) Peers(roomID string) []protocol.Peer {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return peersFor(h.rooms[roomID])
}

func (h *Hub) publishLocked(roomID string, recipients []string, event any) {
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

func (h *Hub) publishLockedReliable(roomID string, recipients []string, event any, timeout time.Duration) int {
	room := h.rooms[roomID]
	if len(room) == 0 {
		return 0
	}
	allowed := map[string]struct{}{}
	for _, id := range recipients {
		allowed[id] = struct{}{}
	}
	dropped := 0
	for clientID, sub := range room {
		if len(allowed) > 0 {
			if _, ok := allowed[clientID]; !ok {
				continue
			}
		}
		if timeout <= 0 {
			select {
			case sub.ch <- event:
			default:
				dropped++
			}
			continue
		}
		timer := time.NewTimer(timeout)
		select {
		case sub.ch <- event:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-timer.C:
			dropped++
		}
	}
	return dropped
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
