package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/activity"
	"github.com/Doout/runwake/internal/agent"
	"github.com/Doout/runwake/internal/metrics"
	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
	"github.com/Doout/runwake/internal/store"
	"github.com/Doout/runwake/internal/workloadcache"
)

type Config struct {
	State               *store.Store
	Secrets             *store.SecretStore
	Factory             provider.Factory
	Activities          *activity.Manager
	Metrics             *metrics.Manager
	Workloads           workloadcache.Cache
	Agents              *agent.Hub
	Assets              fs.FS
	AuthToken           string
	Logger              *slog.Logger
	Version             string
	RemoteAgentsEnabled bool
}

type Server struct {
	state               *store.Store
	secrets             *store.SecretStore
	factory             provider.Factory
	activities          *activity.Manager
	metrics             *metrics.Manager
	workloads           workloadcache.Cache
	agents              *agent.Hub
	auth                *auth
	assets              fs.FS
	logger              *slog.Logger
	version             string
	remoteAgentsEnabled bool
}

func New(config Config) (*Server, error) {
	if config.State == nil || config.Secrets == nil || config.Factory == nil || config.Activities == nil || config.Metrics == nil || config.Workloads == nil || config.Agents == nil || config.Assets == nil {
		return nil, errors.New("server configuration is incomplete")
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	return &Server{
		state:               config.State,
		secrets:             config.Secrets,
		factory:             config.Factory,
		activities:          config.Activities,
		metrics:             config.Metrics,
		workloads:           config.Workloads,
		agents:              config.Agents,
		auth:                newAuth(config.AuthToken),
		assets:              config.Assets,
		logger:              config.Logger,
		version:             config.Version,
		remoteAgentsEnabled: config.RemoteAgentsEnabled,
	}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.handleHealth)
	mux.HandleFunc("POST /api/v1/auth/login", s.auth.login)
	mux.HandleFunc("POST /api/v1/auth/logout", s.auth.logout)
	if s.remoteAgentsEnabled {
		mux.HandleFunc("GET /api/v1/agent/commands", s.handleAgentCommands)
		mux.HandleFunc("POST /api/v1/agent/events", s.handleAgentEvents)
	}

	api := http.NewServeMux()
	api.HandleFunc("GET /api/v1/meta", s.handleMeta)
	api.HandleFunc("GET /api/v1/settings", s.handleSettingsGet)
	api.HandleFunc("PUT /api/v1/settings", s.handleSettingsPut)
	api.HandleFunc("GET /api/v1/connections", s.handleConnectionsList)
	api.HandleFunc("POST /api/v1/connections", s.handleConnectionsCreate)
	api.HandleFunc("POST /api/v1/connections/test", s.handleConnectionTestDraft)
	api.HandleFunc("POST /api/v1/ssh/test", s.handleSSHTest)
	api.HandleFunc("GET /api/v1/ssh-profiles", s.handleSSHProfilesList)
	api.HandleFunc("POST /api/v1/ssh-profiles", s.handleSSHProfileCreate)
	api.HandleFunc("POST /api/v1/ssh-profiles/{id}/test", s.handleSSHProfileTest)
	api.HandleFunc("DELETE /api/v1/ssh-profiles/{id}", s.handleSSHProfileDelete)
	api.HandleFunc("POST /api/v1/kubernetes/import-cloud", s.handleCloudKubeconfigImport)
	api.HandleFunc("GET /api/v1/connections/{id}", s.handleConnectionGet)
	api.HandleFunc("PATCH /api/v1/connections/{id}", s.handleConnectionUpdate)
	api.HandleFunc("POST /api/v1/connections/{id}/test", s.handleConnectionTest)
	api.HandleFunc("DELETE /api/v1/connections/{id}", s.handleConnectionDelete)
	api.HandleFunc("POST /api/v1/connections/{id}/docker/containers/{container_id}/restart", s.handleDockerContainerRestart)
	api.HandleFunc("DELETE /api/v1/connections/{id}/docker/containers/{container_id}", s.handleDockerContainerDelete)
	api.HandleFunc("POST /api/v1/connections/{id}/docker/compose/restart", s.handleDockerComposeRestart)
	if s.remoteAgentsEnabled {
		api.HandleFunc("POST /api/v1/agents/enroll", s.handleAgentEnroll)
		api.HandleFunc("POST /api/v1/connections/{id}/agent", s.handleAgentDeploy)
		api.HandleFunc("POST /api/v1/connections/{id}/rotate-token", s.handleAgentRotateToken)
		api.HandleFunc("DELETE /api/v1/connections/{id}/agent", s.handleAgentRemove)
	}
	api.HandleFunc("GET /api/v1/workloads", s.handleWorkloads)
	api.HandleFunc("GET /api/v1/workloads/cache", s.handleWorkloadCache)
	api.HandleFunc("GET /api/v1/workloads/stream", s.handleWorkloadsStream)
	api.HandleFunc("GET /api/v1/namespaces", s.handleNamespaces)
	api.HandleFunc("GET /api/v1/activity/stream", s.handleActivityStream)
	api.HandleFunc("GET /api/v1/metrics", s.handleMetrics)
	api.HandleFunc("GET /api/v1/metrics/stream", s.handleMetricsStream)
	mux.Handle("/api/v1/", s.auth.middleware(api))
	mux.Handle("/", spaHandler(s.assets))
	return securityHeaders(s.requestLog(mux))
}

func (s *Server) availableConnections() []model.Connection {
	connections := s.state.ListConnections()
	if s.remoteAgentsEnabled {
		return connections
	}
	available := make([]model.Connection, 0, len(connections))
	for _, connection := range connections {
		if connection.Mode != model.ModeAgent {
			available = append(available, connection)
		}
	}
	return available
}

func (s *Server) CleanupExpiredAgents(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	s.cleanupExpired(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.cleanupExpired(ctx)
		}
	}
}
func (s *Server) cleanupExpired(ctx context.Context) {
	now := time.Now().UTC()
	for _, connection := range s.state.ListConnections() {
		if connection.Mode != model.ModeAgent || connection.Agent == nil {
			continue
		}
		expiresAt := connection.Agent.ExpiresAt
		if connection.Deployment != nil && !connection.Deployment.ExpiresAt.IsZero() {
			expiresAt = connection.Deployment.ExpiresAt
		}
		if expiresAt.IsZero() || now.Before(expiresAt) {
			continue
		}
		var err error
		if connection.Deployment != nil {
			err = s.removeAgentConnection(ctx, connection)
		} else {
			err = s.state.DeleteConnection(connection.ID)
		}
		if err != nil {
			s.logger.Warn("temporary agent cleanup failed", "connection", connection.ID, "error", err)
		}
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": s.version, "time": time.Now().UTC()})
}
func (s *Server) handleMeta(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"name":          "Runwake",
		"version":       s.version,
		"auth_required": s.auth.required(),
		"features": map[string]bool{
			"remote_agents": s.remoteAgentsEnabled,
		},
	})
}

func (s *Server) requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			s.logger.Debug("http request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(start))
		}
	})
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request: "+err.Error())
		return false
	}
	return true
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
