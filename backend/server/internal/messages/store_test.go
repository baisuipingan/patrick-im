package messages

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := repository.OpenSQLite(filepath.Join(t.TempDir(), "patrick-im.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	return NewStore(db, 20)
}

func TestListVisibleMessagesFiltersDirectThreads(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	bob := "bob"
	carol := "carol"
	if _, err := store.PersistTextMessage(ctx, "room", "alice", "Alice", nil, "hello room"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PersistTextMessage(ctx, "room", "alice", "Alice", &bob, "secret for bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PersistTextMessage(ctx, "room", "bob", "Bob", &carol, "secret for carol"); err != nil {
		t.Fatal(err)
	}

	aliceMessages, err := store.ListVisibleMessages(ctx, "room", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(aliceMessages) != 2 {
		t.Fatalf("alice visible messages = %d, want 2", len(aliceMessages))
	}
	if aliceMessages[0].Text == nil || *aliceMessages[0].Text != "hello room" {
		t.Fatalf("first alice message = %#v", aliceMessages[0].Text)
	}
	if aliceMessages[1].Text == nil || *aliceMessages[1].Text != "secret for bob" {
		t.Fatalf("second alice message = %#v", aliceMessages[1].Text)
	}

	daveMessages, err := store.ListVisibleMessages(ctx, "room", "dave")
	if err != nil {
		t.Fatal(err)
	}
	if len(daveMessages) != 1 || daveMessages[0].Text == nil || *daveMessages[0].Text != "hello room" {
		t.Fatalf("dave should only see global message: %#v", daveMessages)
	}
}

func TestClearThreadRemovesOnlySelectedThread(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	bob := "bob"
	if _, err := store.PersistTextMessage(ctx, "room", "alice", "Alice", nil, "global"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PersistTextMessage(ctx, "room", "alice", "Alice", &bob, "direct"); err != nil {
		t.Fatal(err)
	}

	outcome, err := store.ClearThread(ctx, "room", "alice", "Alice", &bob)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Response.TargetID == nil || *outcome.Response.TargetID != "bob" {
		t.Fatalf("target = %#v", outcome.Response.TargetID)
	}
	if outcome.Response.RemovedMessages != 1 {
		t.Fatalf("removed messages = %d", outcome.Response.RemovedMessages)
	}
	if outcome.Event == nil || outcome.Event.ActorID != "alice" {
		t.Fatalf("missing clear event: %#v", outcome.Event)
	}
	remaining, err := store.ListVisibleMessages(ctx, "room", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0].Text == nil || *remaining[0].Text != "global" {
		t.Fatalf("remaining = %#v", remaining)
	}
}

func TestRelayFileAnnouncementControlsVisibilityAndIsIdempotent(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	bob := "bob"
	pending := repository.PendingRelayUpload{
		FileID:      "file-1",
		RoomID:      "room",
		FromID:      "alice",
		TargetID:    &bob,
		FileName:    "photo.png",
		Size:        12,
		ContentType: "image/png",
		ObjectKey:   "rooms/room/file-1/photo.png",
		CreatedAt:   100,
	}
	if _, inserted, err := store.StoreCompletedRelayUpload(ctx, pending); err != nil || !inserted {
		t.Fatalf("store pending inserted=%v err=%v", inserted, err)
	}
	announcement := protocol.RelayFileAnnouncement{
		FileID:      pending.FileID,
		FileName:    pending.FileName,
		Size:        uint64(pending.Size),
		ContentType: pending.ContentType,
		ObjectKey:   pending.ObjectKey,
		TargetID:    &bob,
	}
	first, err := store.PersistConfirmedRelayFileMessage(ctx, "room", "alice", "Alice", &bob, announcement)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Created || first.Message.File == nil || !first.Message.File.Previewable {
		t.Fatalf("first announce outcome = %#v", first)
	}
	second, err := store.PersistConfirmedRelayFileMessage(ctx, "room", "alice", "Alice", &bob, announcement)
	if err != nil {
		t.Fatal(err)
	}
	if second.Created {
		t.Fatal("duplicate announce should return existing message")
	}
	if _, err := store.LookupFileForClient(ctx, "room", "file-1", "alice"); err != nil {
		t.Fatalf("sender should access file: %v", err)
	}
	if _, err := store.LookupFileForClient(ctx, "room", "file-1", "bob"); err != nil {
		t.Fatalf("target should access file: %v", err)
	}
	if _, err := store.LookupFileForClient(ctx, "room", "file-1", "carol"); !errors.Is(err, ErrFileForbidden) {
		t.Fatalf("carol should be forbidden, got %v", err)
	}
}
