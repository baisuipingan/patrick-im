package chat

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
	"github.com/baisuipingan/patrick-im/backend/server/internal/session"
)

func TestListMessagesKeepsPrivateThreadsVisibleOnlyToParticipants(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	alice := testPayload("alice", "Alice")
	bob := testPayload("bob", "Bob")

	global := mustCreateText(t, store, ctx, "room-a", alice, "hello room", nil)
	aliceToBob := mustCreateText(t, store, ctx, "room-a", alice, "hi bob", ptr("bob"))
	bobToAlice := mustCreateText(t, store, ctx, "room-a", bob, "hi alice", ptr("alice"))
	aliceToCarol := mustCreateText(t, store, ctx, "room-a", alice, "hi carol", ptr("carol"))

	aliceMessages := mustList(t, store, ctx, "room-a", "alice")
	assertHasMessages(t, aliceMessages, global.ID, aliceToBob.ID, bobToAlice.ID, aliceToCarol.ID)

	bobMessages := mustList(t, store, ctx, "room-a", "bob")
	assertHasMessages(t, bobMessages, global.ID, aliceToBob.ID, bobToAlice.ID)
	assertMissingMessage(t, bobMessages, aliceToCarol.ID)

	carolMessages := mustList(t, store, ctx, "room-a", "carol")
	assertHasMessages(t, carolMessages, global.ID, aliceToCarol.ID)
	assertMissingMessage(t, carolMessages, aliceToBob.ID)
	assertMissingMessage(t, carolMessages, bobToAlice.ID)
}

func TestFileAccessRejectsNonParticipants(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	message, err := store.CreateFileMessage(ctx, "room-a", testPayload("alice", "Alice"), fileHeader(t, "note.txt", "secret"), ptr("bob"))
	if err != nil {
		t.Fatal(err)
	}
	if message.File == nil {
		t.Fatal("missing file payload")
	}

	if _, err := store.FileForClient(ctx, message.File.ID, "alice"); err != nil {
		t.Fatalf("sender access failed: %v", err)
	}
	if _, err := store.FileForClient(ctx, message.File.ID, "bob"); err != nil {
		t.Fatalf("target access failed: %v", err)
	}
	if _, err := store.FileForClient(ctx, message.File.ID, "carol"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("carol error = %v, want ErrForbidden", err)
	}
}

func TestClearThreadRemovesOnlySelectedThreadAndReturnsFilePaths(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	alice := testPayload("alice", "Alice")
	mustCreateText(t, store, ctx, "room-a", alice, "global", nil)
	privateFile, err := store.CreateFileMessage(ctx, "room-a", alice, fileHeader(t, "private.txt", "secret"), ptr("bob"))
	if err != nil {
		t.Fatal(err)
	}
	mustCreateText(t, store, ctx, "room-a", alice, "carol", ptr("carol"))

	response, paths, err := store.ClearThread(ctx, "room-a", alice, ptr("bob"))
	if err != nil {
		t.Fatal(err)
	}
	if response.Removed != 1 || response.TargetID == nil || *response.TargetID != "bob" {
		t.Fatalf("response = %#v", response)
	}
	if len(paths) != 1 {
		t.Fatalf("paths = %#v", paths)
	}
	if _, err := store.FileForClient(ctx, privateFile.File.ID, "alice"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted file lookup error = %v, want ErrNotFound", err)
	}

	aliceMessages := mustList(t, store, ctx, "room-a", "alice")
	if len(aliceMessages) != 2 {
		t.Fatalf("remaining messages = %#v", aliceMessages)
	}
	for _, message := range aliceMessages {
		if message.TargetID != nil && *message.TargetID == "bob" {
			t.Fatalf("bob private message survived: %#v", message)
		}
	}
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	db, err := repository.OpenSQLite(filepath.Join(dir, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewStore(db, filepath.Join(dir, "files"), 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func testPayload(id, name string) session.Payload {
	return session.Payload{ClientID: id, Nickname: name, IssuedAt: 1, ExpiresAt: 4_102_444_800_000}
}

func mustCreateText(t *testing.T, store *Store, ctx context.Context, roomID string, author session.Payload, text string, targetID *string) protocol.Message {
	t.Helper()
	message, err := store.CreateTextMessage(ctx, roomID, author, text, targetID)
	if err != nil {
		t.Fatal(err)
	}
	return message
}

func mustList(t *testing.T, store *Store, ctx context.Context, roomID, viewerID string) []protocol.Message {
	t.Helper()
	messages, err := store.ListMessages(ctx, roomID, viewerID, 80, 0)
	if err != nil {
		t.Fatal(err)
	}
	return messages
}

func assertHasMessages(t *testing.T, messages []protocol.Message, ids ...string) {
	t.Helper()
	seen := messageIDs(messages)
	for _, id := range ids {
		if !seen[id] {
			t.Fatalf("missing message %s in %#v", id, messages)
		}
	}
}

func assertMissingMessage(t *testing.T, messages []protocol.Message, id string) {
	t.Helper()
	if messageIDs(messages)[id] {
		t.Fatalf("unexpected message %s in %#v", id, messages)
	}
}

func messageIDs(messages []protocol.Message) map[string]bool {
	out := make(map[string]bool, len(messages))
	for _, message := range messages {
		out[message.ID] = true
	}
	return out
}

func fileHeader(t *testing.T, name, body string) *multipart.FileHeader {
	t.Helper()
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/upload", &buf)
	req.Header.Set("content-type", writer.FormDataContentType())
	if err := req.ParseMultipartForm(1024 * 1024); err != nil {
		t.Fatal(err)
	}
	return req.MultipartForm.File["file"][0]
}

func ptr(value string) *string {
	return &value
}
