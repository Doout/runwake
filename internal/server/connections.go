package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/kube"
	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
	"github.com/Doout/runwake/internal/proxyx"
	"github.com/Doout/runwake/internal/sshx"
	"github.com/Doout/runwake/internal/store"
)

type connectionRequest struct {
	Name         string                    `json:"name"`
	Kind         string                    `json:"kind"`
	SkipTest     bool                      `json:"skip_test"`
	Kubernetes   *kubernetesConnectionBody `json:"kubernetes,omitempty"`
	Docker       *dockerConnectionBody     `json:"docker,omitempty"`
	SSH          *sshConnectionBody        `json:"ssh,omitempty"`
	SSHProfileID string                    `json:"ssh_profile_id,omitempty"`
	HTTPProxy    *httpProxyBody            `json:"http_proxy,omitempty"`
}
type connectionUpdateRequest struct {
	Name string `json:"name"`
}
type kubernetesConnectionBody struct {
	KubeconfigSource string            `json:"kubeconfig_source"` // path | upload
	KubeconfigPath   string            `json:"kubeconfig_path,omitempty"`
	Kubeconfig       string            `json:"kubeconfig,omitempty"`
	Context          string            `json:"context,omitempty"`
	KubectlPath      string            `json:"kubectl_path,omitempty"`
	NamespaceMode    string            `json:"namespace_mode,omitempty"`
	Namespaces       []string          `json:"namespaces,omitempty"`
	ExecPolicy       string            `json:"exec_policy,omitempty"`
	ExecAllowlist    []string          `json:"exec_allowlist,omitempty"`
	Environment      map[string]string `json:"environment,omitempty"`
}
type dockerConnectionBody struct {
	Endpoint      string `json:"endpoint"`
	TLSCA         string `json:"tls_ca,omitempty"`
	TLSCert       string `json:"tls_cert,omitempty"`
	TLSKey        string `json:"tls_key,omitempty"`
	TLSServerName string `json:"tls_server_name,omitempty"`
}
type sshConnectionBody struct {
	Host           string `json:"host"`
	Port           int    `json:"port,omitempty"`
	User           string `json:"user,omitempty"`
	PrivateKey     string `json:"private_key,omitempty"`
	KnownHostsPath string `json:"known_hosts_path,omitempty"`
	HostKeyPolicy  string `json:"host_key_policy,omitempty"`
	ProxyJump      string `json:"proxy_jump,omitempty"`
}
type httpProxyBody struct {
	URL     string   `json:"url"`
	NoProxy []string `json:"no_proxy,omitempty"`
}

func (s *Server) handleConnectionsList(w http.ResponseWriter, _ *http.Request) {
	values := s.availableConnections()
	out := make([]model.ConnectionView, 0, len(values))
	for _, connection := range values {
		status := model.ConnectionStatus{State: "configured", Message: "Connection is configured"}
		if connection.Mode == model.ModeAgent {
			status = s.agents.Status(connection.ID)
		}
		out = append(out, model.ConnectionView{Connection: connection.Redacted(), Status: status})
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": out})
}
func (s *Server) handleConnectionGet(w http.ResponseWriter, r *http.Request) {
	connection, ok := s.state.GetConnection(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	status := model.ConnectionStatus{State: "configured"}
	if connection.Mode == model.ModeAgent {
		status = s.agents.Status(connection.ID)
	}
	writeJSON(w, http.StatusOK, model.ConnectionView{Connection: connection.Redacted(), Status: status})
}
func (s *Server) handleConnectionUpdate(w http.ResponseWriter, r *http.Request) {
	connection, ok := s.state.GetConnection(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	var request connectionUpdateRequest
	if !decodeJSON(w, r, 16<<10, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		writeError(w, http.StatusBadRequest, "connection name is required")
		return
	}
	connection.Name = request.Name
	if err := s.state.SaveConnection(connection); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.workloads.Delete(connection.ID)
	writeJSON(w, http.StatusOK, connection.Redacted())
}
func (s *Server) handleConnectionsCreate(w http.ResponseWriter, r *http.Request) {
	var request connectionRequest
	if !decodeJSON(w, r, 4<<20, &request) {
		return
	}
	connection, secretIDs, err := s.buildConnection(r.Context(), request)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cleanup := true
	defer func() {
		if cleanup {
			for _, id := range secretIDs {
				_ = s.secrets.Delete(id)
			}
		}
	}()
	if !request.SkipTest {
		p, err := s.factory.ProviderFor(connection)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		info, testErr := p.Test(ctx)
		cancel()
		if testErr != nil {
			writeError(w, http.StatusBadRequest, "connection test failed: "+testErr.Error())
			return
		}
		_ = info
	}
	if err := s.state.SaveConnection(connection); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	cleanup = false
	writeJSON(w, http.StatusCreated, connection.Redacted())
}
func (s *Server) handleConnectionTestDraft(w http.ResponseWriter, r *http.Request) {
	var request connectionRequest
	if !decodeJSON(w, r, 4<<20, &request) {
		return
	}
	connection, secrets, err := s.buildConnection(r.Context(), request)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer func() {
		for _, id := range secrets {
			_ = s.secrets.Delete(id)
		}
	}()
	p, err := s.factory.ProviderFor(connection)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	info, err := p.Test(ctx)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}
func (s *Server) handleConnectionTest(w http.ResponseWriter, r *http.Request) {
	connection, ok := s.state.GetConnection(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	p, err := s.factory.ProviderFor(connection)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	info, err := p.Test(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}
func (s *Server) handleConnectionDelete(w http.ResponseWriter, r *http.Request) {
	connection, ok := s.state.GetConnection(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	if connection.Mode == model.ModeAgent && connection.Deployment != nil {
		if err := s.removeAgentConnection(r.Context(), connection); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	for _, candidate := range s.state.ListConnections() {
		if candidate.Deployment != nil && candidate.Deployment.BootstrapConnectionID == connection.ID {
			writeError(w, http.StatusConflict, "remove the deployed agent connection first")
			return
		}
	}
	s.deleteConnectionSecrets(connection)
	if err := s.state.DeleteConnection(connection.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.workloads.Delete(connection.ID)
	s.metrics.InvalidateSnapshot(connection.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) buildConnection(ctx context.Context, request connectionRequest) (model.Connection, []string, error) {
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		return model.Connection{}, nil, errors.New("connection name is required")
	}
	resolvedSSH, err := s.resolveSSHBody(request.SSHProfileID, request.SSH)
	if err != nil {
		return model.Connection{}, nil, err
	}
	request.SSH = resolvedSSH
	connection := model.Connection{ID: store.NewID("connection"), Name: request.Name, Kind: request.Kind, Mode: model.ModeDirect}
	var secretIDs []string
	switch request.Kind {
	case model.ConnectionKubernetes:
		if request.Kubernetes == nil {
			return model.Connection{}, nil, errors.New("kubernetes configuration is required")
		}
		body := request.Kubernetes
		if request.SSH != nil && body.KubeconfigSource != "path" {
			return model.Connection{}, nil, errors.New("SSH Kubernetes connections require a kubeconfig path on the remote host")
		}
		if body.NamespaceMode == "" {
			body.NamespaceMode = "all"
		}
		environment, envErr := cleanEnvironment(body.Environment)
		if envErr != nil {
			return model.Connection{}, nil, envErr
		}
		namespaces := cleanList(body.Namespaces)
		if body.NamespaceMode != "all" && body.NamespaceMode != "selected" {
			return model.Connection{}, nil, errors.New("namespace mode must be all or selected")
		}
		if body.NamespaceMode == "selected" && len(namespaces) == 0 {
			return model.Connection{}, nil, errors.New("at least one namespace is required when namespace mode is selected")
		}
		cfg := &model.KubernetesConnection{Context: strings.TrimSpace(body.Context), KubectlPath: strings.TrimSpace(body.KubectlPath), NamespaceMode: body.NamespaceMode, Namespaces: namespaces, ExecPolicy: strings.TrimSpace(body.ExecPolicy), ExecAllowlist: cleanList(body.ExecAllowlist)}
		switch body.KubeconfigSource {
		case "path":
			if strings.TrimSpace(body.KubeconfigPath) == "" {
				return model.Connection{}, nil, errors.New("kubeconfig path is required")
			}
			cfg.KubeconfigSource = "path"
			if request.SSH != nil {
				cfg.KubeconfigPath = strings.TrimSpace(body.KubeconfigPath)
			} else {
				cfg.KubeconfigPath = expandUserPath(body.KubeconfigPath)
			}
		case "upload", "stored":
			if strings.TrimSpace(body.Kubeconfig) == "" {
				return model.Connection{}, nil, errors.New("kubeconfig content is required")
			}
			temp := model.Connection{Kind: model.ConnectionKubernetes, Mode: model.ModeDirect, Kubernetes: &model.KubernetesConnection{KubectlPath: body.KubectlPath}}
			flattener := kube.NewKubectlProvider(temp, s.secrets, s.state.Settings)
			policy := body.ExecPolicy
			if policy == "" {
				policy = s.state.Settings().ExecPluginPolicy
			}
			allow := body.ExecAllowlist
			if len(allow) == 0 {
				allow = s.state.Settings().ExecPluginAllowlist
			}
			flattened, err := flattener.FlattenKubeconfig(ctx, []byte(body.Kubeconfig), body.Context, policy, allow, environment)
			if err != nil {
				return model.Connection{}, nil, err
			}
			id, err := s.secrets.Put(flattened)
			if err != nil {
				return model.Connection{}, nil, err
			}
			secretIDs = append(secretIDs, id)
			cfg.KubeconfigSource = "stored"
			cfg.KubeconfigSecret = id
		default:
			return model.Connection{}, nil, errors.New("kubeconfig source must be path or upload")
		}
		if len(environment) > 0 {
			encoded, marshalErr := json.Marshal(environment)
			if marshalErr != nil {
				for _, id := range secretIDs {
					_ = s.secrets.Delete(id)
				}
				return model.Connection{}, nil, marshalErr
			}
			id, putErr := s.secrets.Put(encoded)
			if putErr != nil {
				for _, old := range secretIDs {
					_ = s.secrets.Delete(old)
				}
				return model.Connection{}, nil, putErr
			}
			secretIDs = append(secretIDs, id)
			cfg.EnvironmentSecret = id
		}
		connection.Kubernetes = cfg
	case model.ConnectionDocker:
		if request.Docker == nil {
			return model.Connection{}, nil, errors.New("docker configuration is required")
		}
		body := request.Docker
		if request.SSH != nil && (strings.TrimSpace(body.TLSCA) != "" || strings.TrimSpace(body.TLSCert) != "" || strings.TrimSpace(body.TLSKey) != "" || strings.TrimSpace(body.TLSServerName) != "") {
			return model.Connection{}, nil, errors.New("docker over SSH cannot be combined with TLS client settings")
		}
		endpoint := strings.TrimSpace(body.Endpoint)
		if endpoint == "" {
			endpoint = "unix:///var/run/docker.sock"
		}
		if request.SSH != nil && strings.HasPrefix(endpoint, "/") {
			endpoint = "unix://" + endpoint
		}
		if request.SSH != nil {
			parsedEndpoint, parseErr := url.Parse(endpoint)
			if parseErr != nil {
				return model.Connection{}, nil, errors.New("docker endpoint on the SSH host is invalid")
			}
			switch parsedEndpoint.Scheme {
			case "unix":
				if !strings.HasPrefix(parsedEndpoint.Path, "/") {
					return model.Connection{}, nil, errors.New("docker over SSH requires an absolute remote socket path")
				}
			case "tcp":
				if parsedEndpoint.Host == "" {
					return model.Connection{}, nil, errors.New("docker TCP endpoint on the SSH host requires a host and port")
				}
			default:
				return model.Connection{}, nil, errors.New("docker over SSH endpoint must be an absolute socket path or tcp:// Engine API")
			}
		}
		if request.HTTPProxy != nil && request.SSH == nil && (strings.HasPrefix(endpoint, "unix://") || strings.HasPrefix(endpoint, "npipe://")) {
			return model.Connection{}, nil, errors.New("an HTTP proxy can be used with a remote Docker API or an SSH route, not a local socket")
		}
		cfg := &model.DockerConnection{Endpoint: endpoint, TLSServerName: body.TLSServerName}
		for value, dest := range map[string]*string{body.TLSCA: &cfg.TLSCASecret, body.TLSCert: &cfg.TLSCertSecret, body.TLSKey: &cfg.TLSKeySecret} {
			if strings.TrimSpace(value) == "" {
				continue
			}
			id, err := s.secrets.Put([]byte(value))
			if err != nil {
				for _, old := range secretIDs {
					_ = s.secrets.Delete(old)
				}
				return model.Connection{}, nil, err
			}
			secretIDs = append(secretIDs, id)
			*dest = id
		}
		connection.Docker = cfg
	default:
		return model.Connection{}, nil, errors.New("connection kind must be kubernetes or docker")
	}
	if request.SSH != nil {
		sshConnection, sshSecret, err := s.storeSSHConnection(request.SSH)
		if err != nil {
			for _, id := range secretIDs {
				_ = s.secrets.Delete(id)
			}
			return model.Connection{}, nil, err
		}
		connection.SSH = sshConnection
		if sshSecret != "" {
			secretIDs = append(secretIDs, sshSecret)
		}
	}
	if request.HTTPProxy != nil {
		proxyConnection, proxySecret, err := s.storeHTTPProxy(request.HTTPProxy)
		if err != nil {
			for _, id := range secretIDs {
				_ = s.secrets.Delete(id)
			}
			return model.Connection{}, nil, err
		}
		connection.HTTPProxy = proxyConnection
		secretIDs = append(secretIDs, proxySecret)
	}
	return connection, secretIDs, nil
}

func (s *Server) storeSSHConnection(body *sshConnectionBody) (*model.SSHConnection, string, error) {
	config, err := sshConfigFromBody(body)
	if err != nil {
		return nil, "", err
	}
	value := &model.SSHConnection{
		Host:           config.Host,
		Port:           config.Port,
		User:           config.User,
		KnownHostsPath: config.KnownHostsPath,
		HostKeyPolicy:  config.HostKeyPolicy,
		ProxyJump:      config.ProxyJump,
	}
	if len(config.PrivateKey) == 0 {
		return value, "", nil
	}
	id, err := s.secrets.Put(config.PrivateKey)
	if err != nil {
		return nil, "", err
	}
	value.PrivateKeySecret = id
	return value, id, nil
}

func sshConfigFromBody(body *sshConnectionBody) (sshx.Config, error) {
	if body == nil {
		return sshx.Config{}, errors.New("SSH configuration is required")
	}
	host := strings.TrimSpace(body.Host)
	user := strings.TrimSpace(body.User)
	if user == "" && strings.Count(host, "@") == 1 {
		user, host, _ = strings.Cut(host, "@")
	}
	policy := strings.TrimSpace(body.HostKeyPolicy)
	if policy == "" {
		policy = "accept-new"
	}
	config := sshx.Config{
		Host:           host,
		Port:           body.Port,
		User:           user,
		PrivateKey:     []byte(strings.TrimSpace(body.PrivateKey)),
		KnownHostsPath: strings.TrimSpace(body.KnownHostsPath),
		HostKeyPolicy:  policy,
		ProxyJump:      strings.TrimSpace(body.ProxyJump),
	}
	return config, config.Validate()
}

func (s *Server) storeHTTPProxy(body *httpProxyBody) (*model.HTTPProxyConnection, string, error) {
	if body == nil {
		return nil, "", errors.New("HTTP proxy configuration is required")
	}
	config, err := proxyx.Parse(body.URL, body.NoProxy)
	if err != nil {
		return nil, "", err
	}
	id, err := s.secrets.Put([]byte(config.URL))
	if err != nil {
		return nil, "", err
	}
	return &model.HTTPProxyConnection{
		DisplayURL: config.DisplayURL(),
		URLSecret:  id,
		NoProxy:    append([]string(nil), config.NoProxy...),
	}, id, nil
}

func (s *Server) deleteConnectionSecrets(connection model.Connection) {
	if connection.Kubernetes != nil {
		_ = s.secrets.Delete(connection.Kubernetes.KubeconfigSecret)
		_ = s.secrets.Delete(connection.Kubernetes.EnvironmentSecret)
	}
	if connection.Docker != nil {
		_ = s.secrets.Delete(connection.Docker.TLSCASecret)
		_ = s.secrets.Delete(connection.Docker.TLSCertSecret)
		_ = s.secrets.Delete(connection.Docker.TLSKeySecret)
	}
	if connection.SSH != nil {
		_ = s.secrets.Delete(connection.SSH.PrivateKeySecret)
	}
	if connection.HTTPProxy != nil {
		_ = s.secrets.Delete(connection.HTTPProxy.URLSecret)
	}
	if connection.Deployment != nil {
		_ = s.secrets.Delete(connection.Deployment.ManifestSecret)
	}
}
func expandUserPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "~" || strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
		home, err := os.UserHomeDir()
		if err == nil {
			if value == "~" {
				return home
			}
			return filepath.Join(home, value[2:])
		}
	}
	return value
}

var environmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func cleanEnvironment(values map[string]string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > 128 {
		return nil, errors.New("kubernetes environment cannot contain more than 128 variables")
	}
	out := make(map[string]string, len(values))
	total := 0
	for rawKey, value := range values {
		key := strings.TrimSpace(rawKey)
		if !environmentNamePattern.MatchString(key) {
			return nil, fmt.Errorf("invalid environment variable name %q", rawKey)
		}
		if strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("environment variable %q contains a NUL byte", key)
		}
		total += len(key) + len(value)
		if total > 256*1024 {
			return nil, errors.New("kubernetes environment is larger than 256 KiB")
		}
		out[key] = value
	}
	return out, nil
}

func cleanList(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

func (s *Server) handleWorkloads(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	filters := connectionFilterSet(r)
	connections := s.availableConnections()
	type result struct {
		items []model.Workload
		id    string
		err   error
	}
	results := make(chan result, len(connections))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for _, connection := range connections {
		if len(filters) > 0 && !filters[connection.ID] {
			continue
		}

		wg.Add(1)
		go func(ctx context.Context, connection model.Connection) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			p, err := s.factory.ProviderFor(connection)
			if err != nil {
				results <- result{id: connection.ID, err: err}
				return
			}
			items, err := p.ListWorkloads(ctx)
			results <- result{id: connection.ID, items: items, err: err}
		}(ctx, connection)
	}
	wg.Wait()
	close(results)
	items := []model.Workload{}
	failures := map[string]string{}
	for value := range results {
		if value.err != nil {
			failures[value.id] = value.err.Error()
		} else {
			items = append(items, value.items...)
			s.workloads.Put(value.id, value.items, time.Now())
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Connection == items[j].Connection {
			if items[i].Namespace == items[j].Namespace {
				return items[i].Name < items[j].Name
			}
			return items[i].Namespace < items[j].Namespace
		}
		return items[i].Connection < items[j].Connection
	})
	writeJSON(w, http.StatusOK, map[string]any{"workloads": items, "errors": failures})
}

func (s *Server) handleWorkloadCache(w http.ResponseWriter, r *http.Request) {
	filters := connectionFilterSet(r)
	connections := s.availableConnections()
	items := []model.Workload{}
	observed := make(map[string]time.Time)
	for _, connection := range connections {
		if len(filters) > 0 && !filters[connection.ID] {
			continue
		}
		snapshot, ok := s.workloads.Get(connection.ID)
		if !ok {
			continue
		}
		items = append(items, snapshot.Workloads...)
		observed[connection.ID] = snapshot.ObservedAt
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Connection == items[j].Connection {
			if items[i].Namespace == items[j].Namespace {
				return items[i].Name < items[j].Name
			}
			return items[i].Namespace < items[j].Namespace
		}
		return items[i].Connection < items[j].Connection
	})
	writeJSON(w, http.StatusOK, map[string]any{"workloads": items, "observed_at": observed})
}

func (s *Server) handleWorkloadsStream(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}

	filters := connectionFilterSet(r)
	connections := s.availableConnections()
	selected := make([]model.Connection, 0, len(connections))
	for _, connection := range connections {
		if len(filters) == 0 || filters[connection.ID] {
			selected = append(selected, connection)
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	writeWorkloadSSE(w, "start", map[string]int{"connections": len(selected)})
	flusher.Flush()

	type result struct {
		id    string
		items []model.Workload
		err   error
	}
	items := make(chan model.Workload, 64)
	results := make(chan result, len(selected))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for _, connection := range selected {
		wg.Add(1)
		go func(ctx context.Context, connection model.Connection) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			p, err := s.factory.ProviderFor(connection)
			collected := []model.Workload{}
			if err == nil {
				if streamer, streamOK := p.(provider.WorkloadStreamer); streamOK {
					streamItems := make(chan model.Workload, 64)
					streamErrors := make(chan error, 1)
					go func(ctx context.Context, streamer provider.WorkloadStreamer) {
						streamErrors <- streamer.StreamWorkloads(ctx, streamItems)
						close(streamItems)
					}(ctx, streamer)
					for item := range streamItems {
						collected = append(collected, item)
						select {
						case items <- item:
						case <-ctx.Done():
							return
						}
					}
					err = <-streamErrors
				} else {
					var snapshot []model.Workload
					snapshot, err = p.ListWorkloads(ctx)
					if err == nil {
						collected = append(collected, snapshot...)
						for _, item := range snapshot {
							select {
							case items <- item:
							case <-ctx.Done():
								return
							}
						}
					}
				}
			}
			select {
			case results <- result{id: connection.ID, items: collected, err: err}:
			case <-ctx.Done():
			}
		}(ctx, connection)
	}
	go func() {
		wg.Wait()
		close(items)
		close(results)
	}()

	failures := map[string]string{}
	count := 0
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for items != nil || results != nil {
		select {
		case <-ctx.Done():
			return
		case item, open := <-items:
			if !open {
				items = nil
				continue
			}
			writeWorkloadSSE(w, "workload", item)
			count++
			flusher.Flush()
		case value, open := <-results:
			if !open {
				results = nil
				continue
			}
			event := map[string]string{"connection_id": value.id}
			if value.err != nil {
				event["error"] = value.err.Error()
				failures[value.id] = value.err.Error()
			} else {
				s.workloads.Put(value.id, value.items, time.Now())
			}
			writeWorkloadSSE(w, "connection-complete", event)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
	writeWorkloadSSE(w, "complete", map[string]any{"count": count, "errors": failures})
	flusher.Flush()
}

func connectionFilterSet(r *http.Request) map[string]bool {
	values := cleanList(r.URL.Query()["connection_id"])
	filters := make(map[string]bool, len(values))
	for _, value := range values {
		filters[value] = true
	}
	return filters
}

func writeWorkloadSSE(w http.ResponseWriter, event string, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
}

func (s *Server) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("connection_id")
	connection, ok := s.state.GetConnection(id)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	p, err := s.factory.ProviderFor(connection)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	values, err := p.Namespaces(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"namespaces": values})
}

func (s *Server) handleSettingsGet(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.state.Settings())
}
func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request) {
	settings := s.state.Settings()
	if !decodeJSON(w, r, 256<<10, &settings) {
		return
	}
	if settings.DefaultTailLines < 0 || settings.DefaultTailLines > 100000 {
		writeError(w, http.StatusBadRequest, "default tail lines must be between 0 and 100000")
		return
	}
	if settings.OverviewMetricsIntervalSeconds < 10 || settings.OverviewMetricsIntervalSeconds > 3600 {
		writeError(w, http.StatusBadRequest, "overview metrics interval must be between 10 and 3600 seconds")
		return
	}
	if settings.SelectedMetricsIntervalSeconds < 1 || settings.SelectedMetricsIntervalSeconds > 300 {
		writeError(w, http.StatusBadRequest, "selected metrics interval must be between 1 and 300 seconds")
		return
	}
	switch settings.ExecPluginPolicy {
	case "deny", "allowlist", "allow":
	default:
		writeError(w, http.StatusBadRequest, "exec plugin policy must be deny, allowlist, or allow")
		return
	}
	settings.ExecPluginAllowlist = cleanList(settings.ExecPluginAllowlist)
	if err := s.state.SaveSettings(settings); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, settings)
}
