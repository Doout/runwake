package dockerapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
	"time"
)

func TestNewWithProxyUsesExplicitHTTPProxy(t *testing.T) {
	client, err := NewWithProxy("tcp://docker.example.com:2375", TLSMaterial{}, "http://operator:secret@proxy.example.com:8080")
	if err != nil {
		t.Fatal(err)
	}
	transport, ok := client.httpClient.Transport.(*http.Transport)
	if !ok || transport.Proxy == nil {
		t.Fatalf("explicit proxy transport was not configured: %#v", client.httpClient.Transport)
	}
	requestURL, _ := url.Parse("http://docker.example.com/version")
	proxyURL, err := transport.Proxy(&http.Request{URL: requestURL})
	if err != nil {
		t.Fatal(err)
	}
	if proxyURL == nil || proxyURL.Host != "proxy.example.com:8080" || proxyURL.User.String() != "operator:secret" {
		t.Fatalf("proxy URL = %#v", proxyURL)
	}
}

func dockerFrame(stream byte, payload string) []byte {
	header := make([]byte, 8, 8+len(payload))
	header[0] = stream
	binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
	return append(header, []byte(payload)...)
}

func TestDockerLineAssemblerPreservesLinesAcrossFrames(t *testing.T) {
	var got []string
	assembler := newDockerLineAssembler(func(stream byte, line string) error {
		got = append(got, string(rune('0'+stream))+":"+line)
		return nil
	})
	payload := bytes.Join([][]byte{
		dockerFrame(1, "2026-07-27T10:00:00Z hel"),
		dockerFrame(2, "2026-07-27T10:00:01Z err"),
		dockerFrame(1, "lo\nsecond\npart"),
		dockerFrame(2, "or\n"),
		dockerFrame(1, "ial"),
	}, nil)
	if err := decodeRawStream(context.Background(), bytes.NewReader(payload), assembler.WriteFrame); err != nil {
		t.Fatal(err)
	}
	if err := assembler.Flush(); err != nil {
		t.Fatal(err)
	}
	want := []string{"1:2026-07-27T10:00:00Z hello", "1:second", "2:2026-07-27T10:00:01Z error", "1:partial"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected lines\n got: %#v\nwant: %#v", got, want)
	}
}

func TestDockerLineAssemblerRemovesContinuationFrameTimestamps(t *testing.T) {
	var got []string
	assembler := newDockerLineAssembler(func(_ byte, line string) error {
		got = append(got, line)
		return nil
	})
	const timestamp = "2026-07-27T10:00:00.123456789Z "
	if err := assembler.WriteFrame(1, []byte(timestamp+"long-")); err != nil {
		t.Fatal(err)
	}
	if err := assembler.WriteFrame(1, []byte(timestamp+"line\n")); err != nil {
		t.Fatal(err)
	}
	if want := []string{timestamp + "long-line"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected lines\n got: %#v\nwant: %#v", got, want)
	}
}

func TestDecodeRawStreamRejectsOversizedFrame(t *testing.T) {
	header := make([]byte, 8)
	header[0] = 1
	binary.BigEndian.PutUint32(header[4:], 17*1024*1024)
	if err := decodeRawStream(context.Background(), bytes.NewReader(header), func(byte, []byte) error { return nil }); err == nil {
		t.Fatal("expected oversized frame error")
	}
}

func TestParseTimestampedLine(t *testing.T) {
	ts, message := parseTimestampedLine("2026-07-27T14:32:27.123456789Z hello")
	if ts.Nanosecond() != 123456789 || message != "hello" {
		t.Fatalf("unexpected result: %s %q", ts, message)
	}
}

func TestDockerTLSEndpointAlias(t *testing.T) {
	client, err := New("tls://docker.example:2376", TLSMaterial{ServerName: "docker.example"})
	if err != nil {
		t.Fatal(err)
	}
	if client.baseURL.Scheme != "https" || client.baseURL.Host != "docker.example:2376" {
		t.Fatalf("base URL = %s", client.baseURL.String())
	}
}

func TestDockerTCPWithTLSKeyRequiresCertificate(t *testing.T) {
	_, err := New("tcp://docker.example:2376", TLSMaterial{Key: []byte("not-a-key")})
	if err == nil {
		t.Fatal("expected invalid TLS key pair to fail")
	}
}

func TestDockerCPUPercent(t *testing.T) {
	stats := ContainerStats{}
	stats.PreCPUStats.CPUUsage.TotalUsage = 100
	stats.CPUStats.CPUUsage.TotalUsage = 300
	stats.PreCPUStats.SystemCPUUsage = 1000
	stats.CPUStats.SystemCPUUsage = 2000
	stats.CPUStats.OnlineCPUs = 4
	if got := dockerCPUPercent(stats); got != 80 {
		t.Fatalf("CPU percent = %f, want 80", got)
	}
}

func TestStatsWaitsForCPUComparisonSample(t *testing.T) {
	var statsQuery string
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/version":
			_, _ = w.Write([]byte(`{"Version":"29.6.1","ApiVersion":"1.55"}`))
		case "/v1.55/containers/test/stats":
			statsQuery = r.URL.RawQuery
			_, _ = w.Write([]byte(`{"read":"2026-07-27T10:00:00Z"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer engine.Close()

	client, err := New(engine.URL, TLSMaterial{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Stats(context.Background(), "test"); err != nil {
		t.Fatal(err)
	}
	if statsQuery != "stream=false" {
		t.Fatalf("stats query = %q, want stream=false", statsQuery)
	}
}

func TestDockerMetricUsesWorkingSetAndIO(t *testing.T) {
	stats := ContainerStats{Read: time.Unix(10, 0).UTC()}
	stats.MemoryStats.Usage = 200 << 20
	stats.MemoryStats.Limit = 512 << 20
	stats.MemoryStats.Stats = map[string]int64{"inactive_file": 40 << 20}
	stats.PidsStats.Current = 7
	stats.Networks = map[string]struct {
		RxBytes int64 `json:"rx_bytes"`
		TxBytes int64 `json:"tx_bytes"`
	}{"eth0": {RxBytes: 100, TxBytes: 200}}
	stats.BlkioStats.IOServiceBytesRecursive = append(stats.BlkioStats.IOServiceBytesRecursive,
		struct {
			Op    string `json:"op"`
			Value int64  `json:"value"`
		}{Op: "Read", Value: 300},
		struct {
			Op    string `json:"op"`
			Value int64  `json:"value"`
		}{Op: "Write", Value: 400},
	)
	inspect := ContainerInspect{ID: "abc", Name: "/api"}
	metric := dockerMetric(stats, inspect, "c1", "local")
	if metric.MemoryBytes != 160<<20 || metric.NetworkReceiveBytes != 100 || metric.NetworkTransmitBytes != 200 || metric.BlockReadBytes != 300 || metric.BlockWriteBytes != 400 || metric.PIDs != 7 {
		t.Fatalf("unexpected metric: %#v", metric)
	}
}

func TestDockerWorkloadIncludesComposeTopology(t *testing.T) {
	inspect := ContainerInspect{ID: "abc", Name: "/api-web-1"}
	inspect.Config.Image = "example/web:latest"
	inspect.Config.Hostname = "api-web-1"
	inspect.Config.Labels = map[string]string{
		"com.docker.compose.project":              "api",
		"com.docker.compose.service":              "web",
		"com.docker.compose.container-number":     "1",
		"com.docker.compose.project.working_dir":  "/srv/api",
		"com.docker.compose.project.config_files": "/srv/api/compose.yaml",
		"com.docker.compose.version":              "2.39.1",
		"com.docker.compose.depends_on":           "db:service_healthy:false,cache:service_started:false",
	}
	inspect.Config.ExposedPorts = map[string]struct{}{"8080/tcp": {}, "9090/tcp": {}}
	inspect.HostConfig.NetworkMode = "api_default"
	inspect.NetworkSettings.Ports = map[string][]struct {
		HostIP   string `json:"HostIp"`
		HostPort string `json:"HostPort"`
	}{
		"8080/tcp": {{HostIP: "127.0.0.1", HostPort: "18080"}},
	}
	inspect.NetworkSettings.Networks = map[string]struct {
		NetworkID         string   `json:"NetworkID"`
		EndpointID        string   `json:"EndpointID"`
		Gateway           string   `json:"Gateway"`
		IPAddress         string   `json:"IPAddress"`
		GlobalIPv6Address string   `json:"GlobalIPv6Address"`
		Aliases           []string `json:"Aliases"`
		DNSNames          []string `json:"DNSNames"`
	}{
		"api_default": {NetworkID: "network-id", Gateway: "172.20.0.1", IPAddress: "172.20.0.4", Aliases: []string{"web"}, DNSNames: []string{"api-web-1"}},
	}
	inspect.Mounts = append(inspect.Mounts, struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Driver      string `json:"Driver"`
		Mode        string `json:"Mode"`
		RW          bool   `json:"RW"`
		Propagation string `json:"Propagation"`
	}{
		Type: "bind", Source: "/srv/api/config", Destination: "/app/config", RW: false,
	})

	workload := dockerWorkload(ContainerSummary{}, inspect, "connection_local", "Local Docker")
	if workload.Docker == nil {
		t.Fatal("Docker topology details are missing")
	}
	if workload.Docker.ComposeProject != "api" || workload.Docker.ComposeService != "web" || workload.Docker.NetworkMode != "api_default" {
		t.Fatalf("unexpected Docker details: %#v", workload.Docker)
	}
	if !reflect.DeepEqual(workload.Docker.DependsOn, []string{"cache", "db"}) {
		t.Fatalf("dependencies = %#v", workload.Docker.DependsOn)
	}
	if len(workload.Docker.Networks) != 1 || workload.Docker.Networks[0].IPAddress != "172.20.0.4" {
		t.Fatalf("networks = %#v", workload.Docker.Networks)
	}
	if len(workload.Docker.Mounts) != 1 || !workload.Docker.Mounts[0].ReadOnly {
		t.Fatalf("mounts = %#v", workload.Docker.Mounts)
	}
	if len(workload.Docker.Ports) != 2 || workload.Docker.Ports[0].HostPort != 18080 || workload.Docker.Ports[1].ContainerPort != 9090 {
		t.Fatalf("ports = %#v", workload.Docker.Ports)
	}
}
