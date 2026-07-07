package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPresenceEventEncodesPeers(t *testing.T) {
	payload := ServerToClientMessage{
		Type:   "presence",
		RoomID: "room-a",
		Peers:  []Peer{},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"peers":[]`) {
		t.Fatalf("missing empty peers list: %s", encoded)
	}
}
