package server

import (
	"context"
	"strings"
	"testing"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/store"
)

func TestSSHConfigFromBodyParsesUserTarget(t *testing.T) {
	config, err := sshConfigFromBody(&sshConnectionBody{Host: "ubuntu@server.example.com", Port: 2222})
	if err != nil {
		t.Fatal(err)
	}
	if config.Host != "server.example.com" || config.User != "ubuntu" || config.Port != 2222 || config.HostKeyPolicy != "accept-new" {
		t.Fatalf("unexpected SSH config: %#v", config)
	}
}

func TestDockerAgentRunArgsDoNotUseAShell(t *testing.T) {
	request := agentEnrollRequest{
		Mode: "persistent", Image: "registry.example.com/runwake-agent:0.1.0",
		DockerSocketPath: "/var/run/docker.sock",
	}
	args := dockerAgentRunArgs("runwake-agent-test", request, map[string]string{
		"RUNWAKE_AGENT_TOKEN": "token with spaces",
	}, "998")
	joined := strings.Join(args, "\n")
	for _, expected := range []string{"docker", "run", "--group-add", "998", "RUNWAKE_AGENT_TOKEN=token with spaces", request.Image} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q from %#v", expected, args)
		}
	}
	if strings.Contains(joined, "sh -c") {
		t.Fatalf("agent command unexpectedly uses a shell: %#v", args)
	}
}

func TestSSHConnectionRedactsPrivateKeyReference(t *testing.T) {
	connection := model.Connection{SSH: &model.SSHConnection{Host: "server", PrivateKeySecret: "secret_private"}}
	if connection.Redacted().SSH.PrivateKeySecret != "" {
		t.Fatal("SSH private key reference leaked")
	}
}

func TestBuildDockerSSHConnectionEncryptsPrivateKey(t *testing.T) {
	secrets, err := store.OpenSecretStore(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{secrets: secrets}
	connection, secretIDs, err := server.buildConnection(context.Background(), connectionRequest{
		Name: "remote Docker", Kind: model.ConnectionDocker,
		Docker: &dockerConnectionBody{Endpoint: "/var/run/docker.sock"},
		SSH:    &sshConnectionBody{Host: "docker.example.com", User: "ubuntu", PrivateKey: "private key"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if connection.SSH == nil || len(secretIDs) != 1 || connection.SSH.PrivateKeySecret != secretIDs[0] {
		t.Fatalf("SSH secret was not stored: %#v %#v", connection, secretIDs)
	}
	key, err := secrets.Get(connection.SSH.PrivateKeySecret)
	if err != nil || string(key) != "private key" {
		t.Fatalf("stored SSH key = %q, %v", key, err)
	}
	if connection.Redacted().SSH.PrivateKeySecret != "" {
		t.Fatal("redacted connection leaked the SSH secret reference")
	}
}

func TestBuildDockerConnectionCombinesSSHAndHTTPProxy(t *testing.T) {
	secrets, err := store.OpenSecretStore(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{secrets: secrets}
	connection, secretIDs, err := server.buildConnection(context.Background(), connectionRequest{
		Name: "proxied remote Docker", Kind: model.ConnectionDocker,
		Docker:    &dockerConnectionBody{Endpoint: "tcp://engine.internal:2375"},
		SSH:       &sshConnectionBody{Host: "bastion.example.com", User: "ubuntu"},
		HTTPProxy: &httpProxyBody{URL: "http://operator:secret@proxy.internal:8080", NoProxy: []string{"localhost"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if connection.SSH == nil || connection.HTTPProxy == nil || len(secretIDs) != 1 {
		t.Fatalf("combined route was not stored: %#v %#v", connection, secretIDs)
	}
	value, err := secrets.Get(connection.HTTPProxy.URLSecret)
	if err != nil || string(value) != "http://operator:secret@proxy.internal:8080" {
		t.Fatalf("stored proxy URL = %q, %v", value, err)
	}
	if connection.Redacted().HTTPProxy.URLSecret != "" || strings.Contains(connection.Redacted().HTTPProxy.DisplayURL, "operator") {
		t.Fatal("combined route leaked proxy credentials")
	}
}

func TestBuildSSHClusterPreservesRemoteHomePath(t *testing.T) {
	secrets, err := store.OpenSecretStore(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{secrets: secrets}
	connection, _, err := server.buildConnection(context.Background(), connectionRequest{
		Name: "remote cluster", Kind: model.ConnectionKubernetes,
		Kubernetes: &kubernetesConnectionBody{
			KubeconfigSource: "path", KubeconfigPath: "~/.kube/config", NamespaceMode: "all",
		},
		SSH: &sshConnectionBody{Host: "bastion.example.com", User: "ubuntu"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if connection.Kubernetes == nil || connection.Kubernetes.KubeconfigPath != "~/.kube/config" {
		t.Fatalf("remote kubeconfig path was rewritten locally: %#v", connection.Kubernetes)
	}
}
