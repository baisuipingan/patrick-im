package util

import "time"

func NowMS() uint64 {
	return uint64(time.Now().UnixMilli())
}
