package activity

import (
	"testing"

	"github.com/Doout/runwake/internal/model"
)

func TestRecordMatchesStreamScope(t *testing.T) {
	request := model.StreamRequest{Pod: "web-a", Container: "app"}
	tests := []struct {
		name   string
		record model.ActivityRecord
		match  bool
	}{
		{name: "selected source", record: model.ActivityRecord{Pod: "web-a", Container: "app"}, match: true},
		{name: "other pod", record: model.ActivityRecord{Pod: "web-b", Container: "app"}, match: false},
		{name: "other container", record: model.ActivityRecord{Pod: "web-a", Container: "sidecar"}, match: false},
		{name: "global stream status", record: model.ActivityRecord{Source: "runwake", Message: "connected"}, match: true},
		{name: "pod event", record: model.ActivityRecord{Pod: "web-a", Source: "kubernetes-event"}, match: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := recordMatchesStreamScope(request, test.record); got != test.match {
				t.Fatalf("recordMatchesStreamScope() = %v, want %v", got, test.match)
			}
		})
	}
}
