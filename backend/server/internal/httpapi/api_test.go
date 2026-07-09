package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/baisuipingan/patrick-im/backend/server/internal/chat"
	"github.com/baisuipingan/patrick-im/backend/server/internal/config"
	"github.com/baisuipingan/patrick-im/backend/server/internal/protocol"
	"github.com/baisuipingan/patrick-im/backend/server/internal/repository"
	sessionpkg "github.com/baisuipingan/patrick-im/backend/server/internal/session"
)

func newTestAPI(t *testing.T) *API {
	t.Helper()
	dir := t.TempDir()
	db, err := repository.OpenSQLite(filepath.Join(dir, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Bind:               "127.0.0.1:0",
		PublicBaseURL:      "http://127.0.0.1:5800",
		SQLitePath:         filepath.Join(dir, "db.sqlite"),
		FileStorePath:      filepath.Join(dir, "files"),
		WebDistPath:        filepath.Join(dir, "web-dist"),
		SessionSecret:      "secret",
		RecentMessageLimit: 20,
		UploadLimitBytes:   1024 * 1024,
	}
	store, err := chat.NewStore(db, cfg.FileStorePath, cfg.UploadLimitBytes)
	if err != nil {
		t.Fatal(err)
	}
	return New(cfg, slog.New(slog.NewTextHandler(os.Stdout, nil)), store, chat.NewHub())
}

func newTestRouter(t *testing.T) http.Handler {
	t.Helper()
	return Router(newTestAPI(t))
}

func TestHealthz(t *testing.T) {
	router := newTestRouter(t)
	req := httptest.NewRequest(http.MethodGet, "/api/healthz", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" || body["service"] != "patrick-im-server" {
		t.Fatalf("body = %#v", body)
	}
}

func TestSessionCreatesSecureCookieBehindHTTPSProxy(t *testing.T) {
	router := newTestRouter(t)
	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	req.Header.Set("x-forwarded-proto", "http, https")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	cookie := w.Header().Get("set-cookie")
	if !strings.Contains(cookie, "patrick_im_session=") || !strings.Contains(cookie, "Secure") {
		t.Fatalf("set-cookie = %q", cookie)
	}
	var body protocol.SessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ClientID == "" || body.Nickname == "" || body.SessionToken == "" || body.MaxUploadBytes == 0 {
		t.Fatalf("session body = %#v", body)
	}
}

func TestSessionIncludesIceServers(t *testing.T) {
	api := newTestAPI(t)
	api.cfg.STUNURLs = []string{"stun:stun.example.com:3478"}
	api.cfg.TURNURLs = []string{"turn:turn.example.com:3478"}
	api.cfg.TURNUsername = "turn-user"
	api.cfg.TURNCredential = "turn-secret"
	router := Router(api)

	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var body protocol.SessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.IceServers) != 2 {
		t.Fatalf("ice servers = %#v", body.IceServers)
	}
	if got := body.IceServers[0].URLs; len(got) != 1 || got[0] != "stun:stun.example.com:3478" {
		t.Fatalf("stun urls = %#v", got)
	}
	if body.IceServers[1].Username != "turn-user" || body.IceServers[1].Credential != "turn-secret" {
		t.Fatalf("turn server = %#v", body.IceServers[1])
	}
}

func TestCreateAndListTextMessage(t *testing.T) {
	router := newTestRouter(t)
	cookie := sessionCookie(t, router)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/room-a/messages", strings.NewReader(`{"text":"hello"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var created protocol.Message
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Kind != protocol.MessageKindText || created.Text == nil || *created.Text != "hello" {
		t.Fatalf("created = %#v", created)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/rooms/room-a/messages", nil)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var listed struct {
		Messages []protocol.Message `json:"messages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Messages) != 1 || listed.Messages[0].ID != created.ID {
		t.Fatalf("listed = %#v", listed.Messages)
	}
}

func TestV2RoomConversationMessageAndReadFlow(t *testing.T) {
	router := newTestRouter(t)
	cookie := sessionCookie(t, router)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"roomId":"room-a"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create room status = %d body=%s", w.Code, w.Body.String())
	}
	var room protocol.RoomDetail
	if err := json.Unmarshal(w.Body.Bytes(), &room); err != nil {
		t.Fatal(err)
	}
	if room.ID != "room-a" || len(room.Conversations) != 1 || room.Conversations[0].ID != "room:room-a" {
		t.Fatalf("room = %#v", room)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/conversations/room:room-a/messages", strings.NewReader(`{"text":"hello v2"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create message status = %d body=%s", w.Code, w.Body.String())
	}
	var created protocol.MessageView
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Type != protocol.MessageTypeText || created.Text == nil || *created.Text != "hello v2" {
		t.Fatalf("created = %#v", created)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/conversations/room:room-a/messages", nil)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list messages status = %d body=%s", w.Code, w.Body.String())
	}
	var listed struct {
		Messages []protocol.MessageView `json:"messages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Messages) != 1 || listed.Messages[0].ID != created.ID {
		t.Fatalf("listed = %#v", listed.Messages)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/conversations/room:room-a/read", strings.NewReader(`{}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("mark read status = %d body=%s", w.Code, w.Body.String())
	}
	var readConversation protocol.ConversationView
	if err := json.Unmarshal(w.Body.Bytes(), &readConversation); err != nil {
		t.Fatal(err)
	}
	if readConversation.UnreadCount != 0 {
		t.Fatalf("read conversation = %#v", readConversation)
	}

	var uploadBody bytes.Buffer
	writer := multipart.NewWriter(&uploadBody)
	if err := writer.WriteField("messageType", string(protocol.MessageTypeTxtFile)); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("file", "message.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("large text")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/conversations/room:room-a/attachments", &uploadBody)
	req.Header.Set("content-type", writer.FormDataContentType())
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("upload attachment status = %d body=%s", w.Code, w.Body.String())
	}
	var uploaded protocol.MessageView
	if err := json.Unmarshal(w.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Type != protocol.MessageTypeTxtFile || uploaded.Attachment == nil || uploaded.Attachment.FileName != "message.txt" {
		t.Fatalf("uploaded = %#v", uploaded)
	}
}

func TestV2ClearConversationMessages(t *testing.T) {
	router := newTestRouter(t)
	cookie := sessionCookie(t, router)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"roomId":"room-a"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create room status = %d body=%s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/conversations/room:room-a/messages", strings.NewReader(`{"text":"hello v2"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create message status = %d body=%s", w.Code, w.Body.String())
	}

	var uploadBody bytes.Buffer
	writer := multipart.NewWriter(&uploadBody)
	part, err := writer.CreateFormFile("file", "note.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("file body")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/conversations/room:room-a/attachments", &uploadBody)
	req.Header.Set("content-type", writer.FormDataContentType())
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("upload status = %d body=%s", w.Code, w.Body.String())
	}
	var uploaded protocol.MessageView
	if err := json.Unmarshal(w.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Attachment == nil {
		t.Fatalf("uploaded attachment missing: %#v", uploaded)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/conversations/room:room-a/messages", nil)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("clear status = %d body=%s", w.Code, w.Body.String())
	}
	var cleared protocol.ClearConversationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.ConversationID != "room:room-a" || cleared.Removed != 2 {
		t.Fatalf("cleared = %#v", cleared)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/conversations/room:room-a/messages", nil)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", w.Code, w.Body.String())
	}
	var listed struct {
		Messages []protocol.MessageView `json:"messages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Messages) != 0 {
		t.Fatalf("listed = %#v", listed.Messages)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/attachments/"+uploaded.Attachment.ID, nil)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("attachment status = %d body=%s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/rooms/room-a", nil)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("room status = %d body=%s", w.Code, w.Body.String())
	}
	var room protocol.RoomDetail
	if err := json.Unmarshal(w.Body.Bytes(), &room); err != nil {
		t.Fatal(err)
	}
	if len(room.Conversations) != 1 || room.Conversations[0].LastMessageID != nil || room.Conversations[0].LastMessageText != nil || room.Conversations[0].LastMessageAt != 0 {
		t.Fatalf("room conversations = %#v", room.Conversations)
	}
}

func TestV2ConversationsExposeUnreadForOtherUser(t *testing.T) {
	router := newTestRouter(t)
	aliceCookie := signedSessionCookie(t, "alice", "Alice")
	bobCookie := signedSessionCookie(t, "bob", "Bob")

	postMessage(t, router, aliceCookie, "room-a", `{"text":"hello bob"}`)

	req := httptest.NewRequest(http.MethodGet, "/api/rooms/room-a", nil)
	req.AddCookie(bobCookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("room detail status = %d body=%s", w.Code, w.Body.String())
	}
	var room protocol.RoomDetail
	if err := json.Unmarshal(w.Body.Bytes(), &room); err != nil {
		t.Fatal(err)
	}
	if len(room.Conversations) != 1 || room.Conversations[0].UnreadCount != 1 {
		t.Fatalf("room conversations = %#v", room.Conversations)
	}
}

func TestV2DirectConversationStaysVisibleAfterRoomRefresh(t *testing.T) {
	router := newTestRouter(t)
	aliceCookie := signedSessionCookie(t, "alice", "Alice")
	bobCookie := signedSessionCookie(t, "bob", "Bob")

	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"roomId":"room-a"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(aliceCookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create room status = %d body=%s", w.Code, w.Body.String())
	}
	req = httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"roomId":"room-a"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(bobCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("bob join room status = %d body=%s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/rooms/room-a/conversations/direct", strings.NewReader(`{"peerUserId":"bob"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(aliceCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create direct status = %d body=%s", w.Code, w.Body.String())
	}
	var direct protocol.ConversationView
	if err := json.Unmarshal(w.Body.Bytes(), &direct); err != nil {
		t.Fatal(err)
	}
	if direct.ID != "direct:room-a:alice:bob" || direct.PeerUserID == nil || *direct.PeerUserID != "bob" {
		t.Fatalf("direct = %#v", direct)
	}
	if direct.Title != "Bob" {
		t.Fatalf("direct title = %q", direct.Title)
	}

	assertRoomHasConversation(t, router, aliceCookie, "room-a", direct.ID)
	assertRoomHasConversation(t, router, bobCookie, "room-a", direct.ID)
}

func TestV2DeleteDirectConversationRemovesMessagesAndAttachment(t *testing.T) {
	router := newTestRouter(t)
	aliceCookie := signedSessionCookie(t, "alice", "Alice")
	bobCookie := signedSessionCookie(t, "bob", "Bob")

	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"roomId":"room-a"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(aliceCookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("alice join status = %d body=%s", w.Code, w.Body.String())
	}
	req = httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"roomId":"room-a"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(bobCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("bob join status = %d body=%s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/rooms/room-a/conversations/direct", strings.NewReader(`{"peerUserId":"bob"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(aliceCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create direct status = %d body=%s", w.Code, w.Body.String())
	}
	var direct protocol.ConversationView
	if err := json.Unmarshal(w.Body.Bytes(), &direct); err != nil {
		t.Fatal(err)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/conversations/"+direct.ID+"/messages", strings.NewReader(`{"text":"secret"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(aliceCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("message status = %d body=%s", w.Code, w.Body.String())
	}

	body, contentType := multipartUpload(t, "secret.txt", "private file", "")
	req = httptest.NewRequest(http.MethodPost, "/api/conversations/"+direct.ID+"/attachments", &body)
	req.Header.Set("content-type", contentType)
	req.AddCookie(aliceCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("attachment status = %d body=%s", w.Code, w.Body.String())
	}
	var uploaded protocol.MessageView
	if err := json.Unmarshal(w.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Attachment == nil {
		t.Fatalf("uploaded attachment missing: %#v", uploaded)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/conversations/"+direct.ID, nil)
	req.AddCookie(aliceCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", w.Code, w.Body.String())
	}
	var deleted protocol.ClearConversationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &deleted); err != nil {
		t.Fatal(err)
	}
	if !deleted.Deleted || deleted.Removed != 2 || deleted.ConversationID != direct.ID {
		t.Fatalf("deleted = %#v", deleted)
	}

	assertRoomMissingConversation(t, router, aliceCookie, "room-a", direct.ID)
	assertRoomMissingConversation(t, router, bobCookie, "room-a", direct.ID)

	req = httptest.NewRequest(http.MethodGet, "/api/attachments/"+uploaded.Attachment.ID, nil)
	req.AddCookie(aliceCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("attachment status = %d body=%s", w.Code, w.Body.String())
	}
}

func TestV2AttachmentTooLargeReturns413(t *testing.T) {
	router := newTestRouter(t)
	cookie := sessionCookie(t, router)

	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"roomId":"room-a"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create room status = %d body=%s", w.Code, w.Body.String())
	}

	body, contentType := multipartUpload(t, "too-large.txt", strings.Repeat("x", 1024*1024+1), "")
	req = httptest.NewRequest(http.MethodPost, "/api/conversations/room:room-a/attachments", &body)
	req.Header.Set("content-type", contentType)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("upload status = %d body=%s", w.Code, w.Body.String())
	}
}

func TestUploadFileCreatesMessage(t *testing.T) {
	router := newTestRouter(t)
	cookie := sessionCookie(t, router)
	body, contentType := multipartUpload(t, "hello.txt", "hello file", "")
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/room-a/files", &body)
	req.Header.Set("content-type", contentType)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var message protocol.Message
	if err := json.Unmarshal(w.Body.Bytes(), &message); err != nil {
		t.Fatal(err)
	}
	if message.Kind != protocol.MessageKindFile || message.File == nil || message.File.FileName != "hello.txt" {
		t.Fatalf("message = %#v", message)
	}
}

func TestDownloadPrivateFileAllowsOnlyParticipants(t *testing.T) {
	router := newTestRouter(t)
	aliceCookie := signedSessionCookie(t, "alice", "Alice")
	bobCookie := signedSessionCookie(t, "bob", "Bob")
	carolCookie := signedSessionCookie(t, "carol", "Carol")

	body, contentType := multipartUpload(t, "secret.txt", "private file", "bob")
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/room-a/files", &body)
	req.Header.Set("content-type", contentType)
	req.AddCookie(aliceCookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("upload status = %d body=%s", w.Code, w.Body.String())
	}
	var message protocol.Message
	if err := json.Unmarshal(w.Body.Bytes(), &message); err != nil {
		t.Fatal(err)
	}
	if message.File == nil {
		t.Fatalf("message = %#v", message)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/files/"+message.File.ID, nil)
	req.AddCookie(bobCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK || w.Body.String() != "private file" {
		t.Fatalf("bob download status = %d body=%q", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/files/"+message.File.ID, nil)
	req.AddCookie(carolCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("carol download status = %d body=%s", w.Code, w.Body.String())
	}
}

func TestClearMessagesDeletesSelectedThread(t *testing.T) {
	router := newTestRouter(t)
	aliceCookie := signedSessionCookie(t, "alice", "Alice")
	postMessage(t, router, aliceCookie, "room-a", `{"text":"global"}`)
	postMessage(t, router, aliceCookie, "room-a", `{"text":"bob private","targetId":"bob"}`)
	postMessage(t, router, aliceCookie, "room-a", `{"text":"carol private","targetId":"carol"}`)

	req := httptest.NewRequest(http.MethodDelete, "/api/rooms/room-a/messages?targetId=bob", nil)
	req.AddCookie(aliceCookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("clear status = %d body=%s", w.Code, w.Body.String())
	}
	var cleared protocol.ClearMessagesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.Removed != 1 || cleared.TargetID == nil || *cleared.TargetID != "bob" {
		t.Fatalf("cleared = %#v", cleared)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/rooms/room-a/messages", nil)
	req.AddCookie(aliceCookie)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", w.Code, w.Body.String())
	}
	var listed struct {
		Messages []protocol.Message `json:"messages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Messages) != 2 {
		t.Fatalf("listed = %#v", listed.Messages)
	}
	for _, message := range listed.Messages {
		if message.Text != nil && *message.Text == "bob private" {
			t.Fatalf("cleared message survived: %#v", message)
		}
	}
}

func TestWebSocketSessionFallbackAcceptsSessionSubprotocol(t *testing.T) {
	api := newTestAPI(t)
	payload := sessionpkg.Payload{
		ClientID:  "alice",
		Nickname:  "Alice",
		IssuedAt:  1,
		ExpiresAt: 4_102_444_800_000,
	}
	token, err := sessionpkg.CreateSignedToken("secret", payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/rooms/room-a/ws", nil)
	req.Header.Add("Sec-WebSocket-Protocol", wsProtocolName+", "+wsSessionProtocolPrefix+token)

	got, err := api.requireWebSocketSession(req)
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("payload = %#v", got)
	}
}

func TestWebSocketSessionAcceptsQueryAndAuthorizationToken(t *testing.T) {
	api := newTestAPI(t)
	payload := sessionpkg.Payload{
		ClientID:  "alice",
		Nickname:  "Alice",
		IssuedAt:  1,
		ExpiresAt: 4_102_444_800_000,
	}
	token, err := sessionpkg.CreateSignedToken("secret", payload)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/rooms/room-a/ws?token="+token, nil)
	got, err := api.requireWebSocketSession(req)
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("query payload = %#v", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/rooms/room-a/ws", nil)
	req.Header.Set("authorization", "Bearer "+token)
	got, err = api.requireWebSocketSession(req)
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Fatalf("header payload = %#v", got)
	}
}

func TestWebSocketSignalForwardsOnlyToTarget(t *testing.T) {
	api := newTestAPI(t)
	aliceEvents, aliceLeave := api.hub.Join("room-a", protocol.Peer{
		ClientID: "alice",
		Nickname: "Alice",
		JoinedAt: 1,
	})
	defer aliceLeave()
	bobEvents, bobLeave := api.hub.Join("room-a", protocol.Peer{
		ClientID: "bob",
		Nickname: "Bob",
		JoinedAt: 2,
	})
	defer bobLeave()
	drainEvents(aliceEvents)
	drainEvents(bobEvents)

	api.handleClientWebSocketMessage(
		context.Background(),
		"room-a",
		sessionpkg.Payload{ClientID: "alice", Nickname: "Alice"},
		[]byte(`{"type":"signal","targetId":"bob","payload":{"description":{"type":"offer","sdp":"v=0"}}}`),
	)

	select {
	case raw := <-bobEvents:
		event, ok := raw.(protocol.ServerToClientMessage)
		if !ok {
			t.Fatalf("event type = %T", raw)
		}
		if event.Type != "signal" || event.FromID != "alice" || event.Payload == nil || len(event.Payload.Description) == 0 {
			t.Fatalf("event = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for forwarded signal")
	}

	select {
	case event := <-aliceEvents:
		t.Fatalf("sender received signal: %#v", event)
	default:
	}
}

func TestWebSocketEnvelopeSendMessageAcksAndBroadcasts(t *testing.T) {
	router := newTestRouter(t)
	server := httptest.NewServer(router)
	defer server.Close()
	alice := dialRoomWebSocket(t, server.URL, "room-a", signedSessionToken(t, "alice", "Alice"))
	defer alice.Close()
	readUntilEnvelopeType(t, alice, "room_snapshot")

	request := protocol.NewEnvelope(
		"send_message",
		"request-1",
		"room-a",
		"room:room-a",
		protocol.CreateConversationMessageRequest{Text: "hello envelope"},
		time.Now().UnixMilli(),
	)
	if err := alice.WriteJSON(request); err != nil {
		t.Fatal(err)
	}
	created := readUntilEnvelopeType(t, alice, "message_created")
	if created.ConversationID != "room:room-a" {
		t.Fatalf("created envelope = %#v", created)
	}
	ack := readUntilEnvelopeType(t, alice, "message_ack")
	if ack.RequestID != "request-1" || ack.Error != nil {
		t.Fatalf("ack = %#v", ack)
	}
	var payload protocol.MessageAckPayload
	if err := json.Unmarshal(ack.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Message.Text == nil || *payload.Message.Text != "hello envelope" {
		t.Fatalf("ack payload = %#v", payload)
	}
}

func TestWebSocketDirectMessagePublishesViewerSpecificRoomUpdates(t *testing.T) {
	router := newTestRouter(t)
	aliceCookie := signedSessionCookie(t, "alice", "Alice")
	bobCookie := signedSessionCookie(t, "bob", "Bob")
	joinRoom(t, router, aliceCookie, "room-a")
	joinRoom(t, router, bobCookie, "room-a")

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/room-a/conversations/direct", strings.NewReader(`{"peerUserId":"bob"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(aliceCookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create direct status = %d body=%s", w.Code, w.Body.String())
	}

	server := httptest.NewServer(router)
	defer server.Close()
	alice := dialRoomWebSocket(t, server.URL, "room-a", signedSessionToken(t, "alice", "Alice"))
	defer alice.Close()
	bob := dialRoomWebSocket(t, server.URL, "room-a", signedSessionToken(t, "bob", "Bob"))
	defer bob.Close()
	readUntilEnvelopeType(t, alice, "room_snapshot")
	readUntilEnvelopeType(t, bob, "room_snapshot")

	request := protocol.NewEnvelope(
		"send_message",
		"direct-request-1",
		"room-a",
		"direct:room-a:alice:bob",
		protocol.CreateConversationMessageRequest{Text: "hello bob"},
		time.Now().UnixMilli(),
	)
	if err := alice.WriteJSON(request); err != nil {
		t.Fatal(err)
	}

	aliceRoom := readUntilRoomUpdatedWithConversation(t, alice, "direct:room-a:alice:bob")
	bobRoom := readUntilRoomUpdatedWithConversation(t, bob, "direct:room-a:alice:bob")
	aliceDirect := findConversation(t, aliceRoom, "direct:room-a:alice:bob")
	bobDirect := findConversation(t, bobRoom, "direct:room-a:alice:bob")
	if aliceDirect.PeerUserID == nil || *aliceDirect.PeerUserID != "bob" || aliceDirect.Title != "Bob" {
		t.Fatalf("alice direct = %#v", aliceDirect)
	}
	if bobDirect.PeerUserID == nil || *bobDirect.PeerUserID != "alice" || bobDirect.Title != "Alice" {
		t.Fatalf("bob direct = %#v", bobDirect)
	}
	if bobDirect.LastMessageText == nil || *bobDirect.LastMessageText != "hello bob" {
		t.Fatalf("bob direct last message = %#v", bobDirect)
	}
}

func TestWebSocketEnvelopeWebRTCForwardsOnlyToTarget(t *testing.T) {
	api := newTestAPI(t)
	aliceEvents, aliceLeave := api.hub.Join("room-a", protocol.Peer{
		ClientID: "alice",
		Nickname: "Alice",
		JoinedAt: 1,
	})
	defer aliceLeave()
	bobEvents, bobLeave := api.hub.Join("room-a", protocol.Peer{
		ClientID: "bob",
		Nickname: "Bob",
		JoinedAt: 2,
	})
	defer bobLeave()
	drainEvents(aliceEvents)
	drainEvents(bobEvents)

	request := protocol.NewEnvelope(
		"webrtc_offer",
		"signal-1",
		"room-a",
		"direct:room-a:alice:bob",
		protocol.WebRTCSignalPayload{
			TargetID: "bob",
			Signal: protocol.SignalEnvelope{
				Description: json.RawMessage(`{"type":"offer","sdp":"v=0"}`),
			},
		},
		time.Now().UnixMilli(),
	)
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	api.handleClientWebSocketMessage(context.Background(), "room-a", sessionpkg.Payload{ClientID: "alice", Nickname: "Alice"}, data)

	select {
	case raw := <-bobEvents:
		event, ok := raw.(protocol.Envelope)
		if !ok {
			t.Fatalf("event type = %T", raw)
		}
		if event.Type != "webrtc_offer" || event.RequestID != "signal-1" {
			t.Fatalf("event = %#v", event)
		}
		var payload protocol.WebRTCSignalPayload
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.FromID != "alice" || payload.TargetID != "bob" || len(payload.Signal.Description) == 0 {
			t.Fatalf("payload = %#v", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for forwarded envelope")
	}

	select {
	case event := <-aliceEvents:
		t.Fatalf("sender received signal: %#v", event)
	default:
	}
}

func TestWebSocketEnvelopeWebRTCTargetUnavailableReturnsError(t *testing.T) {
	api := newTestAPI(t)
	aliceEvents, aliceLeave := api.hub.Join("room-a", protocol.Peer{
		ClientID: "alice",
		Nickname: "Alice",
		JoinedAt: 1,
	})
	defer aliceLeave()
	drainEvents(aliceEvents)

	request := protocol.NewEnvelope(
		"webrtc_offer",
		"signal-missing",
		"room-a",
		"direct:room-a:alice:bob",
		protocol.WebRTCSignalPayload{
			TargetID: "bob",
			Signal: protocol.SignalEnvelope{
				Description: json.RawMessage(`{"type":"offer","sdp":"v=0"}`),
			},
		},
		time.Now().UnixMilli(),
	)
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	api.handleClientWebSocketMessage(context.Background(), "room-a", sessionpkg.Payload{ClientID: "alice", Nickname: "Alice"}, data)

	select {
	case raw := <-aliceEvents:
		event, ok := raw.(protocol.Envelope)
		if !ok {
			t.Fatalf("event type = %T", raw)
		}
		if event.Type != "webrtc_offer" || event.RequestID != "signal-missing" || event.Error == nil {
			t.Fatalf("event = %#v", event)
		}
		if event.Error.Code != "target_unavailable" {
			t.Fatalf("error = %#v", event.Error)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for error envelope")
	}
}

func TestRoomWebSocketForwardsSignal(t *testing.T) {
	router := newTestRouter(t)
	server := httptest.NewServer(router)
	defer server.Close()
	alice := dialRoomWebSocket(t, server.URL, "room-a", signedSessionToken(t, "alice", "Alice"))
	defer alice.Close()
	bob := dialRoomWebSocket(t, server.URL, "room-a", signedSessionToken(t, "bob", "Bob"))
	defer bob.Close()
	readUntilEventType(t, alice, "presence")
	readUntilEventType(t, bob, "presence")

	err := bob.WriteJSON(protocol.ClientToServerMessage{
		Type:     "signal",
		TargetID: "alice",
		Payload: &protocol.SignalEnvelope{
			Description: json.RawMessage(`{"type":"offer","sdp":"v=0"}`),
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	event := readUntilEventType(t, alice, "signal")
	if event.FromID != "bob" || event.Payload == nil || len(event.Payload.Description) == 0 {
		t.Fatalf("signal event = %#v", event)
	}
}

func TestCreateMessageRequiresSession(t *testing.T) {
	router := newTestRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/room-a/messages", strings.NewReader(`{"text":"hello"}`))
	req.Header.Set("content-type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
}

func dialRoomWebSocket(t *testing.T, baseURL, roomID, token string) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(baseURL, "http") + "/api/rooms/" + roomID + "/ws"
	dialer := websocket.Dialer{
		Subprotocols: []string{wsProtocolName, wsSessionProtocolPrefix + token},
	}
	conn, response, err := dialer.Dial(wsURL, nil)
	if err != nil {
		status := ""
		if response != nil {
			status = response.Status
		}
		t.Fatalf("dial websocket: %v %s", err, status)
	}
	return conn
}

func readUntilEventType(t *testing.T, conn *websocket.Conn, eventType string) protocol.ServerToClientMessage {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	for {
		var event protocol.ServerToClientMessage
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type == eventType {
			return event
		}
	}
}

func readUntilEnvelopeType(t *testing.T, conn *websocket.Conn, eventType string) protocol.Envelope {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	for {
		var event protocol.Envelope
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type == eventType {
			return event
		}
	}
}

func readUntilRoomUpdatedWithConversation(t *testing.T, conn *websocket.Conn, conversationID string) protocol.RoomDetail {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	for {
		var event protocol.Envelope
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type != "room_updated" {
			continue
		}
		var payload protocol.RoomUpdatedPayload
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		for _, conversation := range payload.Room.Conversations {
			if conversation.ID == conversationID {
				return payload.Room
			}
		}
	}
}

func findConversation(t *testing.T, room protocol.RoomDetail, conversationID string) protocol.ConversationView {
	t.Helper()
	for _, conversation := range room.Conversations {
		if conversation.ID == conversationID {
			return conversation
		}
	}
	t.Fatalf("conversation %q not found in room: %#v", conversationID, room.Conversations)
	return protocol.ConversationView{}
}

func assertRoomHasConversation(t *testing.T, router http.Handler, cookie *http.Cookie, roomID, conversationID string) {
	t.Helper()
	room := fetchRoomDetail(t, router, cookie, roomID)
	for _, conversation := range room.Conversations {
		if conversation.ID == conversationID {
			return
		}
	}
	t.Fatalf("conversation %q not in room detail: %#v", conversationID, room.Conversations)
}

func assertRoomMissingConversation(t *testing.T, router http.Handler, cookie *http.Cookie, roomID, conversationID string) {
	t.Helper()
	room := fetchRoomDetail(t, router, cookie, roomID)
	for _, conversation := range room.Conversations {
		if conversation.ID == conversationID {
			t.Fatalf("conversation %q still in room detail: %#v", conversationID, room.Conversations)
		}
	}
}

func fetchRoomDetail(t *testing.T, router http.Handler, cookie *http.Cookie, roomID string) protocol.RoomDetail {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/rooms/"+roomID, nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("room detail status = %d body=%s", w.Code, w.Body.String())
	}
	var room protocol.RoomDetail
	if err := json.Unmarshal(w.Body.Bytes(), &room); err != nil {
		t.Fatal(err)
	}
	return room
}

func joinRoom(t *testing.T, router http.Handler, cookie *http.Cookie, roomID string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"roomId":"`+roomID+`"}`))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("join room status = %d body=%s", w.Code, w.Body.String())
	}
}

func drainEvents(events <-chan any) {
	for {
		select {
		case <-events:
		default:
			return
		}
	}
}

func sessionCookie(t *testing.T, router http.Handler) *http.Cookie {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("session status = %d body=%s", w.Code, w.Body.String())
	}
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == sessionpkg.CookieName {
			return cookie
		}
	}
	t.Fatal("missing session cookie")
	return nil
}

func signedSessionCookie(t *testing.T, id, name string) *http.Cookie {
	t.Helper()
	token := signedSessionToken(t, id, name)
	return &http.Cookie{Name: sessionpkg.CookieName, Value: token}
}

func signedSessionToken(t *testing.T, id, name string) string {
	t.Helper()
	token, err := sessionpkg.CreateSignedToken("secret", sessionpkg.Payload{
		ClientID:  id,
		Nickname:  name,
		IssuedAt:  1,
		ExpiresAt: 4_102_444_800_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func multipartUpload(t *testing.T, fileName, content, targetID string) (bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if targetID != "" {
		if err := writer.WriteField("targetId", targetID); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body, writer.FormDataContentType()
}

func postMessage(t *testing.T, router http.Handler, cookie *http.Cookie, roomID, body string) protocol.Message {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/"+roomID+"/messages", strings.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("post status = %d body=%s", w.Code, w.Body.String())
	}
	var message protocol.Message
	if err := json.Unmarshal(w.Body.Bytes(), &message); err != nil {
		t.Fatal(err)
	}
	return message
}
