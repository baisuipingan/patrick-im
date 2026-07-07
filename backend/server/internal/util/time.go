package util

import "time"

func NowMS() uint64 {
	return uint64(time.Now().UnixMilli())
}

func NowMillisInt64() int64 {
	return time.Now().UnixMilli()
}
