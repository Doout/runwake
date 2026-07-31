package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/Doout/runwake/internal/activity"
	"github.com/Doout/runwake/internal/agent"
	"github.com/Doout/runwake/internal/metrics"
	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
	"github.com/Doout/runwake/internal/store"
	"github.com/Doout/runwake/internal/workloadcache"
)

type fakeProvider struct {
	info         model.ProviderInfo
	workloads    []model.Workload
	namespaces   []string
	records      []model.ActivityRecord
	metrics      []model.WorkloadMetric
	workloadGate <-chan struct{}
	mu           sync.Mutex
	applied      []string
	deleted      []string
	streams      []model.StreamRequest
	restarted    []string
	removed      []string
	projects     []string
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func (p *fakeProvider) Test(context.Context) (model.ProviderInfo, error) { return p.info, nil }
func (p *fakeProvider) Namespaces(context.Context) ([]string, error) {
	return append([]string(nil), p.namespaces...), nil
}
func (p *fakeProvider) ListWorkloads(context.Context) ([]model.Workload, error) {
	return append([]model.Workload(nil), p.workloads...), nil
}
func (p *fakeProvider) StreamWorkloads(ctx context.Context, out chan<- model.Workload) error {
	for index, workload := range p.workloads {
		if index > 0 && p.workloadGate != nil {
			select {
			case <-p.workloadGate:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		select {
		case out <- workload:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
func (p *fakeProvider) ListMetrics(context.Context) ([]model.WorkloadMetric, error) {
	return append([]model.WorkloadMetric(nil), p.metrics...), nil
}
func (p *fakeProvider) Stream(ctx context.Context, request model.StreamRequest, out chan<- model.ActivityRecord) error {
	p.mu.Lock()
	p.streams = append(p.streams, request)
	p.mu.Unlock()
	for _, record := range p.records {
		select {
		case out <- record:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	<-ctx.Done()
	return ctx.Err()
}
func (p *fakeProvider) StreamMetrics(ctx context.Context, _ model.MetricRequest, out chan<- model.WorkloadMetric) error {
	for _, metric := range p.metrics {
		select {
		case out <- metric:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	<-ctx.Done()
	return ctx.Err()
}
func (p *fakeProvider) ApplyManifest(_ context.Context, manifest string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.applied = append(p.applied, manifest)
	return nil
}
func (p *fakeProvider) DeleteManifest(_ context.Context, manifest string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.deleted = append(p.deleted, manifest)
	return nil
}
func (p *fakeProvider) RestartContainer(_ context.Context, containerID string, _ int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.restarted = append(p.restarted, containerID)
	return nil
}
func (p *fakeProvider) DeleteContainer(_ context.Context, containerID string, force bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.removed = append(p.removed, containerID+":"+strconv.FormatBool(force))
	return nil
}
func (p *fakeProvider) RestartComposeProject(_ context.Context, project string, _ int) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.projects = append(p.projects, project)
	return 3, nil
}

type fakeFactory struct{ provider *fakeProvider }

func (f fakeFactory) ProviderFor(model.Connection) (provider.Provider, error) { return f.provider, nil }

type finiteActivityProvider struct{ *fakeProvider }

func (p finiteActivityProvider) Stream(ctx context.Context, request model.StreamRequest, out chan<- model.ActivityRecord) error {
	p.mu.Lock()
	p.streams = append(p.streams, request)
	p.mu.Unlock()
	for _, record := range p.records {
		select {
		case out <- record:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

type finiteActivityFactory struct{ provider finiteActivityProvider }

func (f finiteActivityFactory) ProviderFor(model.Connection) (provider.Provider, error) {
	return f.provider, nil
}

func newTestServer(t *testing.T, authToken string) (*Server, *store.Store, *store.SecretStore, *fakeProvider) {
	t.Helper()
	state, err := store.Open(t.TempDir(), model.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	secrets, err := store.OpenSecretStore(state.Dir(), "")
	if err != nil {
		t.Fatal(err)
	}
	p := &fakeProvider{
		info:       model.ProviderInfo{State: "connected", Details: map[string]string{"server": "v1.35.0"}},
		namespaces: []string{"payments"},
		workloads:  []model.Workload{{ConnectionID: "connection_test", Connection: "test", Platform: "kubernetes", Kind: "Deployment", Namespace: "payments", Name: "checkout-api", State: "Available", Severity: "normal", Ready: 2, Desired: 2}},
		records:    []model.ActivityRecord{{Timestamp: time.Unix(10, 0).UTC(), Type: "log", Level: "stdout", Message: "ready", Pod: "checkout-api-abc", Container: "app"}},
		metrics:    []model.WorkloadMetric{{Timestamp: time.Unix(11, 0).UTC(), ConnectionID: "connection_test", Connection: "test", Platform: "kubernetes", Kind: "Deployment", Namespace: "payments", Name: "checkout-api", Source: "test", CPUCores: 0.05, MemoryBytes: 64 << 20}},
	}
	factory := fakeFactory{provider: p}
	hub := agent.NewHub(state)
	activities := activity.NewManager(factory)
	metricStreams := metrics.NewManager(factory)
	workloads := workloadcache.NewMemory()
	assets := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>Runwake</title>"), Mode: fs.FileMode(0o644)}}
	s, err := New(Config{State: state, Secrets: secrets, Factory: factory, Activities: activities, Metrics: metricStreams, Workloads: workloads, Agents: hub, Assets: assets, AuthToken: authToken, Version: "test", RemoteAgentsEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	return s, state, secrets, p
}

func TestUpdateCheckUsesLatestGitHubRelease(t *testing.T) {
	s, _, _, _ := newTestServer(t, "")
	s.version = "0.1.0"
	s.httpClient = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "https://api.github.com/repos/Doout/runwake/releases/latest" {
			t.Fatalf("unexpected update URL: %s", request.URL)
		}
		if request.Header.Get("User-Agent") != "Runwake/0.1.0" {
			t.Fatalf("unexpected user agent: %s", request.Header.Get("User-Agent"))
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"tag_name":"v0.2.0","html_url":"https://github.com/Doout/runwake/releases/tag/v0.2.0"}`)), Header: make(http.Header)}, nil
	})}

	recorder := httptest.NewRecorder()
	s.handleUpdate(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/update", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d: %s", recorder.Code, recorder.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["current"] != "0.1.0" || result["latest"] != "0.2.0" || result["url"] != "https://github.com/Doout/runwake/releases/tag/v0.2.0" {
		t.Fatalf("unexpected update response: %#v", result)
	}
}

func TestActivityStreamStaysOpenWhenUpstreamEnds(t *testing.T) {
	s, state, _, fake := newTestServer(t, "")
	connection := model.Connection{ID: "connection_test", Name: "test", Kind: model.ConnectionKubernetes, Mode: model.ModeDirect, Kubernetes: &model.KubernetesConnection{KubeconfigSource: "path", KubeconfigPath: "/tmp/test"}}
	if err := state.SaveConnection(connection); err != nil {
		t.Fatal(err)
	}
	s.activities = activity.NewManager(finiteActivityFactory{provider: finiteActivityProvider{fakeProvider: fake}})
	server := httptest.NewServer(s.Handler())
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/v1/activity/stream?connection_id=connection_test&kind=Deployment&namespace=payments&name=checkout-api", nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()

	scanner := bufio.NewScanner(response.Body)
	foundEnd := false
	for scanner.Scan() {
		if scanner.Text() == "event: activity-end" {
			foundEnd = true
			break
		}
	}
	if !foundEnd {
		t.Fatalf("activity-end was not streamed: %v", scanner.Err())
	}
	for scanner.Scan() {
		if scanner.Text() == "" {
			break
		}
	}

	scanResult := make(chan bool, 1)
	go func() { scanResult <- scanner.Scan() }()
	select {
	case <-scanResult:
		t.Fatal("SSE response closed after the finite upstream stream ended")
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
}

func TestRemoteAgentRoutesAreDisabled(t *testing.T) {
	s, state, _, _ := newTestServer(t, "")
	s.remoteAgentsEnabled = false
	handler := s.Handler()

	for _, test := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/agent/commands"},
		{method: http.MethodPost, path: "/api/v1/agent/events"},
		{method: http.MethodPost, path: "/api/v1/agents/enroll"},
		{method: http.MethodPost, path: "/api/v1/connections/connection_test/agent"},
		{method: http.MethodPost, path: "/api/v1/connections/connection_test/rotate-token"},
		{method: http.MethodDelete, path: "/api/v1/connections/connection_test/agent"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != http.StatusNotFound {
			t.Errorf("%s %s: got status %d, want %d", test.method, test.path, response.Code, http.StatusNotFound)
		}
	}

	agentConnection := model.Connection{
		ID:   "connection_agent_disabled",
		Name: "remote",
		Kind: model.ConnectionKubernetes,
		Mode: model.ModeAgent,
		Agent: &model.AgentConnection{
			TokenHash: agent.HashToken("disabled"),
			RunMode:   "persistent",
		},
	}
	if err := state.SaveConnection(agentConnection); err != nil {
		t.Fatal(err)
	}

	connections := httptest.NewRecorder()
	handler.ServeHTTP(connections, httptest.NewRequest(http.MethodGet, "/api/v1/connections", nil))
	if connections.Code != http.StatusOK {
		t.Fatalf("connections status = %d body=%s", connections.Code, connections.Body.String())
	}
	if strings.Contains(connections.Body.String(), agentConnection.ID) {
		t.Fatalf("disabled agent connection was exposed: %s", connections.Body.String())
	}

	workloads := httptest.NewRecorder()
	handler.ServeHTTP(workloads, httptest.NewRequest(http.MethodGet, "/api/v1/workloads", nil))
	if workloads.Code != http.StatusOK {
		t.Fatalf("workloads status = %d body=%s", workloads.Code, workloads.Body.String())
	}
	if strings.Contains(workloads.Body.String(), agentConnection.ID) {
		t.Fatalf("disabled agent connection was queried: %s", workloads.Body.String())
	}
}

func TestHealthAndAuthentication(t *testing.T) {
	s, _, _, _ := newTestServer(t, "secret-token")
	h := s.Handler()

	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d", health.Code)
	}

	protected := httptest.NewRecorder()
	h.ServeHTTP(protected, httptest.NewRequest(http.MethodGet, "/api/v1/connections", nil))
	if protected.Code != http.StatusUnauthorized {
		t.Fatalf("protected status = %d", protected.Code)
	}

	login := httptest.NewRecorder()
	h.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"token":"secret-token"}`)))
	if login.Code != http.StatusNoContent || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login failed: status=%d cookies=%d", login.Code, len(login.Result().Cookies()))
	}
}

func TestCreateAndListDockerConnection(t *testing.T) {
	s, _, _, _ := newTestServer(t, "")
	h := s.Handler()
	body := `{"name":"local","kind":"docker","skip_test":true,"docker":{"endpoint":"unix:///var/run/docker.sock"}}`
	create := httptest.NewRecorder()
	h.ServeHTTP(create, httptest.NewRequest(http.MethodPost, "/api/v1/connections", strings.NewReader(body)))
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var created model.Connection
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Docker == nil || created.Docker.Endpoint != "unix:///var/run/docker.sock" {
		t.Fatalf("unexpected connection: %#v", created)
	}
	if created.AccessMode != model.AccessReadOnly {
		t.Fatalf("default access mode = %q, want %q", created.AccessMode, model.AccessReadOnly)
	}
	list := httptest.NewRecorder()
	h.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/v1/connections", nil))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"name":"local"`) {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
}

func TestDockerRuntimeActionsRequireManagedAccess(t *testing.T) {
	s, state, _, fake := newTestServer(t, "")
	h := s.Handler()
	const containerID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	readOnly := model.Connection{
		ID: "connection_read_only", Name: "read only", Kind: model.ConnectionDocker, Mode: model.ModeDirect,
		AccessMode: model.AccessReadOnly, Docker: &model.DockerConnection{Endpoint: "unix:///read-only.sock"},
	}
	managed := model.Connection{
		ID: "connection_managed", Name: "managed", Kind: model.ConnectionDocker, Mode: model.ModeDirect,
		AccessMode: model.AccessManage, Docker: &model.DockerConnection{Endpoint: "unix:///managed.sock"},
	}
	if err := state.SaveConnection(readOnly); err != nil {
		t.Fatal(err)
	}
	if err := state.SaveConnection(managed); err != nil {
		t.Fatal(err)
	}

	denied := httptest.NewRecorder()
	h.ServeHTTP(denied, httptest.NewRequest(http.MethodPost, "/api/v1/connections/"+readOnly.ID+"/docker/containers/"+containerID+"/restart", nil))
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "read-only") {
		t.Fatalf("read-only restart status=%d body=%s", denied.Code, denied.Body.String())
	}

	restart := httptest.NewRecorder()
	h.ServeHTTP(restart, httptest.NewRequest(http.MethodPost, "/api/v1/connections/"+managed.ID+"/docker/containers/"+containerID+"/restart", nil))
	if restart.Code != http.StatusOK {
		t.Fatalf("restart status=%d body=%s", restart.Code, restart.Body.String())
	}

	remove := httptest.NewRecorder()
	h.ServeHTTP(remove, httptest.NewRequest(http.MethodDelete, "/api/v1/connections/"+managed.ID+"/docker/containers/"+containerID+"?force=true", nil))
	if remove.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", remove.Code, remove.Body.String())
	}

	compose := httptest.NewRecorder()
	h.ServeHTTP(compose, httptest.NewRequest(http.MethodPost, "/api/v1/connections/"+managed.ID+"/docker/compose/restart", strings.NewReader(`{"project":"payments"}`)))
	if compose.Code != http.StatusOK || !strings.Contains(compose.Body.String(), `"containers":3`) {
		t.Fatalf("compose restart status=%d body=%s", compose.Code, compose.Body.String())
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !reflect.DeepEqual(fake.restarted, []string{containerID}) {
		t.Fatalf("restart calls = %#v", fake.restarted)
	}
	if !reflect.DeepEqual(fake.removed, []string{containerID + ":true"}) {
		t.Fatalf("delete calls = %#v", fake.removed)
	}
	if !reflect.DeepEqual(fake.projects, []string{"payments"}) {
		t.Fatalf("compose calls = %#v", fake.projects)
	}
}

func TestDockerConnectionRejectsUnknownAccessMode(t *testing.T) {
	s, _, _, _ := newTestServer(t, "")
	response := httptest.NewRecorder()
	body := `{"name":"local","kind":"docker","access_mode":"admin","skip_test":true,"docker":{"endpoint":"unix:///var/run/docker.sock"}}`
	s.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/connections", strings.NewReader(body)))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "read_only or manage") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRenameConnectionPreservesConfiguration(t *testing.T) {
	s, state, _, _ := newTestServer(t, "")
	h := s.Handler()
	body := `{"name":"local","kind":"docker","skip_test":true,"docker":{"endpoint":"unix:///var/run/docker.sock"}}`
	create := httptest.NewRecorder()
	h.ServeHTTP(create, httptest.NewRequest(http.MethodPost, "/api/v1/connections", strings.NewReader(body)))
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var created model.Connection
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	before, ok := state.GetConnection(created.ID)
	if !ok {
		t.Fatal("created connection was not stored")
	}

	update := httptest.NewRecorder()
	h.ServeHTTP(update, httptest.NewRequest(http.MethodPatch, "/api/v1/connections/"+created.ID, strings.NewReader(`{"name":"Developer Docker","access_mode":"manage"}`)))
	if update.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", update.Code, update.Body.String())
	}
	stored, ok := state.GetConnection(created.ID)
	if !ok {
		t.Fatal("updated connection was not stored")
	}
	if stored.Name != "Developer Docker" {
		t.Fatalf("updated name = %q", stored.Name)
	}
	if stored.AccessMode != model.AccessManage {
		t.Fatalf("updated access mode = %q", stored.AccessMode)
	}
	if stored.Docker == nil || stored.Docker.Endpoint != "unix:///var/run/docker.sock" {
		t.Fatalf("connection configuration changed: %#v", stored)
	}
	if stored.ID != before.ID || !stored.CreatedAt.Equal(before.CreatedAt) {
		t.Fatalf("connection identity changed: before=%#v after=%#v", before, stored)
	}
}

func TestSSHProfileCanCreateIndependentConnection(t *testing.T) {
	s, state, secrets, _ := newTestServer(t, "")
	h := s.Handler()
	createProfile := httptest.NewRecorder()
	h.ServeHTTP(createProfile, httptest.NewRequest(http.MethodPost, "/api/v1/ssh-profiles", strings.NewReader(`{
		"name":"Production bastion",
		"host":"bastion.example.com",
		"user":"ubuntu",
		"private_key":"private key",
		"host_key_policy":"accept-new"
	}`)))
	if createProfile.Code != http.StatusCreated {
		t.Fatalf("profile create status=%d body=%s", createProfile.Code, createProfile.Body.String())
	}
	if strings.Contains(createProfile.Body.String(), "private key") || strings.Contains(createProfile.Body.String(), "private_key_secret") {
		t.Fatalf("profile secret leaked in response: %s", createProfile.Body.String())
	}
	var profile model.SSHProfile
	if err := json.Unmarshal(createProfile.Body.Bytes(), &profile); err != nil {
		t.Fatal(err)
	}
	if !profile.HasPrivateKey {
		t.Fatalf("stored-key state missing from response: %#v", profile)
	}
	storedProfile, ok := state.GetSSHProfile(profile.ID)
	if !ok || storedProfile.PrivateKeySecret == "" {
		t.Fatalf("profile secret was not persisted: %#v", storedProfile)
	}

	createConnection := httptest.NewRecorder()
	body := `{"name":"Remote Docker","kind":"docker","skip_test":true,"ssh_profile_id":"` + profile.ID + `","docker":{"endpoint":"/var/run/docker.sock"}}`
	h.ServeHTTP(createConnection, httptest.NewRequest(http.MethodPost, "/api/v1/connections", strings.NewReader(body)))
	if createConnection.Code != http.StatusCreated {
		t.Fatalf("connection create status=%d body=%s", createConnection.Code, createConnection.Body.String())
	}
	var connection model.Connection
	if err := json.Unmarshal(createConnection.Body.Bytes(), &connection); err != nil {
		t.Fatal(err)
	}
	storedConnection, ok := state.GetConnection(connection.ID)
	if !ok || storedConnection.SSH == nil || storedConnection.SSH.PrivateKeySecret == "" {
		t.Fatalf("connection SSH secret was not persisted: %#v", storedConnection)
	}
	if storedConnection.SSH.PrivateKeySecret == storedProfile.PrivateKeySecret {
		t.Fatal("connection and reusable profile unexpectedly share a secret lifecycle")
	}

	removeProfile := httptest.NewRecorder()
	h.ServeHTTP(removeProfile, httptest.NewRequest(http.MethodDelete, "/api/v1/ssh-profiles/"+profile.ID, nil))
	if removeProfile.Code != http.StatusNoContent {
		t.Fatalf("profile delete status=%d body=%s", removeProfile.Code, removeProfile.Body.String())
	}
	if _, err := secrets.Get(storedProfile.PrivateKeySecret); err == nil {
		t.Fatal("profile secret was not deleted")
	}
	key, err := secrets.Get(storedConnection.SSH.PrivateKeySecret)
	if err != nil || string(key) != "private key" {
		t.Fatalf("connection secret did not remain independent: %q, %v", key, err)
	}
}

func TestHTTPProxyIsEncryptedRedactedAndDeleted(t *testing.T) {
	s, state, secrets, _ := newTestServer(t, "")
	h := s.Handler()
	body := `{
		"name":"proxied cluster",
		"kind":"kubernetes",
		"skip_test":true,
		"kubernetes":{"kubeconfig_source":"path","kubeconfig_path":"/tmp/config","namespace_mode":"all"},
		"http_proxy":{"url":"http://operator:secret@proxy.example.com:8080","no_proxy":["localhost",".svc"]}
	}`
	create := httptest.NewRecorder()
	h.ServeHTTP(create, httptest.NewRequest(http.MethodPost, "/api/v1/connections", strings.NewReader(body)))
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	if strings.Contains(create.Body.String(), "operator") || strings.Contains(create.Body.String(), "secret") || strings.Contains(create.Body.String(), "url_secret") {
		t.Fatalf("proxy credentials leaked in response: %s", create.Body.String())
	}
	var created model.Connection
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.HTTPProxy == nil || created.HTTPProxy.DisplayURL != "http://proxy.example.com:8080" {
		t.Fatalf("unexpected redacted proxy: %#v", created.HTTPProxy)
	}
	stored, ok := state.GetConnection(created.ID)
	if !ok || stored.HTTPProxy == nil || stored.HTTPProxy.URLSecret == "" {
		t.Fatalf("proxy secret was not stored: %#v", stored)
	}
	secretID := stored.HTTPProxy.URLSecret
	plain, err := secrets.Get(secretID)
	if err != nil || string(plain) != "http://operator:secret@proxy.example.com:8080" {
		t.Fatalf("stored proxy URL = %q, %v", plain, err)
	}
	remove := httptest.NewRecorder()
	h.ServeHTTP(remove, httptest.NewRequest(http.MethodDelete, "/api/v1/connections/"+created.ID, nil))
	if remove.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", remove.Code, remove.Body.String())
	}
	if _, err := secrets.Get(secretID); err == nil {
		t.Fatal("proxy secret was not deleted")
	}
}

func TestDockerLocalSocketRejectsHTTPProxy(t *testing.T) {
	s, _, _, _ := newTestServer(t, "")
	response := httptest.NewRecorder()
	body := `{"name":"local","kind":"docker","skip_test":true,"docker":{"endpoint":"unix:///var/run/docker.sock"},"http_proxy":{"url":"http://proxy.example.com:8080"}}`
	s.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/connections", strings.NewReader(body)))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "remote Docker API or an SSH route") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestConnectionFilterSetAcceptsMultipleValues(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/workloads?connection_id=first&connection_id=second&connection_id=first", nil)
	filters := connectionFilterSet(request)
	if len(filters) != 2 || !filters["first"] || !filters["second"] {
		t.Fatalf("unexpected connection filters: %#v", filters)
	}
}

func TestWorkloadCacheJoinsOnlySelectedConnections(t *testing.T) {
	s, state, _, _ := newTestServer(t, "")
	first := model.Connection{ID: "connection_first", Name: "first", Kind: model.ConnectionDocker, Mode: model.ModeDirect, Docker: &model.DockerConnection{Endpoint: "unix:///first.sock"}}
	second := model.Connection{ID: "connection_second", Name: "second", Kind: model.ConnectionDocker, Mode: model.ModeDirect, Docker: &model.DockerConnection{Endpoint: "unix:///second.sock"}}
	if err := state.SaveConnection(first); err != nil {
		t.Fatal(err)
	}
	if err := state.SaveConnection(second); err != nil {
		t.Fatal(err)
	}
	s.workloads.Put(first.ID, []model.Workload{{ConnectionID: first.ID, Connection: first.Name, Kind: "Container", Name: "first-api"}}, time.Now())
	s.workloads.Put(second.ID, []model.Workload{{ConnectionID: second.ID, Connection: second.Name, Kind: "Container", Name: "second-api"}}, time.Now())

	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/workloads/cache?connection_id="+first.ID, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("cache status = %d body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "first-api") || strings.Contains(response.Body.String(), "second-api") {
		t.Fatalf("filtered cache response = %s", response.Body.String())
	}
}

func TestWorkloadsAndActivityStream(t *testing.T) {
	s, state, _, fake := newTestServer(t, "")
	connection := model.Connection{ID: "connection_test", Name: "test", Kind: model.ConnectionKubernetes, Mode: model.ModeDirect, Kubernetes: &model.KubernetesConnection{KubeconfigSource: "path", KubeconfigPath: "/tmp/test"}}
	if err := state.SaveConnection(connection); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s.Handler())
	defer server.Close()

	response, err := http.Get(server.URL + "/api/v1/workloads")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.Contains(data, []byte("checkout-api")) {
		t.Fatalf("workloads status=%d body=%s", response.StatusCode, data)
	}

	gate := make(chan struct{})
	fake.workloads = append(fake.workloads, model.Workload{ConnectionID: "connection_test", Connection: "test", Platform: "kubernetes", Kind: "Pod", Namespace: "payments", Name: "maintenance-shell"})
	fake.workloadGate = gate
	streamRequest, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v1/workloads/stream", nil)
	workloadStream, err := http.DefaultClient.Do(streamRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workloadStream.Body.Close() }()
	if contentType := workloadStream.Header.Get("Content-Type"); contentType != "text/event-stream" {
		t.Fatalf("workload stream content type = %q", contentType)
	}
	workloadScanner := bufio.NewScanner(workloadStream.Body)
	firstFound := false
	for workloadScanner.Scan() {
		if strings.Contains(workloadScanner.Text(), `"name":"checkout-api"`) {
			firstFound = true
			break
		}
	}
	if !firstFound {
		t.Fatal("first workload was not streamed")
	}
	close(gate)
	secondFound := false
	completeFound := false
	for workloadScanner.Scan() {
		line := workloadScanner.Text()
		secondFound = secondFound || strings.Contains(line, `"name":"maintenance-shell"`)
		completeFound = completeFound || line == "event: complete"
		if secondFound && completeFound {
			break
		}
	}
	if !secondFound || !completeFound {
		t.Fatalf("stream did not finish incrementally: second=%v complete=%v", secondFound, completeFound)
	}

	cached, err := http.Get(server.URL + "/api/v1/workloads/cache?connection_id=connection_test")
	if err != nil {
		t.Fatal(err)
	}
	cachedData, _ := io.ReadAll(cached.Body)
	_ = cached.Body.Close()
	if cached.StatusCode != http.StatusOK ||
		!bytes.Contains(cachedData, []byte(`"connection_test"`)) ||
		!bytes.Contains(cachedData, []byte(`"maintenance-shell"`)) {
		t.Fatalf("cached workloads status=%d body=%s", cached.StatusCode, cachedData)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/v1/activity/stream?connection_id=connection_test&kind=Deployment&namespace=payments&name=checkout-api&pod=checkout-api-abc&container=app", nil)
	stream, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Body.Close() }()
	scanner := bufio.NewScanner(stream.Body)
	found := false
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), `"message":"ready"`) {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("activity record was not streamed")
	}
	fake.mu.Lock()
	lastStream := fake.streams[len(fake.streams)-1]
	fake.mu.Unlock()
	if lastStream.Pod != "checkout-api-abc" || lastStream.Container != "app" {
		t.Fatalf("activity scope was not forwarded: %#v", lastStream)
	}

	metricsResponse, err := http.Get(server.URL + "/api/v1/metrics")
	if err != nil {
		t.Fatal(err)
	}
	metricsData, _ := io.ReadAll(metricsResponse.Body)
	_ = metricsResponse.Body.Close()
	if metricsResponse.StatusCode != http.StatusOK || !bytes.Contains(metricsData, []byte(`"memory_bytes":67108864`)) {
		t.Fatalf("metrics status=%d body=%s", metricsResponse.StatusCode, metricsData)
	}

	metricCtx, metricCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer metricCancel()
	metricReq, _ := http.NewRequestWithContext(metricCtx, http.MethodGet, server.URL+"/api/v1/metrics/stream?connection_id=connection_test&kind=Deployment&namespace=payments&name=checkout-api", nil)
	metricStream, err := http.DefaultClient.Do(metricReq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = metricStream.Body.Close() }()
	metricScanner := bufio.NewScanner(metricStream.Body)
	metricFound := false
	for metricScanner.Scan() {
		if strings.Contains(metricScanner.Text(), `"source":"test"`) {
			metricFound = true
			break
		}
	}
	if !metricFound {
		t.Fatal("metric sample was not streamed")
	}
}

func TestAgentAutoDeployAndRemove(t *testing.T) {
	s, state, _, fake := newTestServer(t, "")
	bootstrap := model.Connection{ID: "connection_bootstrap", Name: "bootstrap", Kind: model.ConnectionKubernetes, Mode: model.ModeDirect, Kubernetes: &model.KubernetesConnection{KubeconfigSource: "path", KubeconfigPath: "/tmp/test"}}
	if err := state.SaveConnection(bootstrap); err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	body := `{"name":"cluster agent","mode":"temporary","server_url":"https://runwake.example","image":"registry.example/runwake-agent:test","namespace":"runwake-system","namespaces":["payments"],"ttl_seconds":600}`
	deploy := httptest.NewRecorder()
	h.ServeHTTP(deploy, httptest.NewRequest(http.MethodPost, "/api/v1/connections/connection_bootstrap/agent", strings.NewReader(body)))
	if deploy.Code != http.StatusCreated {
		t.Fatalf("deploy status=%d body=%s", deploy.Code, deploy.Body.String())
	}
	var response struct {
		Connection model.Connection `json:"connection"`
		Applied    bool             `json:"applied"`
	}
	if err := json.Unmarshal(deploy.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.Applied || response.Connection.Mode != model.ModeAgent || response.Connection.Deployment == nil {
		t.Fatalf("unexpected response: %#v", response)
	}
	fake.mu.Lock()
	if len(fake.applied) != 1 || strings.Contains(fake.applied[0], `resources: ["secrets"]`) {
		fake.mu.Unlock()
		t.Fatal("agent manifest was not applied with read-only scope")
	}
	fake.mu.Unlock()

	remove := httptest.NewRecorder()
	h.ServeHTTP(remove, httptest.NewRequest(http.MethodDelete, "/api/v1/connections/"+response.Connection.ID+"/agent", nil))
	if remove.Code != http.StatusNoContent {
		t.Fatalf("remove status=%d body=%s", remove.Code, remove.Body.String())
	}
	fake.mu.Lock()
	deletes := len(fake.deleted)
	fake.mu.Unlock()
	if deletes != 1 {
		t.Fatalf("delete manifest calls=%d", deletes)
	}
	removeAgain := httptest.NewRecorder()
	h.ServeHTTP(removeAgain, httptest.NewRequest(http.MethodDelete, "/api/v1/connections/"+response.Connection.ID+"/agent", nil))
	if removeAgain.Code != http.StatusNoContent {
		t.Fatalf("second remove status=%d body=%s", removeAgain.Code, removeAgain.Body.String())
	}
	fake.mu.Lock()
	deletes = len(fake.deleted)
	fake.mu.Unlock()
	if deletes != 1 {
		t.Fatalf("idempotent remove repeated manifest deletion: calls=%d", deletes)
	}
}

func TestManualTemporaryAgentEnrollment(t *testing.T) {
	s, state, _, _ := newTestServer(t, "")
	h := s.Handler()
	body := `{"name":"temporary docker","kind":"docker","mode":"temporary","server_url":"https://runwake.example","image":"registry.example/runwake-agent:test","ttl_seconds":120}`
	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents/enroll", strings.NewReader(body)))
	if response.Code != http.StatusCreated {
		t.Fatalf("enroll status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Connection  model.Connection  `json:"connection"`
		Environment map[string]string `json:"environment"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Connection.Agent == nil || payload.Connection.Agent.RunMode != "temporary" || payload.Connection.Agent.ExpiresAt.IsZero() {
		t.Fatalf("temporary agent metadata missing: %#v", payload.Connection.Agent)
	}
	if payload.Environment["RUNWAKE_TEMPORARY_TTL"] != "2m0s" {
		t.Fatalf("temporary TTL environment missing: %#v", payload.Environment)
	}
	stored, ok := state.GetConnection(payload.Connection.ID)
	if !ok || stored.Agent.ExpiresAt.IsZero() {
		t.Fatal("temporary enrollment was not persisted")
	}
}

func TestRemoteAgentTransportAndStream(t *testing.T) {
	s, state, _, fake := newTestServer(t, "")
	token := "agent-secret"
	connection := model.Connection{ID: "connection_agent", Name: "remote", Kind: model.ConnectionKubernetes, Mode: model.ModeAgent, Agent: &model.AgentConnection{TokenHash: agent.HashToken(token), RunMode: "persistent"}}
	if err := state.SaveConnection(connection); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	client, err := agent.NewClient(agent.ClientConfig{
		ServerURL: httpServer.URL, ConnectionID: connection.ID, Token: token, Kind: model.ConnectionKubernetes,
		HeartbeatInterval: 40 * time.Millisecond, InventoryInterval: 40 * time.Millisecond,
		ReconnectMin: 20 * time.Millisecond, ReconnectMax: 100 * time.Millisecond,
	}, fake, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = client.Run(ctx) }()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if status := s.agents.Status(connection.ID); status.AgentOnline {
			if _, ok := s.agents.Inventory(connection.ID); ok {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status := s.agents.Status(connection.ID); !status.AgentOnline {
		t.Fatalf("agent did not connect: %#v", status)
	}
	inventory, ok := s.agents.Inventory(connection.ID)
	if !ok || len(inventory.Workloads) != 1 || len(inventory.Metrics) != 1 {
		t.Fatalf("agent inventory unavailable: %#v", inventory)
	}

	streamCtx, streamCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer streamCancel()
	req, _ := http.NewRequestWithContext(streamCtx, http.MethodGet, httpServer.URL+"/api/v1/activity/stream?connection_id=connection_agent&kind=Deployment&namespace=payments&name=checkout-api", nil)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	scanner := bufio.NewScanner(response.Body)
	found := false
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), `"message":"ready"`) {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("record did not traverse remote agent transport")
	}

	metricCtx, metricCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer metricCancel()
	metricReq, _ := http.NewRequestWithContext(metricCtx, http.MethodGet, httpServer.URL+"/api/v1/metrics/stream?connection_id=connection_agent&kind=Deployment&namespace=payments&name=checkout-api", nil)
	metricResponse, err := http.DefaultClient.Do(metricReq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = metricResponse.Body.Close() }()
	metricScanner := bufio.NewScanner(metricResponse.Body)
	metricFound := false
	for metricScanner.Scan() {
		if strings.Contains(metricScanner.Text(), `"source":"test"`) {
			metricFound = true
			break
		}
	}
	if !metricFound {
		t.Fatal("metric did not traverse remote agent transport")
	}
}

func TestKubernetesEnvironmentIsEncryptedRedactedAndDeleted(t *testing.T) {
	s, state, secrets, _ := newTestServer(t, "")
	h := s.Handler()
	body := `{"name":"eks","kind":"kubernetes","skip_test":true,"kubernetes":{"kubeconfig_source":"path","kubeconfig_path":"/tmp/config","namespace_mode":"all","exec_policy":"allowlist","environment":{"AWS_PROFILE":"production","AWS_REGION":"us-east-1"}}}`
	create := httptest.NewRecorder()
	h.ServeHTTP(create, httptest.NewRequest(http.MethodPost, "/api/v1/connections", strings.NewReader(body)))
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	if strings.Contains(create.Body.String(), "AWS_PROFILE") || strings.Contains(create.Body.String(), "environment_secret") {
		t.Fatalf("environment material leaked in response: %s", create.Body.String())
	}
	var created model.Connection
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	stored, ok := state.GetConnection(created.ID)
	if !ok || stored.Kubernetes == nil || stored.Kubernetes.EnvironmentSecret == "" {
		t.Fatalf("environment secret was not persisted: %#v", stored)
	}
	secretID := stored.Kubernetes.EnvironmentSecret
	plain, err := secrets.Get(secretID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(plain, []byte(`"AWS_PROFILE":"production"`)) {
		t.Fatalf("unexpected encrypted payload after decrypt: %s", plain)
	}
	remove := httptest.NewRecorder()
	h.ServeHTTP(remove, httptest.NewRequest(http.MethodDelete, "/api/v1/connections/"+created.ID, nil))
	if remove.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", remove.Code, remove.Body.String())
	}
	if _, err := secrets.Get(secretID); err == nil {
		t.Fatal("environment secret was not deleted")
	}
}
