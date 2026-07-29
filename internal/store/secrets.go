package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type SecretStore struct {
	dir string
	key []byte
}

func OpenSecretStore(dataDir, encodedKey string) (*SecretStore, error) {
	dir := filepath.Join(dataDir, "secrets")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	key, err := loadOrCreateKey(dataDir, encodedKey)
	if err != nil {
		return nil, err
	}
	return &SecretStore{dir: dir, key: key}, nil
}

func loadOrCreateKey(dataDir, encoded string) ([]byte, error) {
	if encoded != "" {
		key, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			key, err = base64.RawURLEncoding.DecodeString(encoded)
		}
		if err != nil || len(key) != 32 {
			return nil, errors.New("RUNWAKE_SECRET_KEY must be a base64 encoded 32-byte key")
		}
		return key, nil
	}
	path := filepath.Join(dataDir, "master.key")
	b, err := os.ReadFile(path) //nolint:gosec // path is derived from the configured Runwake data directory.
	if err == nil {
		key, decErr := base64.RawURLEncoding.DecodeString(string(b))
		if decErr != nil || len(key) != 32 {
			return nil, errors.New("invalid master.key")
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(base64.RawURLEncoding.EncodeToString(key)), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func (s *SecretStore) Put(data []byte) (string, error) {
	id := NewID("secret")
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, data, []byte(id))
	blob := make([]byte, 0, len(nonce)+len(ciphertext))
	blob = append(blob, nonce...)
	blob = append(blob, ciphertext...)
	if err := os.WriteFile(filepath.Join(s.dir, id+".bin"), blob, 0o600); err != nil {
		return "", err
	}
	return id, nil
}

func (s *SecretStore) Get(id string) ([]byte, error) {
	if id == "" {
		return nil, os.ErrNotExist
	}
	if !validSecretID(id) {
		return nil, errors.New("invalid secret ID")
	}
	blob, err := os.ReadFile(filepath.Join(s.dir, id+".bin")) //nolint:gosec // id is validated above and cannot contain path separators.
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(blob) < gcm.NonceSize() {
		return nil, errors.New("invalid encrypted secret")
	}
	plain, err := gcm.Open(nil, blob[:gcm.NonceSize()], blob[gcm.NonceSize():], []byte(id))
	if err != nil {
		return nil, fmt.Errorf("decrypt secret: %w", err)
	}
	return plain, nil
}

func (s *SecretStore) Delete(id string) error {
	if id == "" {
		return nil
	}
	if !validSecretID(id) {
		return errors.New("invalid secret ID")
	}
	err := os.Remove(filepath.Join(s.dir, id+".bin"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func validSecretID(id string) bool {
	if !strings.HasPrefix(id, "secret_") || filepath.Base(id) != id || strings.ContainsAny(id, `/\\`) {
		return false
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= '2' && r <= '7') || r == '_' {
			continue
		}
		return false
	}
	return true
}

func (s *SecretStore) Materialize(id, suffix string) (string, func(), error) {
	data, err := s.Get(id)
	if err != nil {
		return "", nil, err
	}
	f, err := os.CreateTemp(s.dir, "materialized-*"+suffix)
	if err != nil {
		return "", nil, err
	}
	path := f.Name()
	cleanup := func() { _ = os.Remove(path) }
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		cleanup()
		return "", nil, err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return "", nil, err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return "", nil, err
	}
	return path, cleanup, nil
}
