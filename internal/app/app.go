package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/activity"
	"github.com/Doout/runwake/internal/agent"
	"github.com/Doout/runwake/internal/dockerapi"
	"github.com/Doout/runwake/internal/metrics"
	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
	"github.com/Doout/runwake/internal/server"
	"github.com/Doout/runwake/internal/store"
	"github.com/Doout/runwake/internal/workloadcache"
	"github.com/Doout/runwake/webembed"
)

var Version = "0.1.0"

type ServerConfig struct {
	Listen            string
	DataDir           string
	AuthToken         string
	SecretKey         string
	PublicURL         string
	DefaultAgentImage string
	OpenBrowser       bool
	AutoConnectDocker bool
	Logger            *slog.Logger
}

type RunningServer struct {
	URL      string
	HTTP     *http.Server
	Listener net.Listener
	Server   *server.Server
	cancel   context.CancelFunc
}

func DefaultDataDir() string {
	if value := strings.TrimSpace(os.Getenv("RUNWAKE_DATA_DIR")); value != "" {
		return value
	}
	configDir, err := os.UserConfigDir()
	if err == nil && configDir != "" {
		return filepath.Join(configDir, "runwake")
	}
	return filepath.Join(".", "runwake-data")
}

func Start(ctx context.Context, config ServerConfig) (*RunningServer, error) {
	if config.Listen == "" {
		config.Listen = "127.0.0.1:8080"
	}
	if config.DataDir == "" {
		config.DataDir = DefaultDataDir()
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	defaults := model.DefaultSettings()
	if config.PublicURL != "" {
		defaults.PublicURL = strings.TrimRight(config.PublicURL, "/")
	}
	if config.DefaultAgentImage != "" {
		defaults.DefaultAgentImage = config.DefaultAgentImage
	}
	state, err := store.Open(config.DataDir, defaults)
	if err != nil {
		return nil, err
	}
	secrets, err := store.OpenSecretStore(config.DataDir, config.SecretKey)
	if err != nil {
		return nil, err
	}
	hub := agent.NewHub(state)
	remoteFactory := &agent.RemoteProviderFactory{Hub: hub}
	factory := &provider.DirectFactory{Secrets: secrets, Settings: state.Settings, Agents: remoteFactory}
	if config.AutoConnectDocker && len(state.ListConnections()) == 0 {
		autoConnectLocalDocker(ctx, state, config.Logger, localDockerEndpoints(ctx))
	}
	activities := activity.NewManager(factory)
	metricStreams := metrics.NewManager(factory)
	workloads := workloadcache.NewMemory()
	appServer, err := server.New(server.Config{
		State:      state,
		Secrets:    secrets,
		Factory:    factory,
		Activities: activities,
		Metrics:    metricStreams,
		Workloads:  workloads,
		Agents:     hub,
		Assets:     webembed.FS(),
		AuthToken:  config.AuthToken,
		Logger:     config.Logger,
		Version:    Version,
		// Remote agents remain gated until their protocol and lifecycle are
		// ready for a supported release.
		RemoteAgentsEnabled: false,
	})
	if err != nil {
		return nil, err
	}

	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(ctx, "tcp", config.Listen)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", config.Listen, err)
	}
	serverCtx, cancel := context.WithCancel(ctx)
	httpServer := &http.Server{
		Handler:           appServer.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		BaseContext: func(net.Listener) context.Context {
			return serverCtx
		},
	}
	baseURL := publicListenURL(listener.Addr())
	running := &RunningServer{URL: baseURL, HTTP: httpServer, Listener: listener, Server: appServer, cancel: cancel}
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			config.Logger.Error("Runwake server stopped", "error", err)
		}
	}()
	if config.OpenBrowser {
		go func() {
			select {
			case <-ctx.Done():
				return
			case <-time.After(250 * time.Millisecond):
				if err := OpenBrowser(ctx, baseURL); err != nil {
					config.Logger.Warn("could not open browser", "url", baseURL, "error", err)
				}
			}
		}()
	}
	return running, nil
}

func autoConnectLocalDocker(ctx context.Context, state *store.Store, logger *slog.Logger, endpoints []string) {
	if len(state.ListConnections()) != 0 {
		return
	}
	for _, endpoint := range endpoints {
		checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		client, err := dockerapi.New(endpoint, dockerapi.TLSMaterial{})
		if err == nil {
			_, err = client.Negotiate(checkCtx)
		}
		cancel()
		if err != nil {
			continue
		}
		connection := model.Connection{
			ID:         store.NewID("connection"),
			Name:       "Local Docker",
			Kind:       model.ConnectionDocker,
			Mode:       model.ModeDirect,
			AccessMode: model.AccessReadOnly,
			Docker: &model.DockerConnection{
				Endpoint: endpoint,
			},
		}
		if err := state.SaveConnection(connection); err != nil {
			logger.Warn("could not save discovered local Docker connection", "endpoint", endpoint, "error", err)
			return
		}
		logger.Info("connected to local Docker", "endpoint", endpoint)
		return
	}
	logger.Info("local Docker was not detected")
}

func localDockerEndpoints(ctx context.Context) []string {
	var endpoints []string
	add := func(endpoint string) {
		endpoint = strings.TrimSpace(strings.Trim(endpoint, `"`))
		if endpoint == "" {
			return
		}
		if slices.Contains(endpoints, endpoint) {
			return
		}
		endpoints = append(endpoints, endpoint)
	}

	add(os.Getenv("DOCKER_HOST"))
	if dockerPath, err := exec.LookPath("docker"); err == nil {
		inspectCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		output, inspectErr := exec.CommandContext(inspectCtx, dockerPath, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output() //nolint:gosec // dockerPath is resolved with exec.LookPath and arguments are fixed.
		cancel()
		if inspectErr == nil {
			add(string(output))
		}
	}
	add("unix:///var/run/docker.sock")
	if home, err := os.UserHomeDir(); err == nil {
		for _, socket := range []string{
			".docker/run/docker.sock",
			"Library/Containers/com.docker.docker/Data/docker.raw.sock",
			".colima/default/docker.sock",
		} {
			add("unix://" + filepath.Join(home, socket))
		}
	}
	return endpoints
}

func (r *RunningServer) Shutdown(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.cancel()
	err := r.HTTP.Shutdown(ctx)
	if err == nil {
		return nil
	}
	// A provider or streaming client should stop when the server context is
	// canceled. Force-close any connection that does not honor cancellation so
	// a desktop window can never be held open by a stale request.
	if closeErr := r.HTTP.Close(); closeErr != nil && !errors.Is(closeErr, http.ErrServerClosed) {
		return errors.Join(err, closeErr)
	}
	return err
}

func publicListenURL(address net.Addr) string {
	host, port, err := net.SplitHostPort(address.String())
	if err != nil {
		return "http://" + address.String()
	}
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func OpenBrowser(ctx context.Context, url string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.CommandContext(ctx, "open", url) //nolint:gosec // The platform opener is fixed and the URL is one argument.
	case "windows":
		command = exec.CommandContext(ctx, "rundll32", "url.dll,FileProtocolHandler", url) //nolint:gosec // The platform opener is fixed and the URL is one argument.
	default:
		command = exec.CommandContext(ctx, "xdg-open", url) //nolint:gosec // The platform opener is fixed and the URL is one argument.
	}
	return command.Start()
}
