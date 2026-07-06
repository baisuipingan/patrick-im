package session

import "testing"

func TestSignedTokenRoundTripAndRejectsTampering(t *testing.T) {
	payload := Payload{ClientID: "alice", Nickname: "Alice", IssuedAt: 1, ExpiresAt: 2}
	token, err := CreateSignedToken("secret", payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Payload
	if err := ReadSignedToken("secret", token, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded != payload {
		t.Fatalf("decoded = %#v", decoded)
	}
	var tampered Payload
	if err := ReadSignedToken("secret", token+"x", &tampered); err == nil {
		t.Fatal("tampered token should fail")
	}
}
