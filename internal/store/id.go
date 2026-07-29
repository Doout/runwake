package store

import (
	"crypto/rand"
	"encoding/base32"
	"strings"
)

func NewID(prefix string) string {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	value := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf))
	if prefix == "" {
		return value
	}
	return prefix + "_" + value
}
