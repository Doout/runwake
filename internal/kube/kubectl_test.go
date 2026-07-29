package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/Doout/runwake/internal/model"
)

func TestMergeEnvironmentOverridesWithoutDuplicates(t *testing.T) {
	base := []string{"HOME=/home/runwake", "AWS_PROFILE=default", "PATH=/bin"}
	got := mergeEnvironment(base, map[string]string{"AWS_PROFILE": "production", "AWS_REGION": "us-east-1"})
	joined := strings.Join(got, "\n")
	if strings.Contains(joined, "AWS_PROFILE=default") || !strings.Contains(joined, "AWS_PROFILE=production") {
		t.Fatalf("environment override was not applied: %v", got)
	}
	if !strings.Contains(joined, "AWS_REGION=us-east-1") {
		t.Fatalf("new environment value missing: %v", got)
	}
	if runtime.GOOS != "windows" && !strings.Contains(joined, "HOME=/home/runwake") {
		t.Fatalf("unrelated environment value was removed: %v", got)
	}
}

func TestPodRuntimeFingerprintChangesOnRestart(t *testing.T) {
	pod := podObject{}
	pod.Status.ContainerStatuses = []containerStatus{{Name: "app", ContainerID: "containerd://one", RestartCount: 0}}
	before := podRuntimeFingerprint(pod)
	pod.Status.ContainerStatuses[0].ContainerID = "containerd://two"
	pod.Status.ContainerStatuses[0].RestartCount = 1
	after := podRuntimeFingerprint(pod)
	if before == after {
		t.Fatal("pod runtime fingerprint must change when a container restarts")
	}
}

func TestActivityScopeFiltersPodsAndContainers(t *testing.T) {
	first := podObject{}
	first.Metadata.Name = "web-a"
	second := podObject{}
	second.Metadata.Name = "web-b"
	pods := filterActivityPods([]podObject{first, second}, "web-b")
	if len(pods) != 1 || pods[0].Metadata.Name != "web-b" {
		t.Fatalf("pod scope = %#v", pods)
	}
	if !activityContainerSelected("app", "app") || activityContainerSelected("app", "sidecar") {
		t.Fatal("container scope did not select only the requested container")
	}
	if !activityContainerSelected("", "sidecar") {
		t.Fatal("empty container scope must include every container")
	}
}

func TestWorkloadListCommandsRespectNamespaceScope(t *testing.T) {
	all := workloadListCommands(nil)
	if len(all) != 1 || !containsSequence(all[0], "-A") {
		t.Fatalf("all namespaces command = %#v", all)
	}
	selected := workloadListCommands([]string{"payments", "platform"})
	if len(selected) != 2 {
		t.Fatalf("selected commands = %#v", selected)
	}
	if !containsSequence(selected[0], "-n", "payments") || !containsSequence(selected[1], "-n", "platform") {
		t.Fatalf("selected commands = %#v", selected)
	}
	for _, command := range selected {
		if containsSequence(command, "-A") {
			t.Fatalf("selected command unexpectedly requests all namespaces: %#v", command)
		}
	}
}

func TestWorkloadStreamCommandsSplitResourcesForProgressiveResults(t *testing.T) {
	all := workloadStreamCommands(nil)
	if len(all) != 5 {
		t.Fatalf("all namespaces stream commands = %#v", all)
	}
	if all[0].kind != "Deployment" || !containsSequence(all[0].args, "get", "deployments", "-A") {
		t.Fatalf("first stream command = %#v", all[0])
	}
	if all[4].kind != "Pod" || !containsSequence(all[4].args, "get", "pods", "-A") {
		t.Fatalf("pod stream command = %#v", all[4])
	}

	selected := workloadStreamCommands([]string{"payments", "platform"})
	if len(selected) != 10 {
		t.Fatalf("selected stream commands = %#v", selected)
	}
	for _, command := range selected {
		if containsSequence(command.args, "-A") {
			t.Fatalf("selected stream command unexpectedly requests all namespaces: %#v", command)
		}
	}
}

func TestInClusterWorkloadPathsRespectNamespaceScope(t *testing.T) {
	all := inClusterWorkloadPaths(nil)
	if len(all) != 5 || all[0] != "/apis/apps/v1/deployments" {
		t.Fatalf("all paths = %#v", all)
	}
	selected := inClusterWorkloadPaths([]string{"payments"})
	if len(selected) != 5 {
		t.Fatalf("selected paths = %#v", selected)
	}
	for _, path := range selected {
		if !strings.Contains(path, "/namespaces/payments/") {
			t.Fatalf("selected path is not namespace scoped: %q", path)
		}
	}
}

func TestInClusterWorkloadItemsReceiveKindBeforeParsing(t *testing.T) {
	deployment, err := stampWorkloadKind(json.RawMessage(`{
		"metadata":{"name":"web","namespace":"apps"},
		"spec":{"replicas":1,"selector":{"matchLabels":{"app":"web"}}},
		"status":{"replicas":1,"readyReplicas":1,"availableReplicas":1,"updatedReplicas":1}
	}`), "Deployment")
	if err != nil {
		t.Fatal(err)
	}
	ownedPod, err := stampWorkloadKind(json.RawMessage(`{
		"metadata":{"name":"web-abc","namespace":"apps","ownerReferences":[{"kind":"ReplicaSet","controller":true}]},
		"status":{"phase":"Running"}
	}`), "Pod")
	if err != nil {
		t.Fatal(err)
	}
	standalonePod, err := stampWorkloadKind(json.RawMessage(`{
		"metadata":{"name":"shell","namespace":"apps"},
		"status":{"phase":"Running"}
	}`), "Pod")
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(listEnvelope{Items: []json.RawMessage{deployment, ownedPod, standalonePod}})
	if err != nil {
		t.Fatal(err)
	}
	workloads, err := parseWorkloadList(data, "connection", "cluster", map[string]bool{"apps": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(workloads) != 2 || workloads[0].Kind != "Pod" || workloads[0].Name != "shell" || workloads[1].Kind != "Deployment" || workloads[1].Name != "web" {
		t.Fatalf("unexpected workloads: %#v", workloads)
	}
}

func TestKubeconfigProviderUsesAPIWithoutKubectl(t *testing.T) {
	const token = "direct-api-token"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			t.Errorf("authorization = %q", got)
		}
		switch r.URL.Path {
		case "/version":
			_, _ = w.Write([]byte(`{"gitVersion":"v1.32.1"}`))
		case "/api/v1/namespaces":
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"default"}},{"metadata":{"name":"apps"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	config := fmt.Sprintf(`apiVersion: v1
kind: Config
current-context: test
clusters:
  - name: cluster
    cluster:
      server: %s
      insecure-skip-tls-verify: true
contexts:
  - name: test
    context:
      cluster: cluster
      user: user
users:
  - name: user
    user:
      token: %s
`, server.URL, token)
	path := t.TempDir() + "/config"
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	connection := model.Connection{
		ID: "connection", Name: "cluster", Kind: model.ConnectionKubernetes,
		Kubernetes: &model.KubernetesConnection{KubeconfigSource: "path", KubeconfigPath: path},
	}
	provider, err := NewKubeconfigProvider(connection, nil, model.DefaultSettings)
	if err != nil {
		t.Fatal(err)
	}
	info, err := provider.Test(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.Details["server"] != "v1.32.1" {
		t.Fatalf("server version = %q", info.Details["server"])
	}
	if info.Details["authentication"] != "bearer-token" {
		t.Fatalf("authentication = %q", info.Details["authentication"])
	}
	namespaces, err := provider.Namespaces(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(namespaces, ",") != "apps,default" {
		t.Fatalf("namespaces = %#v", namespaces)
	}
}

func TestFlattenKubeconfigRejectsExecCredentialBinary(t *testing.T) {
	source := []byte(`apiVersion: v1
current-context: test
clusters:
  - name: cluster
    cluster:
      server: https://cluster.example
contexts:
  - name: test
    context:
      cluster: cluster
      user: user
users:
  - name: user
    user:
      exec:
        command: aws
`)
	_, err := FlattenKubeconfig(source, "", "deny", nil)
	if err == nil || !strings.Contains(err.Error(), `requires exec credential plugin "aws"`) {
		t.Fatalf("error = %v", err)
	}
}

func containsSequence(values []string, sequence ...string) bool {
	if len(sequence) == 0 {
		return true
	}
	for i := 0; i+len(sequence) <= len(values); i++ {
		matched := true
		for j := range sequence {
			if values[i+j] != sequence[j] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}
