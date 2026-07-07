package config

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Bind               string
	LogLevel           string
	PublicBaseURL      string
	STUNURLs           []string
	TURNURLs           []string
	TURNUsername       string
	TURNCredential     string
	SQLitePath         string
	FileStorePath      string
	WebDistPath        string
	SessionSecret      string
	SecureCookies      bool
	RecentMessageLimit int
	UploadLimitBytes   int64
}

func FromEnv() (Config, error) {
	publicBaseURL := normalizeBaseURL(envOr("PATRICK_IM_PUBLIC_BASE_URL", "http://127.0.0.1:5800"))
	sessionSecret := strings.TrimSpace(os.Getenv("PATRICK_IM_SESSION_SECRET"))
	if sessionSecret == "" {
		return Config{}, errors.New("missing required env: PATRICK_IM_SESSION_SECRET")
	}
	return Config{
		Bind:               envOr("PATRICK_IM_BIND", "0.0.0.0:5800"),
		LogLevel:           envOr("PATRICK_IM_LOG", "info"),
		PublicBaseURL:      publicBaseURL,
		STUNURLs:           envCSVOr("PATRICK_IM_STUN_URLS", []string{"stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"}),
		TURNURLs:           envCSVOr("PATRICK_IM_TURN_URLS", nil),
		TURNUsername:       envOr("PATRICK_IM_TURN_USERNAME", ""),
		TURNCredential:     envOr("PATRICK_IM_TURN_CREDENTIAL", ""),
		SQLitePath:         filepath.Clean(envOr("PATRICK_IM_SQLITE_PATH", "./data/patrick-im.sqlite")),
		FileStorePath:      filepath.Clean(envOr("PATRICK_IM_FILE_STORE_PATH", "./data/files")),
		WebDistPath:        filepath.Clean(envOr("PATRICK_IM_WEB_DIST_PATH", "./web-dist")),
		SessionSecret:      sessionSecret,
		SecureCookies:      envBoolOr("PATRICK_IM_SECURE_COOKIES", strings.HasPrefix(publicBaseURL, "https://")),
		RecentMessageLimit: envIntOr("PATRICK_IM_RECENT_MESSAGE_LIMIT", 80),
		UploadLimitBytes:   envInt64Or("PATRICK_IM_UPLOAD_LIMIT_BYTES", 256*1024*1024),
	}, nil
}

func envOr(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func normalizeBaseURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func envCSVOr(key string, fallback []string) []string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func envIntOr(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envInt64Or(key string, fallback int64) int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(os.Getenv(key)), 10, 64)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envBoolOr(key string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
