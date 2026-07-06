package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"log/slog"
	"os"

	"github.com/baisuipingan/patrick-im/backend/server/internal/config"
	"github.com/baisuipingan/patrick-im/backend/server/internal/messages"
	"github.com/baisuipingan/patrick-im/backend/server/internal/realtime"
	"github.com/baisuipingan/patrick-im/backend/server/internal/relay"
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
	relayService, err := relay.NewService(filepath.Join(dir, "files"), "secret")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Bind:               "127.0.0.1:0",
		PublicBaseURL:      "http://127.0.0.1:5800",
		STUNURLs:           []string{"stun:example.test"},
		SQLitePath:         filepath.Join(dir, "db.sqlite"),
		FileStorePath:      filepath.Join(dir, "files"),
		WebDistPath:        filepath.Join(dir, "web-dist"),
		SessionSecret:      "secret",
		RecentMessageLimit: 20,
	}
	return New(cfg, slog.New(slog.NewTextHandler(os.Stdout, nil)), realtime.NewHub(), messages.NewStore(db, cfg.RecentMessageLimit), relayService)
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
	if !strings.Contains(cookie, "patrick_im_rs_session=") || !strings.Contains(cookie, "Secure") {
		t.Fatalf("set-cookie = %q", cookie)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["clientId"] == "" || body["nickname"] == "" {
		t.Fatalf("session body = %#v", body)
	}
	if body["sessionToken"] == "" {
		t.Fatalf("missing session token in body = %#v", body)
	}
}

func TestWebSocketSessionFallbackAcceptsSessionSubprotocol(t *testing.T) {
	api := newTestAPI(t)
	payload := sessionpkg.Payload{
		ClientID:  "alice",
		Nickname:  "Alice",
		IssuedAt:  1,
		ExpiresAt: ^uint64(0),
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
	if !websocketSubprotocolRequested(req, wsProtocolName) {
		t.Fatalf("missing visible websocket protocol")
	}
}

func TestWebSocketSessionFallbackRejectsBadSessionSubprotocol(t *testing.T) {
	api := newTestAPI(t)
	req := httptest.NewRequest(http.MethodGet, "/api/rooms/room-a/ws", nil)
	req.Header.Add("Sec-WebSocket-Protocol", wsProtocolName+", "+wsSessionProtocolPrefix+"bad-token")

	if _, err := api.requireWebSocketSession(req); err == nil {
		t.Fatal("bad websocket session token should fail")
	}
}

func TestUploadRequestRequiresSession(t *testing.T) {
	router := newTestRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/files/upload-request", strings.NewReader(`{}`))
	req.Header.Set("content-type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
}
