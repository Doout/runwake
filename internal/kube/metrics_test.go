package kube

import (
	"math"
	"testing"
	"time"

	"github.com/Doout/runwake/internal/model"
)

func TestParseCPUQuantity(t *testing.T) {
	cases := map[string]float64{"250m": 0.25, "100000000n": 0.1, "1": 1, "2.5": 2.5}
	for raw, want := range cases {
		got, err := parseCPUQuantity(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		if math.Abs(got-want) > 1e-9 {
			t.Fatalf("parse %q = %f, want %f", raw, got, want)
		}
	}
}

func TestParseByteQuantity(t *testing.T) {
	cases := map[string]int64{"128Mi": 128 << 20, "1Gi": 1 << 30, "500M": 500_000_000, "1024": 1024}
	for raw, want := range cases {
		got, err := parseByteQuantity(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		if got != want {
			t.Fatalf("parse %q = %d, want %d", raw, got, want)
		}
	}
}

func TestSelectorMatchesExpressions(t *testing.T) {
	labels := map[string]string{"app": "checkout", "tier": "api", "managed": "true"}
	for _, selector := range []string{"app=checkout", "app in (checkout,payments),tier!=worker", "managed,!debug"} {
		if !selectorMatches(selector, labels) {
			t.Fatalf("selector %q should match", selector)
		}
	}
	for _, selector := range []string{"app=payments", "tier notin (api,worker)", "debug"} {
		if selectorMatches(selector, labels) {
			t.Fatalf("selector %q should not match", selector)
		}
	}
}

func TestAggregateSelectedMetricsIncludesContainerLimits(t *testing.T) {
	pod := podObject{}
	pod.Metadata.Name = "checkout-api-abc"
	pod.Metadata.Namespace = "payments"
	pod.Spec.Containers = []containerSpec{{Name: "app"}}
	pod.Spec.Containers[0].Resources.Limits = map[string]string{"memory": "256Mi"}
	item := podMetric{Timestamp: time.Unix(10, 0).UTC()}
	item.Metadata.Name = pod.Metadata.Name
	item.Metadata.Namespace = pod.Metadata.Namespace
	item.Containers = append(item.Containers, struct {
		Name  string            `json:"name"`
		Usage map[string]string `json:"usage"`
	}{Name: "app", Usage: map[string]string{"cpu": "75m", "memory": "96Mi"}})
	request := model.MetricRequest{ConnectionID: "c1", Kind: "Deployment", Namespace: "payments", Name: "checkout-api"}
	metric, err := aggregateSelectedMetrics("c1", "prod", request, []podObject{pod}, []podMetric{item})
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(metric.CPUCores-0.075) > 1e-9 || metric.MemoryBytes != 96<<20 || metric.MemoryLimitBytes != 256<<20 {
		t.Fatalf("unexpected metric: %#v", metric)
	}
	if len(metric.Containers) != 1 || metric.Containers[0].Pod != pod.Metadata.Name {
		t.Fatalf("container metric missing: %#v", metric.Containers)
	}
}
