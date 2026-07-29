package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Doout/runwake/internal/agent"
	"github.com/Doout/runwake/internal/dockerapi"
	"github.com/Doout/runwake/internal/kube"
	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
)

func main() {
	if err := run(os.Args[1:]); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		fmt.Fprintln(os.Stderr, "runwake-agent:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("runwake-agent", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	serverURL := flags.String("server", os.Getenv("RUNWAKE_SERVER_URL"), "Runwake server URL")
	connectionID := flags.String("connection-id", os.Getenv("RUNWAKE_CONNECTION_ID"), "agent connection ID")
	token := flags.String("token", os.Getenv("RUNWAKE_AGENT_TOKEN"), "agent enrollment token")
	kind := flags.String("kind", envOr("RUNWAKE_AGENT_KIND", model.ConnectionKubernetes), "kubernetes or docker")
	name := flags.String("name", envOr("RUNWAKE_CONNECTION_NAME", "remote"), "connection display name")
	namespacesRaw := flags.String("namespaces", os.Getenv("RUNWAKE_NAMESPACES"), "comma-separated Kubernetes namespace scope")
	tailLines := flags.Int("tail-lines", envInt("RUNWAKE_TAIL_LINES", 200), "initial lines per log stream")
	dockerEndpoint := flags.String("docker-endpoint", envOr("RUNWAKE_DOCKER_ENDPOINT", "unix:///var/run/docker.sock"), "Docker Engine endpoint")
	dockerCAFile := flags.String("docker-ca-file", os.Getenv("RUNWAKE_DOCKER_CA_FILE"), "Docker CA certificate file")
	dockerCertFile := flags.String("docker-cert-file", os.Getenv("RUNWAKE_DOCKER_CERT_FILE"), "Docker client certificate file")
	dockerKeyFile := flags.String("docker-key-file", os.Getenv("RUNWAKE_DOCKER_KEY_FILE"), "Docker client key file")
	dockerServerName := flags.String("docker-server-name", os.Getenv("RUNWAKE_DOCKER_TLS_SERVER_NAME"), "Docker TLS server name")
	caFile := flags.String("ca-file", os.Getenv("RUNWAKE_AGENT_CA_FILE"), "custom CA for the Runwake server")
	insecure := flags.Bool("insecure-skip-verify", envBool("RUNWAKE_AGENT_INSECURE_SKIP_VERIFY"), "skip TLS verification for the Runwake server")
	temporaryTTL := flags.Duration("temporary-ttl", envDuration("RUNWAKE_TEMPORARY_TTL"), "stop the agent after this duration")
	inventoryInterval := flags.Duration("inventory-interval", envDurationOr("RUNWAKE_INVENTORY_INTERVAL", 30*time.Second), "workload and metrics snapshot refresh interval")
	logLevel := flags.String("log-level", envOr("RUNWAKE_LOG_LEVEL", "info"), "debug, info, warn, or error")
	showVersion := flags.Bool("version", false, "print version")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *showVersion {
		fmt.Println(agent.Version)
		return nil
	}
	logger, err := newLogger(*logLevel)
	if err != nil {
		return err
	}

	var source provider.Provider
	switch strings.ToLower(strings.TrimSpace(*kind)) {
	case model.ConnectionKubernetes:
		source, err = kube.NewInClusterProvider(*connectionID, *name, cleanList(*namespacesRaw), *tailLines)
	case model.ConnectionDocker:
		material := dockerapi.TLSMaterial{ServerName: *dockerServerName}
		for path, destination := range map[string]*[]byte{
			*dockerCAFile: &material.CA, *dockerCertFile: &material.Cert, *dockerKeyFile: &material.Key,
		} {
			if strings.TrimSpace(path) == "" {
				continue
			}
			data, readErr := os.ReadFile(path) //nolint:gosec // TLS file paths are explicit local operator configuration.
			if readErr != nil {
				return fmt.Errorf("read Docker TLS file %s: %w", path, readErr)
			}
			*destination = data
		}
		source, err = provider.NewDockerRuntimeProvider(*connectionID, *name, *dockerEndpoint, material)
	default:
		return fmt.Errorf("agent kind must be %q or %q", model.ConnectionKubernetes, model.ConnectionDocker)
	}
	if err != nil {
		return err
	}
	client, err := agent.NewClient(agent.ClientConfig{
		ServerURL:          *serverURL,
		ConnectionID:       *connectionID,
		Token:              *token,
		Kind:               strings.ToLower(strings.TrimSpace(*kind)),
		CAFile:             *caFile,
		InsecureSkipVerify: *insecure,
		InventoryInterval:  *inventoryInterval,
		TemporaryTTL:       *temporaryTTL,
	}, source, logger)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("starting Runwake agent", "kind", *kind, "connection_id", *connectionID, "server", *serverURL)
	return client.Run(ctx)
}

func cleanList(value string) []string {
	seen := map[string]bool{}
	var result []string
	for _, candidate := range strings.Split(value, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate != "" && !seen[candidate] {
			seen[candidate] = true
			result = append(result, candidate)
		}
	}
	return result
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
func envBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
func envInt(key string, fallback int) int {
	var value int
	if _, err := fmt.Sscanf(strings.TrimSpace(os.Getenv(key)), "%d", &value); err == nil && value >= 0 {
		return value
	}
	return fallback
}
func envDuration(key string) time.Duration {
	value, _ := time.ParseDuration(strings.TrimSpace(os.Getenv(key)))
	return value
}
func envDurationOr(key string, fallback time.Duration) time.Duration {
	value := envDuration(key)
	if value <= 0 {
		return fallback
	}
	return value
}
func newLogger(value string) (*slog.Logger, error) {
	var level slog.Level
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "debug":
		level = slog.LevelDebug
	case "", "info":
		level = slog.LevelInfo
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		return nil, fmt.Errorf("unknown log level %q", value)
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})), nil
}
