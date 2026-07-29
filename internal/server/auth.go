package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

const sessionCookie = "runwake_session"

type auth struct {
	token   string
	session string
}

func newAuth(token string) *auth {
	a := &auth{token: token}
	if token != "" {
		mac := hmac.New(sha256.New, []byte(token))
		_, _ = mac.Write([]byte("runwake-session-v1"))
		a.session = base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	}
	return a
}

func (a *auth) required() bool { return a.token != "" }

func (a *auth) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.required() || a.authorized(r) {
			next.ServeHTTP(w, r)
			return
		}
		writeError(w, http.StatusUnauthorized, "authentication required")
	})
}

func (a *auth) authorized(r *http.Request) bool {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		if constantEqual(cookie.Value, a.session) {
			return true
		}
	}
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return constantEqual(strings.TrimSpace(header[7:]), a.token)
	}
	return false
}

func (a *auth) login(w http.ResponseWriter, r *http.Request) {
	if !a.required() {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var request struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid login request")
		return
	}
	if !constantEqual(request.Token, a.token) {
		writeError(w, http.StatusUnauthorized, "invalid access token")
		return
	}
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{ //nolint:gosec // Local HTTP is supported; Secure is enabled whenever the request is HTTPS.
		Name:     sessionCookie,
		Value:    a.session,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int((30 * 24 * time.Hour).Seconds()),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (a *auth) logout(w http.ResponseWriter, r *http.Request) {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: -1}) //nolint:gosec // Local HTTP is supported; Secure is enabled whenever the request is HTTPS.
	w.WriteHeader(http.StatusNoContent)
}

func constantEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
