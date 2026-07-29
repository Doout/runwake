package app

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/store"
)

func TestAutoConnectLocalDockerUsesFirstReachableEngine(t *testing.T) {
	state, err := store.Open(t.TempDir(), model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	socketDir, err := os.MkdirTemp("/tmp", "runwake-app-test-") //nolint:usetesting // Unix-domain socket paths have a low platform length limit.
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDir) })
	socket := filepath.Join(socketDir, "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	engine := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/version" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, `{"Version":"29.6.1","ApiVersion":"1.55"}`)
	})}
	go func() { _ = engine.Serve(listener) }()
	t.Cleanup(func() {
		_ = engine.Shutdown(context.Background())
	})

	endpoint := "unix://" + socket
	autoConnectLocalDocker(
		context.Background(),
		state,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		[]string{"unix:///does/not/exist.sock", endpoint},
	)
	connections := state.ListConnections()
	if len(connections) != 1 {
		t.Fatalf("connections = %#v", connections)
	}
	connection := connections[0]
	if connection.Name != "Local Docker" || connection.Kind != model.ConnectionDocker || connection.Mode != model.ModeDirect || connection.Docker == nil || connection.Docker.Endpoint != endpoint {
		t.Fatalf("unexpected connection: %#v", connection)
	}
}

func TestAutoConnectLocalDockerDoesNotAlterConfiguredProfile(t *testing.T) {
	state, err := store.Open(t.TempDir(), model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	existing := model.Connection{ID: "cluster", Name: "Existing cluster", Kind: model.ConnectionKubernetes, Mode: model.ModeDirect}
	if err := state.SaveConnection(existing); err != nil {
		t.Fatal(err)
	}
	autoConnectLocalDocker(
		context.Background(),
		state,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		[]string{"unix:///var/run/docker.sock"},
	)
	connections := state.ListConnections()
	if len(connections) != 1 || connections[0].ID != existing.ID {
		t.Fatalf("configured profile changed: %#v", connections)
	}
}

func TestShutdownCancelsServerRequestContext(t *testing.T) {
	running, err := Start(context.Background(), ServerConfig{
		Listen:      "127.0.0.1:0",
		DataDir:     t.TempDir(),
		OpenBrowser: false,
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}

	requestContext := running.HTTP.BaseContext(running.Listener)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := running.Shutdown(shutdownCtx); err != nil {
		t.Fatal(err)
	}

	select {
	case <-requestContext.Done():
	case <-time.After(100 * time.Millisecond):
		t.Fatal("server request context remained active after shutdown")
	}
}
