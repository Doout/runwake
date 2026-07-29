package proxyx

import (
	"strings"
	"testing"
)

func TestParseRedactsCredentialsAndBuildsEnvironment(t *testing.T) {
	config, err := Parse("http://operator:secret@proxy.example.com:8080", []string{"localhost", ".svc", "localhost"})
	if err != nil {
		t.Fatal(err)
	}
	if config.DisplayURL() != "http://proxy.example.com:8080" {
		t.Fatalf("display URL = %q", config.DisplayURL())
	}
	environment := config.Environment()
	if environment["HTTP_PROXY"] != config.URL || environment["HTTPS_PROXY"] != config.URL {
		t.Fatalf("proxy environment is incomplete: %#v", environment)
	}
	if environment["NO_PROXY"] != "localhost,.svc" || environment["no_proxy"] != "localhost,.svc" {
		t.Fatalf("bypass environment = %#v", environment)
	}
}

func TestParseRejectsUnsafeProxyValues(t *testing.T) {
	for _, value := range []string{"socks5://proxy.example.com:1080", "http://", "http://proxy.example.com/#fragment", "http://proxy.example.com/\nnext"} {
		if _, err := Parse(value, nil); err == nil {
			t.Fatalf("expected %q to fail", value)
		}
	}
	if _, err := Parse("http://proxy.example.com:8080", []string{"host,other"}); err == nil || !strings.Contains(err.Error(), "bypass") {
		t.Fatalf("unexpected bypass error: %v", err)
	}
}
