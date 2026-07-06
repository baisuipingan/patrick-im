package realtime

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
)

func TestJoinRoomReplacesSameClientConnection(t *testing.T) {
	hub := NewHub()
	firstTx := NewClientTx()
	first := hub.JoinRoom("room", "alice", "Alice", firstTx)
	if first.ReplacedTx != nil {
		t.Fatal("first join should not replace anything")
	}
	secondTx := NewClientTx()
	second := hub.JoinRoom("room", "alice", "Alice 2", secondTx)
	if second.ReplacedTx != firstTx {
		t.Fatal("second join should return replaced connection")
	}
	if hub.IsCurrentConnection("room", "alice", first.ConnectionID) {
		t.Fatal("old connection should no longer be current")
	}
	if !hub.IsCurrentConnection("room", "alice", second.ConnectionID) {
		t.Fatal("new connection should be current")
	}
}

func TestBroadcastCanTargetDirectRecipients(t *testing.T) {
	hub := NewHub()
	aliceTx := NewClientTx()
	bobTx := NewClientTx()
	carolTx := NewClientTx()
	hub.JoinRoom("room", "alice", "Alice", aliceTx)
	hub.JoinRoom("room", "bob", "Bob", bobTx)
	hub.JoinRoom("room", "carol", "Carol", carolTx)

	hub.Broadcast("room", nil, []string{"alice", "bob"}, protocol.ServerToClientMessage{
		Type: "pong", ServerTime: 1,
	})
	assertMessageType(t, aliceTx, "pong")
	assertMessageType(t, bobTx, "pong")
	select {
	case got := <-carolTx.C():
		t.Fatalf("carol should not receive direct broadcast: %s", got)
	case <-time.After(20 * time.Millisecond):
	}
}

func assertMessageType(t *testing.T, tx *ClientTx, want string) {
	t.Helper()
	select {
	case got := <-tx.C():
		var payload protocol.ServerToClientMessage
		if err := json.Unmarshal(got, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Type != want {
			t.Fatalf("message type = %q, want %q", payload.Type, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for message")
	}
}
