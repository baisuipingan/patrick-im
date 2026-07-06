package util

import (
	"fmt"
	"strings"
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
	result := compact.String()
	if len([]rune(result)) > 64 {
		result = string([]rune(result)[:64])
	}
	result = strings.Trim(result, "-")
	if result == "" {
		return "lobby"
	}
	return result
}

func SanitizeNickname(input, fallback string) string {
	normalized := strings.Join(strings.Fields(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(input), "<", ""), ">", "")), " ")
	runes := []rune(normalized)
	if len(runes) > 24 {
		normalized = string(runes[:24])
	}
	if normalized == "" {
		return fallback
	}
	return normalized
}

func SanitizeFileName(input string) string {
	trimmed := strings.TrimSpace(input)
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
		return "unnamed-file"
	}
	return normalized
}

func BuildObjectKey(roomID, fileID, fileName string) string {
	return fmt.Sprintf("rooms/%s/%s/%s", roomID, fileID, SanitizeFileName(fileName))
}

func EncodeContentDispositionName(fileName string) string {
	var encoded strings.Builder
	for _, b := range []byte(fileName) {
		if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '-' || b == '_' || b == '.' || b == '~' {
			encoded.WriteByte(b)
			continue
		}
		encoded.WriteString(fmt.Sprintf("%%%02X", b))
	}
	return encoded.String()
}
