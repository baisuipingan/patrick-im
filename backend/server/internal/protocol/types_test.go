package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRoomSnapshotEncodesEmptyLists(t *testing.T) {
	payload := ServerToClientMessage{
		Type:       "room-snapshot",
		RoomID:     "room-a",
		Peers:      []RoomPeer{},
		Messages:   []ChatMessage{},
		ServerTime: 1,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	if !strings.Contains(body, `"peers":[]`) {
		t.Fatalf("missing empty peers list: %s", body)
	}
	if !strings.Contains(body, `"messages":[]`) {
		t.Fatalf("missing empty messages list: %s", body)
	}
}
