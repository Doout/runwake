package server

import (
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

func spaHandler(assets fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		requested := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if requested == "." || requested == "" {
			requested = "index.html"
		}
		data, err := fs.ReadFile(assets, requested)
		if err != nil {
			requested = "index.html"
			data, err = fs.ReadFile(assets, requested)
		}
		if err != nil {
			http.Error(w, "embedded UI is unavailable", http.StatusInternalServerError)
			return
		}
		if strings.HasSuffix(requested, ".js") || strings.HasSuffix(requested, ".css") {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		contentType := mime.TypeByExtension(path.Ext(requested))
		if strings.HasSuffix(requested, ".webmanifest") {
			contentType = "application/manifest+json"
		}
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.Header().Set("Content-Length", stringInt(len(data)))
		if r.Method == http.MethodGet {
			_, _ = w.Write(data) //nolint:gosec // Data comes from the compile-time embedded UI filesystem.
		}
	})
}

func stringInt(value int) string {
	if value == 0 {
		return "0"
	}
	var buf [24]byte
	i := len(buf)
	for value > 0 {
		i--
		buf[i] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[i:])
}
