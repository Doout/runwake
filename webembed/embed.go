package webembed

import (
	"embed"
	"io/fs"
)

//go:embed dist/*
var embedded embed.FS

func FS() fs.FS {
	f, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err)
	}
	return f
}
