package workloadcache

import (
	"testing"
	"time"

	"github.com/Doout/runwake/internal/model"
)

func TestMemoryClonesSnapshots(t *testing.T) {
	cache := NewMemory()
	observedAt := time.Date(2026, time.July, 29, 12, 0, 0, 0, time.UTC)
	input := []model.Workload{{
		ConnectionID: "connection_one",
		Name:         "api",
		Images:       []string{"api:v1"},
		Labels:       map[string]string{"tier": "api"},
		Docker: &model.DockerWorkload{
			DependsOn: []string{"db"},
			Networks:  []model.DockerNetworkAttachment{{Name: "default", Aliases: []string{"api"}}},
		},
	}}

	cache.Put("connection_one", input, observedAt)
	input[0].Images[0] = "mutated"
	input[0].Labels["tier"] = "mutated"
	input[0].Docker.Networks[0].Aliases[0] = "mutated"

	first, ok := cache.Get("connection_one")
	if !ok {
		t.Fatal("snapshot was not stored")
	}
	if first.ObservedAt != observedAt {
		t.Fatalf("observed at = %s, want %s", first.ObservedAt, observedAt)
	}
	if first.Workloads[0].Images[0] != "api:v1" ||
		first.Workloads[0].Labels["tier"] != "api" ||
		first.Workloads[0].Docker.Networks[0].Aliases[0] != "api" {
		t.Fatalf("stored snapshot was mutated: %#v", first.Workloads[0])
	}

	first.Workloads[0].Name = "changed"
	second, _ := cache.Get("connection_one")
	if second.Workloads[0].Name != "api" {
		t.Fatalf("returned snapshot mutated cache: %#v", second.Workloads[0])
	}

	cache.Delete("connection_one")
	if _, ok := cache.Get("connection_one"); ok {
		t.Fatal("snapshot was not deleted")
	}
}
