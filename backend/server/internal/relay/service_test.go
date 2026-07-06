package relay

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
)

func testSession(id string) session.Payload {
	return session.Payload{ClientID: id, Nickname: id, IssuedAt: 1, ExpiresAt: 9999999999999}
}

func TestSinglePartUploadCompletesWithChecksum(t *testing.T) {
	service, err := NewService(t.TempDir(), "secret")
	if err != nil {
		t.Fatal(err)
	}
	sess := testSession("alice")
	data := []byte("hello relay")
	created, err := service.CreateUpload(sess, protocol.RelayUploadRequest{
		RoomID:      "room",
		FileName:    "note.txt",
		ContentType: "text/plain",
		Size:        uint64(len(data)),
	})
	if err != nil {
		t.Fatal(err)
	}
	part, _, err := service.UploadPart(context.Background(), sess, created.Response.UploadToken, 1, data)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := service.CompleteUpload(context.Background(), sess, protocol.RelayCompleteUploadRequest{
		UploadToken: created.Response.UploadToken,
		Parts:       []protocol.RelayUploadedPart{{PartNumber: part.PartNumber, Etag: part.Etag}},
	})
	if err != nil {
		t.Fatal(err)
	}
	object, err := service.GetObject(completed.ObjectKey)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(object.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, data) {
		t.Fatalf("stored data = %q", stored)
	}
}

func TestUploadPartRejectsWrongOwnerAndWrongSize(t *testing.T) {
	service, err := NewService(t.TempDir(), "secret")
	if err != nil {
		t.Fatal(err)
	}
	alice := testSession("alice")
	created, err := service.CreateUpload(alice, protocol.RelayUploadRequest{
		RoomID:      "room",
		FileName:    "note.txt",
		ContentType: "text/plain",
		Size:        4,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.UploadPart(context.Background(), testSession("bob"), created.Response.UploadToken, 1, []byte("test")); err == nil {
		t.Fatal("wrong owner should be rejected")
	}
	if _, _, err := service.UploadPart(context.Background(), alice, created.Response.UploadToken, 1, []byte("too long")); err == nil {
		t.Fatal("wrong part size should be rejected")
	}
}
