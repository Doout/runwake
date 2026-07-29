package deploy

import (
	"strings"
	"testing"
	"time"
)

func TestManifestHasReadOnlyScopeAndNoSecretRead(t *testing.T) {
	result, err := Build(Request{ConnectionID: "connection_abc", Name: "runwake-agent", Image: "runwake/agent:test", ServerURL: "https://runwake.example", Token: "token", Mode: "persistent"})
	if err != nil {
		t.Fatal(err)
	}
	text := result.ApplyManifest
	if strings.Contains(text, `resources: ["secrets"]`) {
		t.Fatal("agent must not read application secrets")
	}
	if strings.Contains(text, `verbs: ["create"`) || strings.Contains(text, `verbs: ["update"`) || strings.Contains(text, `verbs: ["delete"`) {
		t.Fatal("agent role is not read-only")
	}
	if !strings.Contains(text, `resources: ["pods/log"]`) {
		t.Fatal("pod log permission missing")
	}
	if !strings.Contains(text, `apiGroups: ["metrics.k8s.io"]`) || !strings.Contains(text, `resources: ["pods"]`) {
		t.Fatal("pod metrics permission missing")
	}
	if !strings.Contains(text, `RUNWAKE_INVENTORY_INTERVAL`) || !strings.Contains(text, `value: "30s"`) {
		t.Fatal("inventory and metric snapshot interval missing")
	}
	if !strings.Contains(text, "kind: ClusterRoleBinding") {
		t.Fatal("all-namespace binding missing")
	}
}

func TestTemporaryAgentUsesJobAndDeadline(t *testing.T) {
	result, err := Build(Request{ConnectionID: "connection_abc", Image: "runwake/agent:test", ServerURL: "https://runwake.example", Token: "token", Mode: "temporary", TTL: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	text := result.ApplyManifest
	if !strings.Contains(text, "kind: Job") || !strings.Contains(text, "activeDeadlineSeconds: 600") {
		t.Fatal("temporary job deadline missing")
	}
	if result.Deployment.ExpiresAt.IsZero() {
		t.Fatal("temporary deployment expiry missing")
	}
}

func TestTeardownDoesNotDeleteAgentNamespace(t *testing.T) {
	result, err := Build(Request{ConnectionID: "connection_abc", Image: "runwake/agent:test", ServerURL: "https://runwake.example", Token: "token", Mode: "persistent", Namespace: "runwake-system"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result.TeardownManifest, "kind: Namespace") {
		t.Fatal("teardown must not delete a namespace that may be shared or pre-existing")
	}
	if !strings.Contains(result.ApplyManifest, "kind: Namespace") {
		t.Fatal("install manifest should create the agent namespace when absent")
	}
}
