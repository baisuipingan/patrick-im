package httpapi

import (
	"bytes"
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
		"room-a",
		sessionpkg.Payload{ClientID: "alice", Nickname: "Alice"},
		[]byte(`{"type":"signal","targetId":"bob","payload":{"description":{"type":"offer","sdp":"v=0"}}}`),
	)

	select {
	case event := <-bobEvents:
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

func drainEvents(events <-chan protocol.ServerToClientMessage) {
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
