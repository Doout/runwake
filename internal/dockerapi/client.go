package dockerapi

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
)

type TLSMaterial struct {
	CA         []byte
	Cert       []byte
	Key        []byte
	ServerName string
}

type Client struct {
	endpoint   string
	baseURL    *url.URL
	httpClient *http.Client
	apiVersion string
	mu         sync.Mutex
}

func New(endpoint string, tlsMaterial TLSMaterial) (*Client, error) {
	return newClient(endpoint, tlsMaterial, nil, "")
}

func NewWithProxy(endpoint string, tlsMaterial TLSMaterial, proxyURL string) (*Client, error) {
	return newClient(endpoint, tlsMaterial, nil, proxyURL)
}

func NewWithDialer(endpoint string, dialer func(context.Context, string, string) (net.Conn, error)) (*Client, error) {
	if dialer == nil {
		return nil, errors.New("docker dialer is required")
	}
	return newClient(endpoint, TLSMaterial{}, dialer, "")
}

func newClient(endpoint string, tlsMaterial TLSMaterial, customDialer func(context.Context, string, string) (net.Conn, error), proxyURL string) (*Client, error) {
	if endpoint == "" {
		endpoint = "unix:///var/run/docker.sock"
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	if strings.TrimSpace(proxyURL) != "" {
		parsedProxy, parseErr := url.Parse(proxyURL)
		if parseErr != nil {
			return nil, fmt.Errorf("invalid Docker HTTP proxy: %w", parseErr)
		}
		if parsedProxy.Scheme != "http" && parsedProxy.Scheme != "https" {
			return nil, errors.New("docker HTTP proxy must use http or https")
		}
		transport.Proxy = http.ProxyURL(parsedProxy)
	}
	baseURL := &url.URL{Scheme: "http", Host: "docker"}
	if customDialer != nil {
		transport.Proxy = nil
		transport.DialContext = customDialer
		return &Client{endpoint: endpoint, baseURL: baseURL, httpClient: &http.Client{Transport: transport}}, nil
	}
	switch parsed.Scheme {
	case "unix":
		socket := parsed.Path
		if socket == "" {
			return nil, errors.New("docker unix endpoint requires a socket path")
		}
		transport.Proxy = nil
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socket)
		}
	case "tcp", "http", "https", "tls":
		if parsed.Host == "" {
			return nil, errors.New("docker network endpoint requires a host")
		}
		scheme := parsed.Scheme
		tlsConfigured := len(tlsMaterial.CA) > 0 || len(tlsMaterial.Cert) > 0 || len(tlsMaterial.Key) > 0 || tlsMaterial.ServerName != ""
		switch scheme {
		case "tls":
			scheme = "https"
		case "tcp":
			scheme = "http"
			if tlsConfigured {
				scheme = "https"
			}
		}
		baseURL = &url.URL{Scheme: scheme, Host: parsed.Host}
		if scheme == "https" {
			tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: tlsMaterial.ServerName}
			if len(tlsMaterial.CA) > 0 {
				pool := x509.NewCertPool()
				if !pool.AppendCertsFromPEM(tlsMaterial.CA) {
					return nil, errors.New("docker CA does not contain a valid PEM certificate")
				}
				tlsConfig.RootCAs = pool
			}
			if len(tlsMaterial.Cert) > 0 || len(tlsMaterial.Key) > 0 {
				cert, err := tls.X509KeyPair(tlsMaterial.Cert, tlsMaterial.Key)
				if err != nil {
					return nil, fmt.Errorf("load Docker client certificate: %w", err)
				}
				tlsConfig.Certificates = []tls.Certificate{cert}
			}
			transport.TLSClientConfig = tlsConfig
		}
	default:
		return nil, fmt.Errorf("unsupported Docker endpoint scheme %q", parsed.Scheme)
	}
	return &Client{endpoint: endpoint, baseURL: baseURL, httpClient: &http.Client{Transport: transport}}, nil
}

func (c *Client) Endpoint() string { return c.endpoint }

func (c *Client) Negotiate(ctx context.Context) (Version, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.apiVersion != "" {
		return c.Version(ctx)
	}
	var version Version
	if err := c.getJSON(ctx, false, "/version", nil, &version); err != nil {
		return Version{}, err
	}
	if version.APIVersion == "" {
		return Version{}, errors.New("docker daemon did not report an API version")
	}
	c.apiVersion = version.APIVersion
	return version, nil
}

func (c *Client) Version(ctx context.Context) (Version, error) {
	var version Version
	if err := c.getJSON(ctx, false, "/version", nil, &version); err != nil {
		return Version{}, err
	}
	return version, nil
}

func (c *Client) Ping(ctx context.Context) error {
	resp, err := c.get(ctx, false, "/_ping", nil)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

func (c *Client) apiPath(resource string) string {
	if c.apiVersion == "" {
		return resource
	}
	return "/v" + c.apiVersion + resource
}

func (c *Client) get(ctx context.Context, versioned bool, resource string, query url.Values) (*http.Response, error) {
	u := *c.baseURL
	if versioned {
		resource = c.apiPath(resource)
	}
	u.Path = path.Join(u.Path, resource)
	if strings.HasSuffix(resource, "/") && !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "runwake/0.1")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer func() { _ = resp.Body.Close() }()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		var payload struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &payload)
		if payload.Message == "" {
			payload.Message = strings.TrimSpace(string(data))
		}
		return nil, fmt.Errorf("docker API GET %s returned %s: %s", resource, resp.Status, payload.Message)
	}
	return resp, nil
}

func (c *Client) getJSON(ctx context.Context, versioned bool, resource string, query url.Values, target any) error {
	resp, err := c.get(ctx, versioned, resource, query)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	return json.NewDecoder(resp.Body).Decode(target)
}

type Version struct {
	Version       string `json:"Version"`
	APIVersion    string `json:"ApiVersion"`
	MinAPIVersion string `json:"MinAPIVersion"`
	GitCommit     string `json:"GitCommit"`
	OS            string `json:"Os"`
	Arch          string `json:"Arch"`
	KernelVersion string `json:"KernelVersion"`
}

type ContainerSummary struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	ImageID string            `json:"ImageID"`
	Command string            `json:"Command"`
	Created int64             `json:"Created"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Labels  map[string]string `json:"Labels"`
}

type ContainerInspect struct {
	ID           string `json:"Id"`
	Name         string `json:"Name"`
	RestartCount int    `json:"RestartCount"`
	Created      string `json:"Created"`
	Config       struct {
		Image        string              `json:"Image"`
		Hostname     string              `json:"Hostname"`
		Tty          bool                `json:"Tty"`
		Labels       map[string]string   `json:"Labels"`
		ExposedPorts map[string]struct{} `json:"ExposedPorts"`
	} `json:"Config"`
	HostConfig struct {
		NetworkMode string `json:"NetworkMode"`
	} `json:"HostConfig"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
		Networks map[string]struct {
			NetworkID         string   `json:"NetworkID"`
			EndpointID        string   `json:"EndpointID"`
			Gateway           string   `json:"Gateway"`
			IPAddress         string   `json:"IPAddress"`
			GlobalIPv6Address string   `json:"GlobalIPv6Address"`
			Aliases           []string `json:"Aliases"`
			DNSNames          []string `json:"DNSNames"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Driver      string `json:"Driver"`
		Mode        string `json:"Mode"`
		RW          bool   `json:"RW"`
		Propagation string `json:"Propagation"`
	} `json:"Mounts"`
	State struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		Paused     bool   `json:"Paused"`
		Restarting bool   `json:"Restarting"`
		OOMKilled  bool   `json:"OOMKilled"`
		Dead       bool   `json:"Dead"`
		Pid        int    `json:"Pid"`
		ExitCode   int    `json:"ExitCode"`
		Error      string `json:"Error"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		Health     *struct {
			Status        string `json:"Status"`
			FailingStreak int    `json:"FailingStreak"`
		} `json:"Health"`
	} `json:"State"`
}

type ContainerStats struct {
	Read      time.Time `json:"read"`
	PreRead   time.Time `json:"preread"`
	PidsStats struct {
		Current int64 `json:"current"`
	} `json:"pids_stats"`
	Networks map[string]struct {
		RxBytes int64 `json:"rx_bytes"`
		TxBytes int64 `json:"tx_bytes"`
	} `json:"networks"`
	MemoryStats struct {
		Usage int64            `json:"usage"`
		Limit int64            `json:"limit"`
		Stats map[string]int64 `json:"stats"`
	} `json:"memory_stats"`
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	BlkioStats struct {
		IOServiceBytesRecursive []struct {
			Op    string `json:"op"`
			Value int64  `json:"value"`
		} `json:"io_service_bytes_recursive"`
	} `json:"blkio_stats"`
}

type Event struct {
	Type   string `json:"Type"`
	Action string `json:"Action"`
	Actor  struct {
		ID         string            `json:"ID"`
		Attributes map[string]string `json:"Attributes"`
	} `json:"Actor"`
	Scope    string `json:"scope"`
	Time     int64  `json:"time"`
	TimeNano int64  `json:"timeNano"`
}

func (c *Client) ListContainers(ctx context.Context) ([]ContainerSummary, error) {
	if _, err := c.Negotiate(ctx); err != nil {
		return nil, err
	}
	var containers []ContainerSummary
	query := url.Values{"all": {"1"}}
	if err := c.getJSON(ctx, true, "/containers/json", query, &containers); err != nil {
		return nil, err
	}
	return containers, nil
}

func (c *Client) Inspect(ctx context.Context, id string) (ContainerInspect, error) {
	if _, err := c.Negotiate(ctx); err != nil {
		return ContainerInspect{}, err
	}
	var inspect ContainerInspect
	if err := c.getJSON(ctx, true, "/containers/"+url.PathEscape(id)+"/json", nil, &inspect); err != nil {
		return ContainerInspect{}, err
	}
	return inspect, nil
}

func (c *Client) ListWorkloads(ctx context.Context, connectionID, connectionName string) ([]model.Workload, error) {
	workloads := make(chan model.Workload)
	done := make(chan error, 1)
	go func() {
		done <- c.StreamWorkloads(ctx, connectionID, connectionName, workloads)
		close(workloads)
	}()
	out := make([]model.Workload, 0)
	for workload := range workloads {
		out = append(out, workload)
	}
	if err := <-done; err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func (c *Client) StreamWorkloads(ctx context.Context, connectionID, connectionName string, out chan<- model.Workload) error {
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return err
	}
	type result struct {
		workload model.Workload
		err      error
	}
	sem := make(chan struct{}, 8)
	results := make(chan result, len(containers))
	var wg sync.WaitGroup
	for _, summary := range containers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			inspect, err := c.Inspect(ctx, summary.ID)
			<-sem
			if err != nil {
				results <- result{err: err}
				return
			}
			results <- result{workload: dockerWorkload(summary, inspect, connectionID, connectionName)}
		}()
	}
	go func() {
		wg.Wait()
		close(results)
	}()
	for result := range results {
		if result.err != nil {
			continue
		}
		select {
		case out <- result.workload:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return ctx.Err()
}

func dockerWorkload(summary ContainerSummary, inspect ContainerInspect, connectionID, connectionName string) model.Workload {
	name := strings.TrimPrefix(inspect.Name, "/")
	if name == "" && len(summary.Names) > 0 {
		name = strings.TrimPrefix(summary.Names[0], "/")
	}
	state := inspect.State.Status
	severity := "muted"
	switch {
	case inspect.State.OOMKilled || inspect.State.Dead || (state == "exited" && inspect.State.ExitCode != 0):
		severity = "error"
	case inspect.State.Restarting:
		severity = "warning"
	case inspect.State.Health != nil && inspect.State.Health.Status == "unhealthy":
		severity = "warning"
	case inspect.State.Running:
		severity = "normal"
	}
	if inspect.State.Health != nil {
		state += " · " + inspect.State.Health.Status
	}
	labels := inspect.Config.Labels
	if labels == nil {
		labels = summary.Labels
	}
	updated, _ := time.Parse(time.RFC3339Nano, inspect.State.StartedAt)
	return model.Workload{
		ConnectionID: connectionID,
		Connection:   connectionName,
		Platform:     model.ConnectionDocker,
		Kind:         "Container",
		Name:         name,
		UID:          inspect.ID,
		State:        state,
		Severity:     severity,
		Ready:        boolInt(inspect.State.Running),
		Desired:      1,
		Restarts:     inspect.RestartCount,
		Images:       []string{inspect.Config.Image},
		Containers:   []string{name},
		Labels:       labels,
		StartedAt:    updated,
		Docker:       dockerWorkloadDetails(inspect, labels),
	}
}

func dockerWorkloadDetails(inspect ContainerInspect, labels map[string]string) *model.DockerWorkload {
	details := &model.DockerWorkload{
		ComposeProject:         labels["com.docker.compose.project"],
		ComposeService:         labels["com.docker.compose.service"],
		ComposeContainerNumber: labels["com.docker.compose.container-number"],
		ComposeWorkingDir:      labels["com.docker.compose.project.working_dir"],
		ComposeConfigFiles:     labels["com.docker.compose.project.config_files"],
		ComposeVersion:         labels["com.docker.compose.version"],
		DependsOn:              composeDependencies(labels["com.docker.compose.depends_on"]),
		Hostname:               inspect.Config.Hostname,
		NetworkMode:            inspect.HostConfig.NetworkMode,
	}
	for name, attachment := range inspect.NetworkSettings.Networks {
		aliases := append([]string(nil), attachment.Aliases...)
		for _, value := range attachment.DNSNames {
			if !containsString(aliases, value) {
				aliases = append(aliases, value)
			}
		}
		sort.Strings(aliases)
		details.Networks = append(details.Networks, model.DockerNetworkAttachment{
			Name: name, NetworkID: attachment.NetworkID, EndpointID: attachment.EndpointID,
			Gateway: attachment.Gateway, IPAddress: attachment.IPAddress,
			GlobalIPv6Address: attachment.GlobalIPv6Address, Aliases: aliases,
		})
	}
	sort.Slice(details.Networks, func(i, j int) bool { return details.Networks[i].Name < details.Networks[j].Name })

	for _, mount := range inspect.Mounts {
		details.Mounts = append(details.Mounts, model.DockerMount{
			Type: mount.Type, Name: mount.Name, Source: mount.Source, Destination: mount.Destination,
			Driver: mount.Driver, Mode: mount.Mode, Propagation: mount.Propagation, ReadOnly: !mount.RW,
		})
	}
	sort.Slice(details.Mounts, func(i, j int) bool {
		if details.Mounts[i].Destination == details.Mounts[j].Destination {
			return details.Mounts[i].Source < details.Mounts[j].Source
		}
		return details.Mounts[i].Destination < details.Mounts[j].Destination
	})

	portKeys := make(map[string]bool, len(inspect.Config.ExposedPorts)+len(inspect.NetworkSettings.Ports))
	for key := range inspect.Config.ExposedPorts {
		portKeys[key] = true
	}
	for key := range inspect.NetworkSettings.Ports {
		portKeys[key] = true
	}
	for key := range portKeys {
		containerPort, protocol := parseDockerPort(key)
		bindings := inspect.NetworkSettings.Ports[key]
		if len(bindings) == 0 {
			details.Ports = append(details.Ports, model.DockerPort{ContainerPort: containerPort, Protocol: protocol})
			continue
		}
		for _, binding := range bindings {
			hostPort, _ := strconv.Atoi(binding.HostPort)
			details.Ports = append(details.Ports, model.DockerPort{
				ContainerPort: containerPort, Protocol: protocol, HostIP: binding.HostIP, HostPort: hostPort,
			})
		}
	}
	sort.Slice(details.Ports, func(i, j int) bool {
		if details.Ports[i].ContainerPort == details.Ports[j].ContainerPort {
			if details.Ports[i].Protocol == details.Ports[j].Protocol {
				return details.Ports[i].HostPort < details.Ports[j].HostPort
			}
			return details.Ports[i].Protocol < details.Ports[j].Protocol
		}
		return details.Ports[i].ContainerPort < details.Ports[j].ContainerPort
	})
	return details
}

func composeDependencies(value string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, item := range strings.Split(value, ",") {
		name := strings.TrimSpace(strings.SplitN(item, ":", 2)[0])
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func parseDockerPort(value string) (int, string) {
	parts := strings.SplitN(value, "/", 2)
	port, _ := strconv.Atoi(parts[0])
	protocol := "tcp"
	if len(parts) == 2 && parts[1] != "" {
		protocol = parts[1]
	}
	return port, protocol
}

func containsString(values []string, target string) bool {
	return slices.Contains(values, target)
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (c *Client) resolveContainer(ctx context.Context, nameOrID string) (ContainerInspect, error) {
	inspect, err := c.Inspect(ctx, nameOrID)
	if err == nil {
		return inspect, nil
	}
	containers, listErr := c.ListContainers(ctx)
	if listErr != nil {
		return ContainerInspect{}, err
	}
	for _, item := range containers {
		if item.ID == nameOrID || strings.HasPrefix(item.ID, nameOrID) {
			return c.Inspect(ctx, item.ID)
		}
		for _, name := range item.Names {
			if strings.TrimPrefix(name, "/") == nameOrID {
				return c.Inspect(ctx, item.ID)
			}
		}
	}
	return ContainerInspect{}, err
}

func (c *Client) Stats(ctx context.Context, id string) (ContainerStats, error) {
	if _, err := c.Negotiate(ctx); err != nil {
		return ContainerStats{}, err
	}
	var stats ContainerStats
	// stream=false waits for the comparison sample required to calculate CPU
	// usage. Docker's one-shot mode returns immediately, but on current Engines
	// it can omit precpu_stats and make a busy container appear idle.
	query := url.Values{"stream": {"false"}}
	if err := c.getJSON(ctx, true, "/containers/"+url.PathEscape(id)+"/stats", query, &stats); err != nil {
		return ContainerStats{}, err
	}
	return stats, nil
}

func dockerMetric(stats ContainerStats, inspect ContainerInspect, connectionID, connectionName string) model.WorkloadMetric {
	name := strings.TrimPrefix(inspect.Name, "/")
	read := stats.Read
	if read.IsZero() {
		read = time.Now().UTC()
	}
	percent := dockerCPUPercent(stats)
	memory := stats.MemoryStats.Usage
	if inactive := firstNonZero(stats.MemoryStats.Stats["total_inactive_file"], stats.MemoryStats.Stats["inactive_file"], stats.MemoryStats.Stats["cache"]); inactive > 0 && inactive < memory {
		memory -= inactive
	}
	var rx, tx int64
	for _, network := range stats.Networks {
		rx += network.RxBytes
		tx += network.TxBytes
	}
	var readBytes, writeBytes int64
	for _, item := range stats.BlkioStats.IOServiceBytesRecursive {
		switch strings.ToLower(item.Op) {
		case "read":
			readBytes += item.Value
		case "write":
			writeBytes += item.Value
		}
	}
	container := model.ContainerMetric{
		Container: name, CPUPercent: &percent, CPUCores: percent / 100,
		MemoryBytes: memory, MemoryLimitBytes: stats.MemoryStats.Limit,
		NetworkReceiveBytes: rx, NetworkTransmitBytes: tx,
		BlockReadBytes: readBytes, BlockWriteBytes: writeBytes, PIDs: stats.PidsStats.Current,
	}
	return model.WorkloadMetric{
		Timestamp: read, ConnectionID: connectionID, Connection: connectionName,
		Platform: model.ConnectionDocker, Kind: "Container", Name: name, Source: "docker-stats",
		CPUCores: container.CPUCores, CPUPercent: container.CPUPercent,
		MemoryBytes: memory, MemoryLimitBytes: stats.MemoryStats.Limit,
		NetworkReceiveBytes: rx, NetworkTransmitBytes: tx,
		BlockReadBytes: readBytes, BlockWriteBytes: writeBytes, PIDs: stats.PidsStats.Current,
		Containers: []model.ContainerMetric{container},
	}
}

func dockerCPUPercent(stats ContainerStats) float64 {
	if stats.CPUStats.CPUUsage.TotalUsage <= stats.PreCPUStats.CPUUsage.TotalUsage || stats.CPUStats.SystemCPUUsage <= stats.PreCPUStats.SystemCPUUsage {
		return 0
	}
	cpuDelta := stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage
	systemDelta := stats.CPUStats.SystemCPUUsage - stats.PreCPUStats.SystemCPUUsage
	if cpuDelta == 0 || systemDelta == 0 {
		return 0
	}
	count := stats.CPUStats.OnlineCPUs
	if count == 0 {
		perCPUCount := uint64(len(stats.CPUStats.CPUUsage.PercpuUsage))
		if perCPUCount > uint64(^uint32(0)) {
			count = ^uint32(0)
		} else {
			count = uint32(perCPUCount)
		}
	}
	if count == 0 {
		count = 1
	}
	return float64(cpuDelta) / float64(systemDelta) * float64(count) * 100
}

func firstNonZero(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func (c *Client) ListMetrics(ctx context.Context, connectionID, connectionName string) ([]model.WorkloadMetric, error) {
	containers, err := c.ListContainers(ctx)
	if err != nil {
		return nil, err
	}
	type result struct {
		metric model.WorkloadMetric
		err    error
	}
	results := make(chan result, len(containers))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, summary := range containers {
		if summary.State != "running" {
			continue
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			inspect, inspectErr := c.Inspect(ctx, summary.ID)
			if inspectErr != nil {
				results <- result{err: inspectErr}
				return
			}
			stats, statsErr := c.Stats(ctx, summary.ID)
			if statsErr != nil {
				results <- result{err: statsErr}
				return
			}
			results <- result{metric: dockerMetric(stats, inspect, connectionID, connectionName)}
		}()
	}
	wg.Wait()
	close(results)
	out := make([]model.WorkloadMetric, 0, len(containers))
	var firstErr error
	for item := range results {
		if item.err != nil {
			if firstErr == nil {
				firstErr = item.err
			}
			continue
		}
		out = append(out, item.metric)
	}
	if len(out) == 0 && firstErr != nil {
		return nil, firstErr
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func (c *Client) StreamMetrics(ctx context.Context, request model.MetricRequest, connectionName string, out chan<- model.WorkloadMetric) error {
	inspect, err := c.resolveContainer(ctx, request.Name)
	if err != nil {
		return err
	}
	interval := time.Duration(request.IntervalSeconds) * time.Second
	if interval < time.Second {
		interval = 2 * time.Second
	}
	emit := func() error {
		stats, statsErr := c.Stats(ctx, inspect.ID)
		if statsErr != nil {
			return statsErr
		}
		metric := dockerMetric(stats, inspect, request.ConnectionID, connectionName)
		select {
		case out <- metric:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := emit(); err != nil {
		return err
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := emit(); err != nil {
				return err
			}
		}
	}
}

func (c *Client) StreamContainer(ctx context.Context, request model.StreamRequest, out chan<- model.ActivityRecord) error {
	inspect, err := c.resolveContainer(ctx, request.Name)
	if err != nil {
		return err
	}
	id := inspect.ID
	stateFields := map[string]any{
		"status":        inspect.State.Status,
		"running":       inspect.State.Running,
		"restarting":    inspect.State.Restarting,
		"oom_killed":    inspect.State.OOMKilled,
		"exit_code":     inspect.State.ExitCode,
		"restart_count": inspect.RestartCount,
		"started_at":    inspect.State.StartedAt,
		"finished_at":   inspect.State.FinishedAt,
	}
	if inspect.State.Health != nil {
		stateFields["health"] = inspect.State.Health.Status
		stateFields["failing_streak"] = inspect.State.Health.FailingStreak
	}
	select {
	case out <- model.ActivityRecord{Timestamp: time.Now().UTC(), Type: "state", Level: "info", Source: "docker-inspect", Container: strings.TrimPrefix(inspect.Name, "/"), Message: "Current container state", Fields: stateFields}:
	case <-ctx.Done():
		return ctx.Err()
	}

	var wg sync.WaitGroup
	errCh := make(chan error, 2)
	wg.Add(1)
	go func() {
		defer wg.Done()
		errCh <- c.streamLogs(ctx, inspect, request.TailLines, out)
	}()
	if request.Events {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- c.streamEvents(ctx, id, out)
		}()
	}
	go func() {
		wg.Wait()
		close(errCh)
	}()
	var firstErr error
	for err := range errCh {
		if err != nil && !errors.Is(err, context.Canceled) && firstErr == nil {
			firstErr = err
		}
	}
	if firstErr != nil {
		return firstErr
	}
	return ctx.Err()
}

func (c *Client) streamLogs(ctx context.Context, inspect ContainerInspect, tail int, out chan<- model.ActivityRecord) error {
	if tail < 0 {
		tail = 0
	} else if tail == 0 {
		tail = 200
	}
	query := url.Values{
		"follow":     {"1"},
		"stdout":     {"1"},
		"stderr":     {"1"},
		"timestamps": {"1"},
		"tail":       {strconv.Itoa(tail)},
	}
	resp, err := c.get(ctx, true, "/containers/"+url.PathEscape(inspect.ID)+"/logs", query)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	name := strings.TrimPrefix(inspect.Name, "/")
	if inspect.Config.Tty || !strings.Contains(resp.Header.Get("Content-Type"), "multiplexed-stream") && !strings.Contains(resp.Header.Get("Content-Type"), "raw-stream") {
		return scanLines(ctx, resp.Body, "log", func(ts time.Time, message string) error {
			select {
			case out <- model.ActivityRecord{Timestamp: ts, Type: "log", Level: "log", Source: "docker-log", Container: name, Message: message}:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}
	assembler := newDockerLineAssembler(func(stream byte, line string) error {
		level := "stdout"
		if stream == 2 {
			level = "stderr"
		}
		ts, message := parseTimestampedLine(line)
		select {
		case out <- model.ActivityRecord{Timestamp: ts, Type: "log", Level: level, Source: "docker-log", Container: name, Message: message}:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	err = decodeRawStream(ctx, resp.Body, assembler.WriteFrame)
	if flushErr := assembler.Flush(); err == nil {
		err = flushErr
	}
	return err
}

func (c *Client) streamEvents(ctx context.Context, containerID string, out chan<- model.ActivityRecord) error {
	filters, _ := json.Marshal(map[string][]string{"container": {containerID}})
	query := url.Values{"filters": {string(filters)}}
	resp, err := c.get(ctx, true, "/events", query)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	decoder := json.NewDecoder(resp.Body)
	for {
		var event Event
		if err := decoder.Decode(&event); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		ts := time.Unix(event.Time, 0).UTC()
		if event.TimeNano > 0 {
			ts = time.Unix(0, event.TimeNano).UTC()
		}
		level := "info"
		switch event.Action {
		case "oom", "die", "health_status: unhealthy":
			level = "warning"
		}
		fields := map[string]any{"action": event.Action, "type": event.Type}
		for key, value := range event.Actor.Attributes {
			if key == "name" || key == "image" || key == "exitCode" || key == "signal" {
				fields[key] = value
			}
		}
		select {
		case out <- model.ActivityRecord{Timestamp: ts, Type: "event", Level: level, Source: "docker-event", Container: event.Actor.Attributes["name"], Message: event.Action, Fields: fields}:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func decodeRawStream(ctx context.Context, reader io.Reader, handle func(stream byte, payload []byte) error) error {
	header := make([]byte, 8)
	for {
		if _, err := io.ReadFull(reader, header); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		size := binary.BigEndian.Uint32(header[4:8])
		if size > 16*1024*1024 {
			return fmt.Errorf("docker log frame is too large: %d bytes", size)
		}
		payload := make([]byte, size)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return err
		}
		if err := handle(header[0], payload); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
	}
}

func scanLines(ctx context.Context, reader io.Reader, _ string, handle func(time.Time, string) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		ts, message := parseTimestampedLine(line)
		if err := handle(ts, message); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
	}
	return scanner.Err()
}

func parseTimestampedLine(line string) (time.Time, string) {
	ts := time.Now().UTC()
	message := strings.TrimSuffix(line, "\r")
	parts := strings.SplitN(message, " ", 2)
	if len(parts) == 2 {
		if parsed, err := time.Parse(time.RFC3339Nano, parts[0]); err == nil {
			ts = parsed
			message = strings.TrimSuffix(parts[1], "\r")
		}
	}
	return ts, message
}

// dockerLineAssembler preserves line boundaries across Docker multiplexed
// frames. The Engine API is free to split a single stdout/stderr line into
// multiple frames, so treating each frame as an independent scanner loses or
// duplicates data. Buffers are kept independently for stdout and stderr.
type dockerLineAssembler struct {
	buffers map[byte][]byte
	handle  func(stream byte, line string) error
}

func newDockerLineAssembler(handle func(stream byte, line string) error) *dockerLineAssembler {
	return &dockerLineAssembler{buffers: make(map[byte][]byte), handle: handle}
}

func (a *dockerLineAssembler) WriteFrame(stream byte, payload []byte) error {
	if stream != 1 && stream != 2 {
		return nil
	}
	if len(a.buffers[stream]) > 0 {
		payload = stripDockerContinuationTimestamp(payload)
	}
	buffer := a.buffers[stream]
	buffer = append(buffer, payload...)
	if len(buffer) > 2*1024*1024 {
		return fmt.Errorf("docker log line is too large: more than %d bytes", 2*1024*1024)
	}
	for {
		index := strings.IndexByte(string(buffer), '\n')
		if index < 0 {
			break
		}
		line := strings.TrimSuffix(string(buffer[:index]), "\r")
		if err := a.handle(stream, line); err != nil {
			return err
		}
		buffer = buffer[index+1:]
	}
	a.buffers[stream] = append(a.buffers[stream][:0], buffer...)
	return nil
}

// With timestamps enabled Docker prefixes every raw log frame, including
// continuation frames for a single long line. Keep the first prefix so the
// completed line retains its timestamp, and remove prefixes from continuations.
func stripDockerContinuationTimestamp(payload []byte) []byte {
	space := strings.IndexByte(string(payload), ' ')
	if space <= 0 {
		return payload
	}
	if _, err := time.Parse(time.RFC3339Nano, string(payload[:space])); err != nil {
		return payload
	}
	return payload[space+1:]
}

func (a *dockerLineAssembler) Flush() error {
	for _, stream := range []byte{1, 2} {
		buffer := a.buffers[stream]
		if len(buffer) == 0 {
			continue
		}
		if err := a.handle(stream, strings.TrimSuffix(string(buffer), "\r")); err != nil {
			return err
		}
		a.buffers[stream] = nil
	}
	return nil
}
