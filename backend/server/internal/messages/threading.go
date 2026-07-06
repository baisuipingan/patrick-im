package messages

import "sort"

const GlobalThreadKey = "__global__"

func NormalizeTargetID(clientID string, targetID *string) *string {
	if targetID == nil || *targetID == "" || *targetID == clientID {
		return nil
	}
	value := *targetID
	return &value
}

func BuildThreadKey(clientID string, targetID *string) string {
	normalized := NormalizeTargetID(clientID, targetID)
	if normalized == nil {
		return GlobalThreadKey
	}
	pair := []string{clientID, *normalized}
	sort.Strings(pair)
	return pair[0] + ":" + pair[1]
}
