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

	"github.com/Doout/runwake/internal/app"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "runwake:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	command := "desktop"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "serve":
		return runServer(args, false)
	case "desktop":
		return runServer(args, true)
	case "version", "--version", "-version":
		fmt.Println(app.Version)
		return nil
	case "help", "--help", "-h":
		usage()
		return nil
	default:
		usage()
		return fmt.Errorf("unknown command %q", command)
	}
}

func runServer(args []string, desktop bool) error {
	name := "serve"
	defaultListen := envOr("RUNWAKE_LISTEN", "127.0.0.1:8080")
	defaultOpen := false
	if desktop {
		name = "desktop"
		defaultListen = "127.0.0.1:0"
		defaultOpen = true
	}
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	listen := flags.String("listen", defaultListen, "address to listen on")
	dataDir := flags.String("data-dir", app.DefaultDataDir(), "directory for configuration and encrypted credentials")
	authToken := flags.String("auth-token", os.Getenv("RUNWAKE_AUTH_TOKEN"), "optional web access token")
	secretKey := flags.String("secret-key", os.Getenv("RUNWAKE_SECRET_KEY"), "base64 32-byte credential encryption key")
	open := flags.Bool("open", defaultOpen, "open Runwake in the default browser")
	logLevel := flags.String("log-level", envOr("RUNWAKE_LOG_LEVEL", "info"), "debug, info, warn, or error")
	if err := flags.Parse(args); err != nil {
		return err
	}
	logger, err := newLogger(*logLevel)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	running, err := app.Start(ctx, app.ServerConfig{
		Listen:            *listen,
		DataDir:           *dataDir,
		AuthToken:         *authToken,
		SecretKey:         *secretKey,
		OpenBrowser:       *open,
		AutoConnectDocker: desktop,
		Logger:            logger,
	})
	if err != nil {
		return err
	}
	logger.Info("Runwake is ready", "url", running.URL, "data_dir", *dataDir, "mode", name)
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := running.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
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

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func usage() {
	fmt.Fprint(os.Stderr, `Runwake — live container and workload activity

Usage:
  runwake desktop [flags]  Start a private local Runwake session and open it
  runwake serve [flags]    Host Runwake for browser access
  runwake version          Print the version

Common environment variables:
  RUNWAKE_DATA_DIR, RUNWAKE_LISTEN
  RUNWAKE_AUTH_TOKEN, RUNWAKE_SECRET_KEY
`)
}
