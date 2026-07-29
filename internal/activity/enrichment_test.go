package activity

import (
	"testing"

	"github.com/Doout/runwake/internal/model"
)

func TestEnrichActivityRecordUvicornAccessLog(t *testing.T) {
	record := model.ActivityRecord{
		Type:    "log",
		Level:   "stdout",
		Message: `INFO:     172.21.0.11:59704 - "GET /v1/auth/status?fresh=1 HTTP/1.1" 200 OK`,
	}

	enrichActivityRecord(&record)

	if record.Level != "info" {
		t.Fatalf("Level = %q, want info", record.Level)
	}
	expected := map[string]any{
		"logger":            "http",
		"log_kind":          "http_access",
		"log_format":        "uvicorn_access",
		"http_method":       "GET",
		"http_path":         "/v1/auth/status",
		"http_query":        "fresh=1",
		"http_protocol":     "HTTP/1.1",
		"http_status":       200,
		"http_status_class": "2xx",
		"client_address":    "172.21.0.11",
		"client_port":       "59704",
	}
	for key, want := range expected {
		if got := record.Fields[key]; got != want {
			t.Errorf("Fields[%q] = %#v, want %#v", key, got, want)
		}
	}
}

func TestEnrichActivityRecordCommonAccessLog(t *testing.T) {
	record := model.ActivityRecord{
		Type:    "log",
		Message: `10.0.0.8 - - [28/Jul/2026:13:17:36 +0000] "POST /api/jobs HTTP/2.0" 503 182`,
	}

	enrichActivityRecord(&record)

	if got := record.Fields["log_format"]; got != "common_access" {
		t.Fatalf("log_format = %#v, want common_access", got)
	}
	if got := record.Fields["http_method"]; got != "POST" {
		t.Errorf("http_method = %#v, want POST", got)
	}
	if got := record.Fields["http_status_class"]; got != "5xx" {
		t.Errorf("http_status_class = %#v, want 5xx", got)
	}
}

func TestEnrichActivityRecordLeavesOrdinaryLogAlone(t *testing.T) {
	record := model.ActivityRecord{Type: "log", Level: "log", Message: "worker ready"}
	enrichActivityRecord(&record)
	if record.Fields != nil {
		t.Fatalf("Fields = %#v, want nil", record.Fields)
	}
	if record.Level != "log" {
		t.Fatalf("Level = %q, want log", record.Level)
	}
}

func BenchmarkEnrichActivityRecordUvicornAccessLog(b *testing.B) {
	for i := 0; i < b.N; i++ {
		record := model.ActivityRecord{
			Type:    "log",
			Level:   "stdout",
			Message: `INFO:     172.21.0.11:59704 - "GET /v1/auth/status HTTP/1.1" 200 OK`,
		}
		enrichActivityRecord(&record)
	}
}
