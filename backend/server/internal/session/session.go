package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/baisuipingan/patrick-im/backend/server/internal/util"
)

const (
	CookieName = "patrick_im_rs_session"
	ttl        = 14 * 24 * time.Hour
)

type Payload struct {
	ClientID  string `json:"clientId"`
	Nickname  string `json:"nickname"`
	IssuedAt  uint64 `json:"issuedAt"`
	ExpiresAt uint64 `json:"expiresAt"`
}

func GetOrCreate(r *http.Request, w http.ResponseWriter, secure bool, secret string) (Payload, error) {
	now := util.NowMS()
	current, err := Read(r, secret)
	if err != nil {
		current = nil
	}
	var payload Payload
	if current == nil {
		id := uuid.NewString()
		payload = Payload{
			ClientID:  id,
			Nickname:  "访客-" + strings.ReplaceAll(id, "-", "")[:4],
			IssuedAt:  now,
			ExpiresAt: now + uint64(ttl.Milliseconds()),
		}
	} else {
		payload = *current
		payload.ExpiresAt = now + uint64(ttl.Milliseconds())
	}
	token, err := CreateSignedToken(secret, payload)
	if err != nil {
		return Payload{}, err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(ttl.Seconds()),
	})
	return payload, nil
}

func Read(r *http.Request, secret string) (*Payload, error) {
	cookie, err := r.Cookie(CookieName)
	if err != nil {
		return nil, nil
	}
	var payload Payload
	if err := ReadSignedToken(secret, cookie.Value, &payload); err != nil {
		return nil, err
	}
	if payload.ExpiresAt < util.NowMS() {
		return nil, nil
	}
	return &payload, nil
}

func Require(r *http.Request, secret string) (Payload, error) {
	payload, err := Read(r, secret)
	if err != nil {
		return Payload{}, err
	}
	if payload == nil {
		return Payload{}, errors.New("missing session")
	}
	return *payload, nil
}

func CreateSignedToken(secret string, payload any) (string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(encodedPayload))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encodedPayload + "." + signature, nil
}

func ReadSignedToken(secret, token string, dest any) error {
	payload, signature, ok := strings.Cut(token, ".")
	if !ok {
		return errors.New("invalid signed token format")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(payload))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		return errors.New("invalid signed token signature")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return fmt.Errorf("decode token payload: %w", err)
	}
	return json.Unmarshal(decoded, dest)
}
