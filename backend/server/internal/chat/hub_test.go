package chat

import (
	"testing"
	"time"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
)

func TestPublishReliableDeliversTargetedEvent(t *testing.T) {
	hub := NewHub()
	events, leave := hub.Join("room-a", protocol.Peer{ClientID: "alice", Nickname: "Alice", JoinedAt: 1})
	defer leave()
	drainHubEvents(events)

	delivered, dropped := hub.PublishReliable("room-a", []string{"alice"}, "signal", 10*time.Millisecond)
	if delivered != 1 || dropped != 0 {
		t.Fatalf("delivered, dropped = %d, %d", delivered, dropped)
	}
	select {
	case got := <-events:
		if got != "signal" {
			t.Fatalf("event = %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestPublishReliableReportsFullTargetBuffer(t *testing.T) {
	hub := NewHub()
	events, leave := hub.Join("room-a", protocol.Peer{ClientID: "alice", Nickname: "Alice", JoinedAt: 1})
	defer leave()
	drainHubEvents(events)

	for i := 0; i < clientBufferSize; i++ {
		hub.Publish("room-a", []string{"alice"}, i)
	}
	delivered, dropped := hub.PublishReliable("room-a", []string{"alice"}, "signal", time.Millisecond)
	if delivered != 0 || dropped != 1 {
		t.Fatalf("delivered, dropped = %d, %d", delivered, dropped)
	}
}

func TestPublishReliableReportsUnavailableTarget(t *testing.T) {
	hub := NewHub()
	events, leave := hub.Join("room-a", protocol.Peer{ClientID: "alice", Nickname: "Alice", JoinedAt: 1})
	defer leave()
	drainHubEvents(events)

	delivered, dropped := hub.PublishReliable("room-a", []string{"missing"}, "signal", time.Millisecond)
	if delivered != 0 || dropped != 0 {
		t.Fatalf("delivered, dropped = %d, %d", delivered, dropped)
	}
}

func drainHubEvents(events <-chan any) {
	for {
		select {
		case <-events:
		default:
			return
		}
	}
}
