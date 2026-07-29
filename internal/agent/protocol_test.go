package agent

import "testing"

func TestTokenHashVerification(t *testing.T) {
	hash := HashToken("secret")
	if !VerifyToken("secret", hash) {
		t.Fatal("valid token rejected")
	}
	if VerifyToken("wrong", hash) {
		t.Fatal("invalid token accepted")
	}
}
