package kube

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
)

const (
	defaultTokenFile = "/var/run/secrets/kubernetes.io/serviceaccount/token" //nolint:gosec // This is a Kubernetes service-account file path, not a credential.
	defaultCAFile    = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
)

type InClusterProvider struct {
	connectionID   string
	connectionName string
	baseURL        string
	token          string
	username       string
	password       string
	authentication string
	client         *http.Client
	namespaces     []string
	tailLines      int
}

func NewInClusterProvider(connectionID, connectionName string, namespaces []string, tailLines int) (*InClusterProvider, error) {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT_HTTPS")
	if port == "" {
		port = os.Getenv("KUBERNETES_SERVICE_PORT")
	}
	if host == "" || port == "" {
		return nil, errors.New("KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT are required")
	}
	tokenBytes, err := os.ReadFile(envOr("RUNWAKE_SERVICEACCOUNT_TOKEN_FILE", defaultTokenFile))
	if err != nil {
		return nil, fmt.Errorf("read service account token: %w", err)
	}
	caBytes, err := os.ReadFile(envOr("RUNWAKE_SERVICEACCOUNT_CA_FILE", defaultCAFile))
	if err != nil {
		return nil, fmt.Errorf("read service account CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		return nil, errors.New("service account CA file does not contain a valid certificate")
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			RootCAs:    pool,
		},
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
	}
	if tailLines <= 0 {
		tailLines = 200
	}
	return &InClusterProvider{
		connectionID:   connectionID,
		connectionName: connectionName,
		baseURL:        "https://" + host + ":" + port,
		token:          strings.TrimSpace(string(tokenBytes)),
		authentication: "service-account",
		client:         &http.Client{Transport: transport},
		namespaces:     append([]string(nil), namespaces...),
		tailLines:      tailLines,
	}, nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func (p *InClusterProvider) request(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, p.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	if p.token != "" {
		req.Header.Set("Authorization", "Bearer "+p.token)
	} else if p.username != "" {
		req.SetBasicAuth(p.username, p.password)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "runwake-agent/0.1")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer func() { _ = resp.Body.Close() }()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024))
		return nil, fmt.Errorf("kubernetes API %s %s returned %s: %s", method, path, resp.Status, strings.TrimSpace(string(data)))
	}
	return resp, nil
}

func (p *InClusterProvider) getJSON(ctx context.Context, path string, target any) error {
	resp, err := p.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	return json.NewDecoder(resp.Body).Decode(target)
}

func (p *InClusterProvider) Test(ctx context.Context) (model.ProviderInfo, error) {
	var version struct {
		GitVersion string `json:"gitVersion"`
	}
	if err := p.getJSON(ctx, "/version", &version); err != nil {
		return model.ProviderInfo{}, err
	}
	return model.ProviderInfo{State: "connected", Details: map[string]string{"server": version.GitVersion, "authentication": p.authentication}}, nil
}

func (p *InClusterProvider) Namespaces(ctx context.Context) ([]string, error) {
	if len(p.namespaces) > 0 {
		out := append([]string(nil), p.namespaces...)
		sort.Strings(out)
		return out, nil
	}
	var list struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
		} `json:"items"`
	}
	if err := p.getJSON(ctx, "/api/v1/namespaces", &list); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list.Items))
	for _, item := range list.Items {
		out = append(out, item.Metadata.Name)
	}
	sort.Strings(out)
	return out, nil
}

func (p *InClusterProvider) ListWorkloads(ctx context.Context) ([]model.Workload, error) {
	workloads := make(chan model.Workload)
	done := make(chan error, 1)
	go func() {
		done <- p.StreamWorkloads(ctx, workloads)
		close(workloads)
	}()
	out := make([]model.Workload, 0)
	for workload := range workloads {
		out = append(out, workload)
	}
	if err := <-done; err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Kind < out[j].Kind
	})
	return out, nil
}

func (p *InClusterProvider) StreamWorkloads(ctx context.Context, out chan<- model.Workload) error {
	paths := inClusterWorkloadPaths(p.namespaces)
	type result struct {
		items []model.Workload
		err   error
	}
	results := make(chan result, len(paths))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	allowed := map[string]bool{}
	for _, ns := range p.namespaces {
		allowed[ns] = true
	}
	for _, path := range paths {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				results <- result{err: ctx.Err()}
				return
			}
			defer func() { <-sem }()
			var list listEnvelope
			if err := p.getJSON(ctx, path, &list); err != nil {
				results <- result{err: err}
				return
			}
			kind := workloadKindForPath(path)
			for index := range list.Items {
				typed, err := stampWorkloadKind(list.Items[index], kind)
				if err != nil {
					results <- result{err: err}
					return
				}
				list.Items[index] = typed
			}
			data, err := json.Marshal(list)
			if err != nil {
				results <- result{err: err}
				return
			}
			items, err := parseWorkloadList(data, p.connectionID, p.connectionName, allowed)
			results <- result{items: items, err: err}
		}()
	}
	go func() {
		wg.Wait()
		close(results)
	}()
	var firstErr error
	for result := range results {
		if result.err != nil {
			if firstErr == nil {
				firstErr = result.err
			}
			continue
		}
		for _, workload := range result.items {
			select {
			case out <- workload:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return firstErr
}

func workloadKindForPath(path string) string {
	resource := path
	if index := strings.IndexByte(resource, '?'); index >= 0 {
		resource = resource[:index]
	}
	switch {
	case strings.HasSuffix(resource, "/deployments"):
		return "Deployment"
	case strings.HasSuffix(resource, "/statefulsets"):
		return "StatefulSet"
	case strings.HasSuffix(resource, "/daemonsets"):
		return "DaemonSet"
	case strings.HasSuffix(resource, "/jobs"):
		return "Job"
	case strings.HasSuffix(resource, "/pods"):
		return "Pod"
	default:
		return ""
	}
}

// Kubernetes collection responses may omit apiVersion and kind from each
// item because the enclosing list already supplies that type information.
// The shared workload parser needs the per-item kind to distinguish
// controller-owned Pods from top-level workload objects.
func stampWorkloadKind(raw json.RawMessage, kind string) (json.RawMessage, error) {
	if kind == "" {
		return nil, errors.New("cannot determine Kubernetes workload kind from API path")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	encodedKind, _ := json.Marshal(kind)
	object["kind"] = encodedKind
	return json.Marshal(object)
}

func inClusterWorkloadPaths(namespaces []string) []string {
	if len(namespaces) == 0 {
		return []string{
			"/apis/apps/v1/deployments",
			"/apis/apps/v1/statefulsets",
			"/apis/apps/v1/daemonsets",
			"/apis/batch/v1/jobs",
			"/api/v1/pods",
		}
	}
	paths := make([]string, 0, len(namespaces)*5)
	for _, namespace := range namespaces {
		namespace = url.PathEscape(namespace)
		paths = append(paths,
			"/apis/apps/v1/namespaces/"+namespace+"/deployments",
			"/apis/apps/v1/namespaces/"+namespace+"/statefulsets",
			"/apis/apps/v1/namespaces/"+namespace+"/daemonsets",
			"/apis/batch/v1/namespaces/"+namespace+"/jobs",
			"/api/v1/namespaces/"+namespace+"/pods",
		)
	}
	return paths
}

type apiPodSelection struct {
	namespace string
	exactName string
	selector  string
}

type activeAPIPod struct {
	pod         podObject
	fingerprint string
	cancel      context.CancelFunc
}

func (p *InClusterProvider) Stream(ctx context.Context, request model.StreamRequest, out chan<- model.ActivityRecord) error {
	selection, err := p.podSelection(ctx, request)
	if err != nil {
		return err
	}
	tail := request.TailLines
	if tail < 0 {
		tail = 0
	} else if tail == 0 {
		tail = p.tailLines
	}

	active := map[string]*activeAPIPod{}
	var streams sync.WaitGroup
	waitingNotified := false
	lastReadError := ""

	startPod := func(pod podObject, includeRecentEvents bool) {
		podCtx, cancel := context.WithCancel(ctx)
		active[podIdentity(pod)] = &activeAPIPod{pod: pod, fingerprint: podRuntimeFingerprint(pod), cancel: cancel}
		streams.Add(1)
		go func() {
			defer streams.Done()
			p.runAPIPodStreams(podCtx, request, pod, tail, includeRecentEvents, out)
		}()
	}

	reconcile := func(initial bool) error {
		pods, readErr := p.listSelectedPods(ctx, selection)
		if readErr != nil {
			if initial {
				return readErr
			}
			if readErr.Error() != lastReadError {
				lastReadError = readErr.Error()
				emitActivity(ctx, out, model.ActivityRecord{
					Timestamp: time.Now().UTC(), Type: "error", Level: "warning", Source: "kubernetes-watch",
					Message: "Could not refresh matching Pods", Fields: map[string]any{"error": readErr.Error()},
				})
			}
			return nil
		}
		lastReadError = ""
		pods = filterActivityPods(pods, request.Pod)
		seen := make(map[string]bool, len(pods))
		for _, pod := range pods {
			key := podIdentity(pod)
			seen[key] = true
			current := active[key]
			fingerprint := podRuntimeFingerprint(pod)
			if current == nil {
				emitActivity(ctx, out, model.ActivityRecord{
					Timestamp: time.Now().UTC(), Type: "system", Level: "info", Source: "kubernetes-watch", Pod: pod.Metadata.Name,
					Message: "Pod added to activity stream", Fields: map[string]any{"uid": pod.Metadata.UID, "phase": pod.Status.Phase},
				})
				startPod(pod, true)
				continue
			}
			for _, record := range podStateRecords(current.pod, pod) {
				emitActivity(ctx, out, record)
			}
			if fingerprint != current.fingerprint {
				current.cancel()
				delete(active, key)
				startPod(pod, false)
				continue
			}
			current.pod = pod
		}
		for key, current := range active {
			if seen[key] {
				continue
			}
			current.cancel()
			delete(active, key)
			emitActivity(ctx, out, model.ActivityRecord{
				Timestamp: time.Now().UTC(), Type: "system", Level: "info", Source: "kubernetes-watch", Pod: current.pod.Metadata.Name,
				Message: "Pod removed from activity stream", Fields: map[string]any{"uid": current.pod.Metadata.UID},
			})
		}
		if len(pods) == 0 && !waitingNotified {
			waitingNotified = true
			emitActivity(ctx, out, model.ActivityRecord{
				Timestamp: time.Now().UTC(), Type: "state", Level: "info", Source: "kubernetes-watch",
				Message: "No matching Pods are currently available; waiting for changes",
			})
		} else if len(pods) > 0 {
			waitingNotified = false
		}
		return nil
	}

	if err := reconcile(true); err != nil {
		return err
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	defer func() {
		for _, current := range active {
			current.cancel()
		}
		streams.Wait()
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := reconcile(false); err != nil {
				return err
			}
		}
	}
}

func (p *InClusterProvider) runAPIPodStreams(ctx context.Context, request model.StreamRequest, pod podObject, tail int, includeRecentEvents bool, out chan<- model.ActivityRecord) {
	p.emitCurrentPodState(pod, out)
	var wg sync.WaitGroup
	if request.Events {
		if includeRecentEvents {
			wg.Add(1)
			go func() {
				defer wg.Done()
				p.emitRecentEvents(ctx, pod, out)
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.watchEvents(ctx, pod, out)
		}()
	}
	for _, status := range podContainerStatuses(pod) {
		if !activityContainerSelected(request.Container, status.Name) {
			continue
		}
		if request.Previous && status.RestartCount > 0 {
			wg.Add(1)
			go func(status containerStatus) {
				defer wg.Done()
				p.streamLogs(ctx, pod.Metadata.Namespace, pod.Metadata.Name, status.Name, tail, true, false, out)
			}(status)
		}
		wg.Add(1)
		go func(status containerStatus) {
			defer wg.Done()
			p.streamLogs(ctx, pod.Metadata.Namespace, pod.Metadata.Name, status.Name, tail, false, true, out)
		}(status)
	}
	wg.Wait()
}

func (p *InClusterProvider) podSelection(ctx context.Context, request model.StreamRequest) (apiPodSelection, error) {
	selection := apiPodSelection{namespace: request.Namespace}
	if strings.EqualFold(request.Kind, "Pod") {
		selection.exactName = request.Name
		return selection, nil
	}
	kindPath := map[string]string{
		"deployment":  "/apis/apps/v1/namespaces/%s/deployments/%s",
		"statefulset": "/apis/apps/v1/namespaces/%s/statefulsets/%s",
		"daemonset":   "/apis/apps/v1/namespaces/%s/daemonsets/%s",
		"job":         "/apis/batch/v1/namespaces/%s/jobs/%s",
	}
	format, ok := kindPath[strings.ToLower(request.Kind)]
	if !ok {
		return apiPodSelection{}, fmt.Errorf("unsupported Kubernetes workload kind %q", request.Kind)
	}
	var obj workloadObject
	path := fmt.Sprintf(format, url.PathEscape(request.Namespace), url.PathEscape(request.Name))
	if err := p.getJSON(ctx, path, &obj); err != nil {
		return apiPodSelection{}, err
	}
	selection.selector = selectorString(obj.Spec.Selector)
	if strings.EqualFold(request.Kind, "Job") && selection.selector == "" {
		selection.selector = "batch.kubernetes.io/job-name=" + request.Name
	}
	if selection.selector == "" {
		return apiPodSelection{}, errors.New("workload does not expose a pod selector")
	}
	return selection, nil
}

func (p *InClusterProvider) listSelectedPods(ctx context.Context, selection apiPodSelection) ([]podObject, error) {
	if selection.exactName != "" {
		var pod podObject
		path := "/api/v1/namespaces/" + url.PathEscape(selection.namespace) + "/pods/" + url.PathEscape(selection.exactName)
		if err := p.getJSON(ctx, path, &pod); err != nil {
			return nil, err
		}
		return []podObject{pod}, nil
	}
	var list struct {
		Items []podObject `json:"items"`
	}
	path := "/api/v1/namespaces/" + url.PathEscape(selection.namespace) + "/pods?labelSelector=" + url.QueryEscape(selection.selector)
	if err := p.getJSON(ctx, path, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (p *InClusterProvider) resolvePods(ctx context.Context, request model.StreamRequest) ([]podObject, error) {
	selection, err := p.podSelection(ctx, request)
	if err != nil {
		return nil, err
	}
	return p.listSelectedPods(ctx, selection)
}

func (p *InClusterProvider) emitCurrentPodState(pod podObject, out chan<- model.ActivityRecord) {
	for _, status := range allContainerStatuses(pod.Status) {
		fields := map[string]any{"ready": status.Ready, "restart_count": status.RestartCount, "state": containerStateName(status.State)}
		if status.LastState.Terminated != nil {
			fields["previous_exit_code"] = status.LastState.Terminated.ExitCode
			fields["previous_reason"] = status.LastState.Terminated.Reason
			fields["previous_finished_at"] = status.LastState.Terminated.FinishedAt
		}
		select {
		case out <- model.ActivityRecord{Timestamp: time.Now().UTC(), Type: "state", Level: "info", Source: "kubernetes-pod", Pod: pod.Metadata.Name, Container: status.Name, Message: "Current container state", Fields: fields}:
		default:
		}
	}
}

func (p *InClusterProvider) emitRecentEvents(ctx context.Context, pod podObject, out chan<- model.ActivityRecord) {
	var events eventList
	path := "/api/v1/namespaces/" + url.PathEscape(pod.Metadata.Namespace) + "/events?fieldSelector=" + url.QueryEscape("involvedObject.name="+pod.Metadata.Name)
	if err := p.getJSON(ctx, path, &events); err != nil {
		return
	}
	sort.Slice(events.Items, func(i, j int) bool { return eventTimestamp(events.Items[i]).Before(eventTimestamp(events.Items[j])) })
	start := 0
	if len(events.Items) > 30 {
		start = len(events.Items) - 30
	}
	for _, event := range events.Items[start:] {
		select {
		case out <- eventRecord(event):
		case <-ctx.Done():
			return
		}
	}
}

func (p *InClusterProvider) watchEvents(ctx context.Context, pod podObject, out chan<- model.ActivityRecord) {
	path := "/api/v1/namespaces/" + url.PathEscape(pod.Metadata.Namespace) + "/events?watch=true&allowWatchBookmarks=true&fieldSelector=" + url.QueryEscape("involvedObject.name="+pod.Metadata.Name)
	resp, err := p.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return
	}
	defer func() { _ = resp.Body.Close() }()
	decoder := json.NewDecoder(resp.Body)
	for {
		var envelope watchEnvelope
		if err := decoder.Decode(&envelope); err != nil {
			return
		}
		if envelope.Type == "BOOKMARK" {
			continue
		}
		var event eventObject
		if json.Unmarshal(envelope.Object, &event) != nil {
			continue
		}
		select {
		case out <- eventRecord(event):
		case <-ctx.Done():
			return
		}
	}
}

func (p *InClusterProvider) streamLogs(ctx context.Context, namespace, pod, container string, tail int, previous, follow bool, out chan<- model.ActivityRecord) {
	values := url.Values{}
	values.Set("container", container)
	values.Set("timestamps", "true")
	values.Set("tailLines", strconv.Itoa(tail))
	values.Set("previous", strconv.FormatBool(previous))
	values.Set("follow", strconv.FormatBool(follow))
	path := "/api/v1/namespaces/" + url.PathEscape(namespace) + "/pods/" + url.PathEscape(pod) + "/log?" + values.Encode()
	resp, err := p.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		if previous {
			return
		}
		select {
		case out <- model.ActivityRecord{Timestamp: time.Now().UTC(), Type: "error", Level: "error", Source: "runwake-agent", Pod: pod, Container: container, Message: err.Error()}:
		case <-ctx.Done():
		}
		return
	}
	defer func() { _ = resp.Body.Close() }()
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		ts, message := splitTimestamp(scanner.Text())
		fields := map[string]any{}
		if previous {
			fields["previous"] = true
		}
		record := model.ActivityRecord{Timestamp: ts, Type: "log", Level: "log", Source: "kubernetes-log", Pod: pod, Container: container, Message: message, Fields: fields}
		select {
		case out <- record:
		case <-ctx.Done():
			return
		}
	}
}

func EncodeInClusterKubeconfig(server string, caData []byte, token string) []byte {
	// Reserved for future direct REST tests. Keeping the helper here avoids forcing
	// the rest of the codebase to depend on a YAML package.
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "server=%s\nca=%d bytes\ntoken=%d bytes\n", server, len(caData), len(token))
	return buf.Bytes()
}

func (p *InClusterProvider) ListMetrics(ctx context.Context) ([]model.WorkloadMetric, error) {
	workloads, err := p.ListWorkloads(ctx)
	if err != nil {
		return nil, err
	}
	pods, err := p.listMetricPods(ctx)
	if err != nil {
		return nil, err
	}
	items, err := p.listPodMetrics(ctx)
	if err != nil {
		return nil, err
	}
	return aggregateAllMetrics(p.connectionID, p.connectionName, workloads, pods, items), nil
}

func (p *InClusterProvider) StreamMetrics(ctx context.Context, request model.MetricRequest, out chan<- model.WorkloadMetric) error {
	pods, err := p.resolvePods(ctx, model.StreamRequest{ConnectionID: request.ConnectionID, Kind: request.Kind, Namespace: request.Namespace, Name: request.Name})
	if err != nil {
		return err
	}
	interval := time.Duration(request.IntervalSeconds) * time.Second
	if interval < 10*time.Second {
		interval = 15 * time.Second
	}
	emit := func() error {
		items, readErr := p.metricsForPods(ctx, pods)
		if readErr != nil {
			return readErr
		}
		metric, aggregateErr := aggregateSelectedMetrics(p.connectionID, p.connectionName, request, pods, items)
		if aggregateErr != nil {
			return aggregateErr
		}
		select {
		case out <- metric:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if emitErr := emit(); emitErr != nil {
		return emitErr
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			pods, err = p.resolvePods(ctx, model.StreamRequest{ConnectionID: request.ConnectionID, Kind: request.Kind, Namespace: request.Namespace, Name: request.Name})
			if err != nil {
				return err
			}
			if err := emit(); err != nil {
				return err
			}
		}
	}
}

func (p *InClusterProvider) listMetricPods(ctx context.Context) ([]podObject, error) {
	var out []podObject
	paths := []string{"/api/v1/pods"}
	if len(p.namespaces) > 0 {
		paths = paths[:0]
		for _, namespace := range p.namespaces {
			paths = append(paths, "/api/v1/namespaces/"+url.PathEscape(namespace)+"/pods")
		}
	}
	for _, path := range paths {
		var list struct {
			Items []podObject `json:"items"`
		}
		if err := p.getJSON(ctx, path, &list); err != nil {
			return nil, err
		}
		out = append(out, list.Items...)
	}
	return out, nil
}

func (p *InClusterProvider) listPodMetrics(ctx context.Context) ([]podMetric, error) {
	var out []podMetric
	paths := []string{"/apis/metrics.k8s.io/v1beta1/pods"}
	if len(p.namespaces) > 0 {
		paths = paths[:0]
		for _, namespace := range p.namespaces {
			paths = append(paths, "/apis/metrics.k8s.io/v1beta1/namespaces/"+url.PathEscape(namespace)+"/pods")
		}
	}
	for _, path := range paths {
		var list podMetricsList
		if err := p.getJSON(ctx, path, &list); err != nil {
			return nil, fmt.Errorf("kubernetes Metrics API is unavailable or access was denied: %w", err)
		}
		out = append(out, list.Items...)
	}
	return out, nil
}

func (p *InClusterProvider) metricsForPods(ctx context.Context, pods []podObject) ([]podMetric, error) {
	items := make([]podMetric, 0, len(pods))
	for _, pod := range pods {
		var item podMetric
		path := "/apis/metrics.k8s.io/v1beta1/namespaces/" + url.PathEscape(pod.Metadata.Namespace) + "/pods/" + url.PathEscape(pod.Metadata.Name)
		if err := p.getJSON(ctx, path, &item); err != nil {
			return nil, fmt.Errorf("kubernetes Metrics API is unavailable or access was denied: %w", err)
		}
		items = append(items, item)
	}
	return items, nil
}
