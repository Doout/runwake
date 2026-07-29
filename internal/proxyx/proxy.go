package proxyx

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/store"
)

type Config struct {
	URL     string
	NoProxy []string
}

func Parse(rawURL string, rawNoProxy []string) (Config, error) {
	config := Config{URL: strings.TrimSpace(rawURL)}
	if len(config.URL) > 4096 {
		return Config{}, errors.New("HTTP proxy URL is too long")
	}
	if strings.ContainsAny(config.URL, "\r\n\x00") {
		return Config{}, errors.New("HTTP proxy URL contains an invalid character")
	}
	parsed, err := url.Parse(config.URL)
	if err != nil {
		return Config{}, fmt.Errorf("invalid HTTP proxy URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return Config{}, errors.New("HTTP proxy URL must start with http:// or https://")
	}
	if parsed.Host == "" || parsed.Hostname() == "" {
		return Config{}, errors.New("HTTP proxy URL must include a host")
	}
	if parsed.Fragment != "" {
		return Config{}, errors.New("HTTP proxy URL cannot include a fragment")
	}
	if parsed.User != nil && parsed.User.Username() == "" {
		return Config{}, errors.New("HTTP proxy username cannot be empty")
	}
	if len(rawNoProxy) > 128 {
		return Config{}, errors.New("HTTP proxy bypass list cannot contain more than 128 entries")
	}
	seen := map[string]bool{}
	for _, raw := range rawNoProxy {
		value := strings.TrimSpace(raw)
		if value == "" || seen[value] {
			continue
		}
		if len(value) > 512 || strings.ContainsAny(value, "\r\n\x00, ") {
			return Config{}, fmt.Errorf("invalid HTTP proxy bypass entry %q", value)
		}
		seen[value] = true
		config.NoProxy = append(config.NoProxy, value)
	}
	return config, nil
}

func Load(value *model.HTTPProxyConnection, secrets *store.SecretStore) (Config, error) {
	if value == nil {
		return Config{}, errors.New("HTTP proxy configuration is required")
	}
	if value.URLSecret == "" {
		return Config{}, errors.New("HTTP proxy URL secret is missing")
	}
	if secrets == nil {
		return Config{}, errors.New("HTTP proxy secret store is not configured")
	}
	rawURL, err := secrets.Get(value.URLSecret)
	if err != nil {
		return Config{}, fmt.Errorf("read HTTP proxy URL: %w", err)
	}
	return Parse(string(rawURL), value.NoProxy)
}

func (c Config) DisplayURL() string {
	parsed, err := url.Parse(c.URL)
	if err != nil {
		return ""
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func (c Config) Environment() map[string]string {
	if strings.TrimSpace(c.URL) == "" {
		return map[string]string{}
	}
	values := map[string]string{
		"HTTP_PROXY": c.URL, "HTTPS_PROXY": c.URL,
		"http_proxy": c.URL, "https_proxy": c.URL,
	}
	if len(c.NoProxy) > 0 {
		noProxy := strings.Join(c.NoProxy, ",")
		values["NO_PROXY"] = noProxy
		values["no_proxy"] = noProxy
	}
	return values
}
