package messages

import "testing"

func TestNormalizeTargetIDRejectsEmptyAndSelf(t *testing.T) {
	if NormalizeTargetID("alice", nil) != nil {
		t.Fatal("nil target should stay nil")
	}
	empty := ""
	if NormalizeTargetID("alice", &empty) != nil {
		t.Fatal("empty target should normalize to nil")
	}
	self := "alice"
	if NormalizeTargetID("alice", &self) != nil {
		t.Fatal("self target should normalize to nil")
	}
	bob := "bob"
	got := NormalizeTargetID("alice", &bob)
	if got == nil || *got != "bob" {
		t.Fatalf("expected bob target, got %#v", got)
	}
}

func TestBuildThreadKey(t *testing.T) {
	if got := BuildThreadKey("alice", nil); got != GlobalThreadKey {
		t.Fatalf("global thread = %q", got)
	}
	bob := "bob"
	left := BuildThreadKey("alice", &bob)
	alice := "alice"
	right := BuildThreadKey("bob", &alice)
	if left != "alice:bob" || left != right {
		t.Fatalf("unstable direct thread keys: %q %q", left, right)
	}
}
