package store

import (
	"path/filepath"
	"testing"

	"github.com/Doout/runwake/internal/model"
)

func TestConnectionRoundTripAndRedaction(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	c := model.Connection{
		ID: "k8s-1", Name: "production", Kind: model.ConnectionKubernetes, Mode: model.ModeDirect,
		Kubernetes: &model.KubernetesConnection{KubeconfigSource: "stored", KubeconfigSecret: "secret_123"},
		SSH:        &model.SSHConnection{Host: "cluster.example.com", PrivateKeySecret: "secret_456"},
	}
	if saveErr := s.SaveConnection(c); saveErr != nil {
		t.Fatal(saveErr)
	}
	reopened, err := Open(dir, model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	got, ok := reopened.GetConnection("k8s-1")
	if !ok {
		t.Fatal("connection missing")
	}
	if got.Kubernetes.KubeconfigSecret != "secret_123" {
		t.Fatal("secret reference missing")
	}
	if got.Redacted().Kubernetes.KubeconfigSecret != "" {
		t.Fatal("secret reference not redacted")
	}
	if got.SSH.PrivateKeySecret != "secret_456" || got.Redacted().SSH.PrivateKeySecret != "" {
		t.Fatal("SSH private key reference was not preserved and redacted correctly")
	}
}

func TestStoreReturnsIsolatedCopies(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	connection := model.Connection{
		ID: "agent-1", Name: "cluster", Kind: model.ConnectionKubernetes, Mode: model.ModeAgent,
		Agent:      &model.AgentConnection{Metadata: map[string]string{"hostname": "one"}},
		Deployment: &model.AgentDeployment{Namespaces: []string{"payments"}},
		HTTPProxy:  &model.HTTPProxyConnection{DisplayURL: "http://proxy.example.com:8080", NoProxy: []string{"localhost"}},
	}
	if err := s.SaveConnection(connection); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetConnection(connection.ID)
	got.Agent.Metadata["hostname"] = "mutated"
	got.Deployment.Namespaces[0] = "mutated"
	got.HTTPProxy.NoProxy[0] = "mutated"
	again, _ := s.GetConnection(connection.ID)
	if again.Agent.Metadata["hostname"] != "one" || again.Deployment.Namespaces[0] != "payments" || again.HTTPProxy.NoProxy[0] != "localhost" {
		t.Fatal("GetConnection leaked mutable store state")
	}
	settings := s.Settings()
	settings.ExecPluginAllowlist[0] = "mutated"
	if s.Settings().ExecPluginAllowlist[0] == "mutated" {
		t.Fatal("Settings leaked mutable store state")
	}
}

func TestSSHProfileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	profile := model.SSHProfile{
		ID: "ssh_profile_one", Name: "Production bastion", Host: "bastion.example.com",
		Port: 2222, User: "ubuntu", PrivateKeySecret: "secret_key", HostKeyPolicy: "strict",
	}
	if saveErr := s.SaveSSHProfile(profile); saveErr != nil {
		t.Fatal(saveErr)
	}
	reopened, err := Open(dir, model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	got, ok := reopened.GetSSHProfile(profile.ID)
	if !ok || got.Host != profile.Host || got.PrivateKeySecret != "secret_key" {
		t.Fatalf("unexpected SSH profile: %#v", got)
	}
	redacted := got.Redacted()
	if redacted.PrivateKeySecret != "" || !redacted.HasPrivateKey {
		t.Fatalf("SSH profile secret was not redacted: %#v", redacted)
	}
}

func TestStoreRollsBackMemoryWhenPersistenceFails(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	original := model.Connection{ID: "one", Name: "original", Kind: model.ConnectionDocker, Mode: model.ModeDirect}
	if err := s.SaveConnection(original); err != nil {
		t.Fatal(err)
	}
	s.dir = filepath.Join(dir, "missing", "directory")
	updated := original
	updated.Name = "updated"
	if err := s.SaveConnection(updated); err == nil {
		t.Fatal("expected persistence failure")
	}
	got, ok := s.GetConnection(original.ID)
	if !ok || got.Name != "original" {
		t.Fatalf("in-memory state was not rolled back: %#v", got)
	}
}

func TestSecretStoreRejectsPathTraversal(t *testing.T) {
	secrets, err := OpenSecretStore(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := secrets.Get("../../master.key"); err == nil {
		t.Fatal("expected invalid secret ID error")
	}
	if err := secrets.Delete("../secret_value"); err == nil {
		t.Fatal("expected invalid secret ID error")
	}
}
