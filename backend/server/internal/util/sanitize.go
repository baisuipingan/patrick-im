package util

import (
	"path/filepath"
	"strings"
	"unicode"
)

func SanitizeRoomID(input string) string {
	normalized := strings.ToLower(strings.TrimSpace(input))
	var compact strings.Builder
	lastDash := false
	for _, ch := range normalized {
		var out rune
		switch {
		case ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9', ch == '_':
			out = ch
		case ch == '-':
			out = '-'
		default:
			out = '-'
		}
		if out == '-' {
			if !lastDash {
				compact.WriteRune(out)
			}
			lastDash = true
			continue
		}
		compact.WriteRune(out)
		lastDash = false
	}
	result := strings.Trim(compact.String(), "-")
	if len([]rune(result)) > 64 {
		result = string([]rune(result)[:64])
	}
	if result == "" {
		return "lobby"
	}
	return result
}

func SanitizeNickname(input, fallback string) string {
	normalized := strings.Join(strings.Fields(strings.TrimSpace(input)), " ")
	var b strings.Builder
	for _, ch := range normalized {
		if !unicode.IsControl(ch) {
			b.WriteRune(ch)
		}
	}
	result := b.String()
	if len([]rune(result)) > 24 {
		result = string([]rune(result)[:24])
	}
	if strings.TrimSpace(result) == "" {
		return fallback
	}
	return result
}

func SanitizeFileName(input string) string {
	trimmed := strings.TrimSpace(filepath.Base(input))
	if trimmed == "" || trimmed == "." {
		return "file"
	}
	var b strings.Builder
	for _, ch := range trimmed {
		switch ch {
		case '\\', '/', ':', '"', '*', '?', '<', '>', '|':
			b.WriteRune('-')
		default:
			b.WriteRune(ch)
		}
	}
	normalized := strings.Join(strings.Fields(b.String()), " ")
	runes := []rune(normalized)
	if len(runes) > 120 {
		normalized = string(runes[:120])
	}
	if normalized == "" {
		return "file"
	}
	return normalized
}

func IsImageContentType(contentType string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/")
}
