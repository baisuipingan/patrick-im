package util

import "testing"

func TestSanitizeRoomID(t *testing.T) {
	tests := map[string]string{
		" Room 01 ": "room-01",
		"你好":        "lobby",
		"a---b___c": "a-b___c",
	}
	for input, want := range tests {
		if got := SanitizeRoomID(input); got != want {
			t.Fatalf("SanitizeRoomID(%q)=%q want %q", input, got, want)
		}
	}
}

func TestSanitizeFileName(t *testing.T) {
	if got := SanitizeFileName(` ../bad:name?.png `); got != "bad-name-.png" {
		t.Fatalf("filename = %q", got)
	}
}
