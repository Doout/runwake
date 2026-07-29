package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/agent"
	"github.com/Doout/runwake/internal/deploy"
	"github.com/Doout/runwake/internal/kube"
	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/sshx"
	"github.com/Doout/runwake/internal/store"
)

type agentDeployRequest struct {
	Name       string   `json:"name"`
	Mode       string   `json:"mode"`
	ServerURL  string   `json:"server_url"`
	Image      string   `json:"image"`
	Namespace  string   `json:"namespace"`
	Namespaces []string `json:"namespaces"`
	TTLSeconds int64    `json:"ttl_seconds"`
	Manual     bool     `json:"manual"`
}
type manifestOperator interface {
	ApplyManifest(ctx context.Context, manifest string) error
	DeleteManifest(ctx context.Context, manifest string) error
}

func (s *Server) handleAgentDeploy(w http.ResponseWriter, r *http.Request) {
	bootstrap, ok := s.state.GetConnection(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "bootstrap connection not found")
		return
	}
	if bootstrap.Kind != model.ConnectionKubernetes || bootstrap.Mode != model.ModeDirect {
		writeError(w, http.StatusBadRequest, "agents can only be deployed through a direct Kubernetes connection")
		return
	}
	var request agentDeployRequest
	if !decodeJSON(w, r, 256<<10, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	request.Mode = strings.ToLower(strings.TrimSpace(request.Mode))
	request.ServerURL = strings.TrimRight(strings.TrimSpace(request.ServerURL), "/")
	request.Image = strings.TrimSpace(request.Image)
	request.Namespace = strings.TrimSpace(request.Namespace)
	request.Namespaces = cleanList(request.Namespaces)
	if request.Mode == "" {
		request.Mode = "persistent"
	}
	settings := s.state.Settings()
	if request.ServerURL == "" {
		request.ServerURL = strings.TrimRight(strings.TrimSpace(settings.PublicURL), "/")
	}
	if request.Image == "" {
		request.Image = strings.TrimSpace(settings.DefaultAgentImage)
	}
	if request.ServerURL == "" || request.Image == "" {
		writeError(w, http.StatusBadRequest, "server URL and agent image are required")
		return
	}
	parsedURL, err := url.Parse(request.ServerURL)
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
		writeError(w, http.StatusBadRequest, "server URL must be an absolute http or https URL")
		return
	}
	token, err := agent.GenerateToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	agentID := store.NewID("connection")
	ttl := time.Duration(request.TTLSeconds) * time.Second
	result, err := deploy.Build(deploy.Request{ConnectionID: agentID, Name: request.Name, Mode: request.Mode, ServerURL: request.ServerURL, Token: token, Image: request.Image, Namespace: request.Namespace, Namespaces: request.Namespaces, TTL: ttl, InventoryInterval: time.Duration(settings.OverviewMetricsIntervalSeconds) * time.Second})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	manifestSecret, err := s.secrets.Put([]byte(result.TeardownManifest))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	result.Deployment.BootstrapConnectionID = bootstrap.ID
	result.Deployment.ManifestSecret = manifestSecret
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = bootstrap.Name + " agent"
	}
	connection := model.Connection{ID: agentID, Name: name, Kind: model.ConnectionKubernetes, Mode: model.ModeAgent, Agent: &model.AgentConnection{TokenHash: agent.HashToken(token), RunMode: request.Mode, ServerURL: request.ServerURL, Image: request.Image, Namespaces: append([]string(nil), result.Deployment.Namespaces...), ExpiresAt: result.Deployment.ExpiresAt}, Deployment: &result.Deployment}
	var operator manifestOperator
	applied := false
	if !request.Manual {
		p, providerErr := s.factory.ProviderFor(bootstrap)
		if providerErr != nil {
			_ = s.secrets.Delete(manifestSecret)
			writeError(w, http.StatusBadRequest, providerErr.Error())
			return
		}
		var supported bool
		operator, supported = p.(manifestOperator)
		if !supported {
			_ = s.secrets.Delete(manifestSecret)
			writeError(w, http.StatusBadRequest, "bootstrap connection cannot apply Kubernetes manifests")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		err = operator.ApplyManifest(ctx, result.ApplyManifest)
		cancel()
		if err != nil {
			_ = s.secrets.Delete(manifestSecret)
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		applied = true
	}
	if err := s.state.SaveConnection(connection); err != nil {
		if applied && operator != nil {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.WithoutCancel(r.Context()), 45*time.Second)
			cleanupErr := operator.DeleteManifest(cleanupCtx, result.TeardownManifest)
			cleanupCancel()
			if cleanupErr != nil {
				s.logger.Error("agent deployment rollback failed", "connection", agentID, "error", cleanupErr)
			}
		}
		_ = s.secrets.Delete(manifestSecret)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	response := map[string]any{"connection": connection.Redacted(), "applied": !request.Manual}
	if request.Manual {
		response["manifest"] = result.ApplyManifest
		response["teardown_manifest"] = result.TeardownManifest
	}
	writeJSON(w, http.StatusCreated, response)
}

func (s *Server) handleAgentRemove(w http.ResponseWriter, r *http.Request) {
	connection, ok := s.state.GetConnection(r.PathValue("id"))
	if !ok {
		// DELETE is intentionally idempotent so operators can safely retry
		// cleanup after a timeout or interrupted response.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if connection.Mode != model.ModeAgent || connection.Deployment == nil {
		writeError(w, http.StatusBadRequest, "connection is not a deployed agent")
		return
	}
	if err := s.removeAgentConnection(r.Context(), connection); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) removeAgentConnection(ctx context.Context, connection model.Connection) error {
	deployment := connection.Deployment
	if deployment == nil {
		return errors.New("agent deployment metadata is missing")
	}
	if deployment.Transport == "ssh" {
		if err := s.removeSSHDeployment(ctx, connection); err != nil {
			return err
		}
		s.deleteConnectionSecrets(connection)
		return s.state.DeleteConnection(connection.ID)
	}
	bootstrap, ok := s.state.GetConnection(deployment.BootstrapConnectionID)
	if !ok {
		return errors.New("bootstrap connection no longer exists")
	}
	manifest, err := s.secrets.Get(deployment.ManifestSecret)
	if err != nil {
		return fmt.Errorf("read teardown manifest: %w", err)
	}
	p, err := s.factory.ProviderFor(bootstrap)
	if err != nil {
		return err
	}
	operator, ok := p.(manifestOperator)
	if !ok {
		return errors.New("bootstrap connection cannot delete Kubernetes manifests")
	}
	deleteCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	err = operator.DeleteManifest(deleteCtx, string(manifest))
	cancel()
	if err != nil {
		return err
	}
	_ = s.secrets.Delete(deployment.ManifestSecret)
	return s.state.DeleteConnection(connection.ID)
}

func dockerAgentRunArgs(containerName string, request agentEnrollRequest, environment map[string]string, socketGroup string) []string {
	args := []string{"docker", "run"}
	if request.Mode == "temporary" {
		args = append(args, "-d", "--rm")
	} else {
		args = append(args, "-d", "--restart", "unless-stopped")
	}
	args = append(args,
		"--name", containerName,
		"--read-only",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--group-add", socketGroup,
		"-v", request.DockerSocketPath+":/var/run/docker.sock",
	)
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		args = append(args, "-e", key+"="+environment[key])
	}
	args = append(args, request.Image)
	return args
}

func (s *Server) removeSSHDeployment(ctx context.Context, connection model.Connection) error {
	if connection.Deployment == nil || connection.SSH == nil {
		return errors.New("SSH deployment metadata is missing")
	}
	config, err := sshx.Load(connection.SSH, s.secrets)
	if err != nil {
		return err
	}
	deployment := connection.Deployment
	switch deployment.TargetKind {
	case model.ConnectionKubernetes:
		manifest, readErr := s.secrets.Get(deployment.ManifestSecret)
		if readErr != nil {
			return fmt.Errorf("read SSH teardown manifest: %w", readErr)
		}
		binary := strings.TrimSpace(deployment.RemoteKubectlPath)
		if binary == "" {
			binary = "kubectl"
		}
		kubeconfig := sshx.NormalizeRemotePath(deployment.RemoteKubeconfigPath, ".kube/config")
		_, _, err = config.Run(ctx, manifest, nil, binary, "--kubeconfig", kubeconfig, "delete", "-f", "-", "--ignore-not-found=true", "--wait=false")
	case model.ConnectionDocker:
		socket := sshx.NormalizeRemotePath(deployment.DockerSocketPath, "/var/run/docker.sock")
		_, _, err = config.Run(ctx, nil, map[string]string{"DOCKER_HOST": "unix://" + socket}, "docker", "rm", "-f", deployment.ResourceName)
		if err != nil && strings.Contains(strings.ToLower(err.Error()), "no such container") {
			err = nil
		}
	default:
		err = errors.New("unsupported SSH deployment target")
	}
	return err
}

func (s *Server) handleAgentCommands(w http.ResponseWriter, r *http.Request) {
	connectionID, token, ok := agentCredentials(r)
	if !ok || !s.agents.Authenticate(connectionID, token) {
		writeError(w, http.StatusUnauthorized, "invalid agent credentials")
		return
	}
	commands, detach := s.agents.AttachCommands(connectionID)
	defer detach()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case command := <-commands:
			data, _ := json.Marshal(command)
			_, _ = fmt.Fprintf(w, "event: command\ndata: %s\n\n", data)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) handleAgentEvents(w http.ResponseWriter, r *http.Request) {
	connectionID, token, ok := agentCredentials(r)
	if !ok || !s.agents.Authenticate(connectionID, token) {
		writeError(w, http.StatusUnauthorized, "invalid agent credentials")
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.EnableFullDuplex()
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	scanner := bufio.NewScanner(r.Body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		var message agent.Message
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		if message.ConnectionID != "" && message.ConnectionID != connectionID {
			continue
		}
		s.agents.HandleMessage(connectionID, message)
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, context.Canceled) {
		s.logger.Debug("agent event stream closed", "connection", connectionID, "error", err)
	}
}
func agentCredentials(r *http.Request) (string, string, bool) {
	connectionID := strings.TrimSpace(r.Header.Get("X-Runwake-Connection"))
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if connectionID == "" || !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return "", "", false
	}
	return connectionID, strings.TrimSpace(header[7:]), true
}

func (s *Server) handleActivityStream(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	request := model.StreamRequest{
		ConnectionID: q.Get("connection_id"),
		Kind:         q.Get("kind"),
		Namespace:    q.Get("namespace"),
		Name:         q.Get("name"),
		Pod:          q.Get("pod"),
		Container:    q.Get("container"),
		Previous:     q.Get("previous") != "false",
		Events:       q.Get("events") == "true",
	}
	if value := q.Get("tail_lines"); value != "" {
		request.TailLines, _ = strconv.Atoi(value)
	}
	if request.ConnectionID == "" || request.Kind == "" || request.Name == "" {
		writeError(w, http.StatusBadRequest, "connection_id, kind, and name are required")
		return
	}
	connection, ok := s.state.GetConnection(request.ConnectionID)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	records, unsubscribe, err := s.activities.Subscribe(r.Context(), connection, request)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case record, ok := <-records:
			if !ok {
				return
			}
			data, _ := json.Marshal(record)
			_, _ = fmt.Fprintf(w, "id: %d\nevent: activity\ndata: %s\n\n", record.Sequence, data)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

var _ = kube.NewKubectlProvider

type agentEnrollRequest struct {
	Name                 string             `json:"name"`
	Kind                 string             `json:"kind"`
	ServerURL            string             `json:"server_url"`
	Image                string             `json:"image"`
	Mode                 string             `json:"mode"`
	Namespace            string             `json:"namespace"`
	Namespaces           []string           `json:"namespaces"`
	TTLSeconds           int64              `json:"ttl_seconds"`
	SSH                  *sshConnectionBody `json:"ssh,omitempty"`
	SSHProfileID         string             `json:"ssh_profile_id,omitempty"`
	RemoteKubeconfigPath string             `json:"remote_kubeconfig_path,omitempty"`
	RemoteKubectlPath    string             `json:"remote_kubectl_path,omitempty"`
	DockerSocketPath     string             `json:"docker_socket_path,omitempty"`
}

// handleAgentEnroll creates credentials for an agent that the operator will
// start manually. Kubernetes callers also receive complete apply and teardown
// manifests. Runwake does not claim it can remove a manually deployed agent
// unless a direct bootstrap connection is also configured.
func (s *Server) handleAgentEnroll(w http.ResponseWriter, r *http.Request) {
	var request agentEnrollRequest
	if !decodeJSON(w, r, 256<<10, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	request.Kind = strings.ToLower(strings.TrimSpace(request.Kind))
	request.Mode = strings.ToLower(strings.TrimSpace(request.Mode))
	request.ServerURL = strings.TrimRight(strings.TrimSpace(request.ServerURL), "/")
	request.Image = strings.TrimSpace(request.Image)
	request.Namespaces = cleanList(request.Namespaces)
	resolvedSSH, resolveErr := s.resolveSSHBody(request.SSHProfileID, request.SSH)
	if resolveErr != nil {
		writeError(w, http.StatusBadRequest, resolveErr.Error())
		return
	}
	request.SSH = resolvedSSH
	if request.Name == "" {
		writeError(w, http.StatusBadRequest, "connection name is required")
		return
	}
	if request.Kind != model.ConnectionKubernetes && request.Kind != model.ConnectionDocker {
		writeError(w, http.StatusBadRequest, "agent kind must be kubernetes or docker")
		return
	}
	if request.Mode == "" {
		request.Mode = "persistent"
	}
	if request.Mode != "persistent" && request.Mode != "temporary" {
		writeError(w, http.StatusBadRequest, "agent mode must be persistent or temporary")
		return
	}
	settings := s.state.Settings()
	if request.ServerURL == "" {
		request.ServerURL = strings.TrimRight(strings.TrimSpace(settings.PublicURL), "/")
	}
	if request.Image == "" {
		request.Image = strings.TrimSpace(settings.DefaultAgentImage)
	}
	if request.ServerURL == "" {
		writeError(w, http.StatusBadRequest, "server URL is required")
		return
	}
	parsedURL, err := url.Parse(request.ServerURL)
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
		writeError(w, http.StatusBadRequest, "server URL must be an absolute http or https URL")
		return
	}
	if (request.Kind == model.ConnectionKubernetes || request.SSH != nil) && request.Image == "" {
		writeError(w, http.StatusBadRequest, "agent image is required")
		return
	}

	ttl := time.Duration(request.TTLSeconds) * time.Second
	if request.Mode == "temporary" && ttl <= 0 {
		ttl = 30 * time.Minute
	}
	connectionID := store.NewID("connection")
	token, err := agent.GenerateToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	agentConfig := &model.AgentConnection{TokenHash: agent.HashToken(token), RunMode: request.Mode, ServerURL: request.ServerURL, Image: request.Image, Namespaces: append([]string(nil), request.Namespaces...)}
	if request.Mode == "temporary" {
		agentConfig.ExpiresAt = time.Now().UTC().Add(ttl)
	}
	connection := model.Connection{
		ID: connectionID, Name: request.Name, Kind: request.Kind, Mode: model.ModeAgent,
		Agent: agentConfig,
	}

	var manifest *deploy.Result
	if request.Kind == model.ConnectionKubernetes {
		result, buildErr := deploy.Build(deploy.Request{
			ConnectionID: connection.ID, Name: request.Name, Mode: request.Mode,
			ServerURL: request.ServerURL, Token: token, Image: request.Image,
			Namespace: request.Namespace, Namespaces: request.Namespaces, TTL: ttl,
			InventoryInterval: time.Duration(settings.OverviewMetricsIntervalSeconds) * time.Second,
		})
		if buildErr != nil {
			writeError(w, http.StatusBadRequest, buildErr.Error())
			return
		}
		manifest = &result
		agentConfig.ExpiresAt = result.Deployment.ExpiresAt
	}
	environment := map[string]string{
		"RUNWAKE_SERVER_URL":         request.ServerURL,
		"RUNWAKE_CONNECTION_ID":      connection.ID,
		"RUNWAKE_AGENT_TOKEN":        token,
		"RUNWAKE_AGENT_KIND":         request.Kind,
		"RUNWAKE_CONNECTION_NAME":    request.Name,
		"RUNWAKE_INVENTORY_INTERVAL": (time.Duration(settings.OverviewMetricsIntervalSeconds) * time.Second).String(),
	}
	if len(request.Namespaces) > 0 {
		environment["RUNWAKE_NAMESPACES"] = strings.Join(request.Namespaces, ",")
	}
	if request.Mode == "temporary" {
		environment["RUNWAKE_TEMPORARY_TTL"] = ttl.String()
	}
	installed := false
	var sshSecret string
	var teardownSecret string
	if request.SSH != nil {
		sshModel, secretID, sshErr := s.storeSSHConnection(request.SSH)
		if sshErr != nil {
			writeError(w, http.StatusBadRequest, sshErr.Error())
			return
		}
		connection.SSH = sshModel
		sshSecret = secretID
		config, configErr := sshConfigFromBody(request.SSH)
		if configErr != nil {
			_ = s.secrets.Delete(sshSecret)
			writeError(w, http.StatusBadRequest, configErr.Error())
			return
		}
		deployCtx, deployCancel := context.WithTimeout(r.Context(), 60*time.Second)
		if request.Kind == model.ConnectionKubernetes {
			request.RemoteKubeconfigPath = sshx.NormalizeRemotePath(request.RemoteKubeconfigPath, ".kube/config")
			request.RemoteKubectlPath = strings.TrimSpace(request.RemoteKubectlPath)
			if request.RemoteKubectlPath == "" {
				request.RemoteKubectlPath = "kubectl"
			}
			_, _, err = config.Run(deployCtx, []byte(manifest.ApplyManifest), nil, request.RemoteKubectlPath, "--kubeconfig", request.RemoteKubeconfigPath, "apply", "-f", "-")
			applied := err == nil
			if err == nil {
				teardownSecret, err = s.secrets.Put([]byte(manifest.TeardownManifest))
			}
			if err == nil {
				deployment := manifest.Deployment
				deployment.Transport = "ssh"
				deployment.TargetKind = model.ConnectionKubernetes
				deployment.ManifestSecret = teardownSecret
				deployment.RemoteKubeconfigPath = request.RemoteKubeconfigPath
				deployment.RemoteKubectlPath = request.RemoteKubectlPath
				connection.Deployment = &deployment
			}
			if err != nil && applied {
				_, _, _ = config.Run(deployCtx, []byte(manifest.TeardownManifest), nil, request.RemoteKubectlPath, "--kubeconfig", request.RemoteKubeconfigPath, "delete", "-f", "-", "--ignore-not-found=true", "--wait=false")
			}
		} else {
			request.DockerSocketPath = sshx.NormalizeRemotePath(request.DockerSocketPath, "/var/run/docker.sock")
			if !strings.HasPrefix(request.DockerSocketPath, "/") {
				deployCancel()
				_ = s.secrets.Delete(sshSecret)
				writeError(w, http.StatusBadRequest, "remote Docker socket path must be absolute")
				return
			}
			containerName := "runwake-agent-" + strings.TrimPrefix(connection.ID, "connection_")
			if len(containerName) > 63 {
				containerName = containerName[:63]
			}
			var groupOutput []byte
			groupOutput, _, err = config.Run(deployCtx, nil, nil, "stat", "-c", "%g", request.DockerSocketPath)
			if err == nil {
				args := dockerAgentRunArgs(containerName, request, environment, strings.TrimSpace(string(groupOutput)))
				_, _, err = config.Run(deployCtx, nil, map[string]string{"DOCKER_HOST": "unix://" + request.DockerSocketPath}, args...)
			}
			if err == nil {
				connection.Deployment = &model.AgentDeployment{
					Mode: request.Mode, Transport: "ssh", TargetKind: model.ConnectionDocker,
					ResourceName: containerName, ExpiresAt: agentConfig.ExpiresAt,
					Image: request.Image, ServerURL: request.ServerURL,
					DockerSocketPath: request.DockerSocketPath,
				}
			}
		}
		deployCancel()
		if err != nil {
			_ = s.secrets.Delete(teardownSecret)
			_ = s.secrets.Delete(sshSecret)
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		installed = true
	}
	if err := s.state.SaveConnection(connection); err != nil {
		if installed {
			rollbackCtx, rollbackCancel := context.WithTimeout(context.WithoutCancel(r.Context()), 45*time.Second)
			if cleanupErr := s.removeSSHDeployment(rollbackCtx, connection); cleanupErr != nil {
				s.logger.Error("SSH agent deployment rollback failed", "connection", connection.ID, "error", cleanupErr)
			}
			rollbackCancel()
		}
		_ = s.secrets.Delete(teardownSecret)
		_ = s.secrets.Delete(sshSecret)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	response := map[string]any{
		"connection":  connection.Redacted(),
		"token":       token,
		"environment": environment,
		"mode":        request.Mode,
		"image":       request.Image,
		"installed":   installed,
	}
	if !agentConfig.ExpiresAt.IsZero() {
		response["expires_at"] = agentConfig.ExpiresAt
	}
	if manifest != nil && !installed {
		response["apply_manifest"] = manifest.ApplyManifest
		response["teardown_manifest"] = manifest.TeardownManifest
	}
	writeJSON(w, http.StatusCreated, response)
}

func (s *Server) handleAgentRotateToken(w http.ResponseWriter, r *http.Request) {
	connection, ok := s.state.GetConnection(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	if connection.Mode != model.ModeAgent || connection.Agent == nil {
		writeError(w, http.StatusBadRequest, "connection is not an agent")
		return
	}
	if connection.Deployment != nil {
		writeError(w, http.StatusConflict, "remove and redeploy managed agents to rotate their token")
		return
	}
	token, err := agent.GenerateToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	connection.Agent.TokenHash = agent.HashToken(token)
	connection.Agent.LastSeen = time.Time{}
	if err := s.state.UpdateConnection(connection); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connection": connection.Redacted(),
		"token":      token,
		"environment": map[string]string{
			"RUNWAKE_CONNECTION_ID": connection.ID,
			"RUNWAKE_AGENT_TOKEN":   token,
		},
	})
}
