package agent

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
)

type ClientConfig struct {
	ServerURL          string
	ConnectionID       string
	Token              string
	Kind               string
	CAFile             string
	InsecureSkipVerify bool
	InventoryInterval  time.Duration
	HeartbeatInterval  time.Duration
	ReconnectMin       time.Duration
	ReconnectMax       time.Duration
	Metadata           map[string]string
	TemporaryTTL       time.Duration
}

type Client struct {
	config   ClientConfig
	provider provider.Provider
	http     *http.Client
	logger   *slog.Logger
}

func NewClient(config ClientConfig, source provider.Provider, logger *slog.Logger) (*Client, error) {
	if config.ServerURL == "" || config.ConnectionID == "" || config.Token == "" {
		return nil, errors.New("server URL, connection ID and token are required")
	}
	base, err := url.Parse(config.ServerURL)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") {
		return nil, errors.New("server URL must be http or https")
	}
	if config.InventoryInterval <= 0 {
		config.InventoryInterval = 30 * time.Second
	}
	if config.HeartbeatInterval <= 0 {
		config.HeartbeatInterval = 15 * time.Second
	}
	if config.ReconnectMin <= 0 {
		config.ReconnectMin = time.Second
	}
	if config.ReconnectMax <= 0 {
		config.ReconnectMax = 30 * time.Second
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          20,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	if base.Scheme == "https" {
		tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: config.InsecureSkipVerify} //nolint:gosec // Explicit opt-in for development environments.
		if config.CAFile != "" {
			pem, err := os.ReadFile(config.CAFile)
			if err != nil {
				return nil, fmt.Errorf("read agent CA file: %w", err)
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(pem) {
				return nil, errors.New("agent CA file does not contain a valid certificate")
			}
			tlsConfig.RootCAs = pool
		}
		transport.TLSClientConfig = tlsConfig
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Client{config: config, provider: source, http: &http.Client{Transport: transport}, logger: logger}, nil
}

func (c *Client) Run(ctx context.Context) error {
	if c.config.TemporaryTTL > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.config.TemporaryTTL)
		defer cancel()
	}
	backoff := c.config.ReconnectMin
	for {
		if err := c.runSession(ctx); err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			c.logger.Warn("agent session ended", "error", err, "retry_in", backoff)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > c.config.ReconnectMax {
			backoff = c.config.ReconnectMax
		}
	}
}

func (c *Client) runSession(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	outgoing := make(chan Message, 2048)
	errCh := make(chan error, 4)
	streamCancels := map[string]context.CancelFunc{}
	var streamsMu sync.Mutex

	go func() { errCh <- c.postEvents(ctx, outgoing) }()
	go func() {
		errCh <- c.readCommands(ctx, func(command Command) {
			switch command.Type {
			case "open_stream":
				streamsMu.Lock()
				if existing := streamCancels[command.StreamID]; existing != nil {
					existing()
				}
				streamCtx, streamCancel := context.WithCancel(ctx)
				streamCancels[command.StreamID] = streamCancel
				streamsMu.Unlock()
				go c.runStream(streamCtx, command, outgoing, func() {
					streamCancel()
					streamsMu.Lock()
					delete(streamCancels, command.StreamID)
					streamsMu.Unlock()
				})
			case "open_metrics":
				streamsMu.Lock()
				if existing := streamCancels[command.StreamID]; existing != nil {
					existing()
				}
				streamCtx, streamCancel := context.WithCancel(ctx)
				streamCancels[command.StreamID] = streamCancel
				streamsMu.Unlock()
				go c.runMetricStream(streamCtx, command, outgoing, func() {
					streamCancel()
					streamsMu.Lock()
					delete(streamCancels, command.StreamID)
					streamsMu.Unlock()
				})
			case "close_stream":
				streamsMu.Lock()
				if streamCancel := streamCancels[command.StreamID]; streamCancel != nil {
					streamCancel()
					delete(streamCancels, command.StreamID)
				}
				streamsMu.Unlock()
			case "refresh_inventory":
				c.sendInventory(ctx, outgoing)
			}
		})
	}()

	hello := Message{
		ProtocolVersion: ProtocolVersion,
		Type:            "hello",
		ConnectionID:    c.config.ConnectionID,
		AgentVersion:    Version,
		AgentKind:       c.config.Kind,
		Metadata:        c.metadata(),
		Timestamp:       time.Now().UTC(),
	}
	if !sendMessage(ctx, outgoing, hello) {
		return ctx.Err()
	}
	c.sendInventory(ctx, outgoing)

	heartbeat := time.NewTicker(c.config.HeartbeatInterval)
	inventory := time.NewTicker(c.config.InventoryInterval)
	defer heartbeat.Stop()
	defer inventory.Stop()
	for {
		select {
		case <-ctx.Done():
			streamsMu.Lock()
			for _, streamCancel := range streamCancels {
				streamCancel()
			}
			streamsMu.Unlock()
			return ctx.Err()
		case err := <-errCh:
			cancel()
			if err == nil {
				return errors.New("agent transport closed")
			}
			return err
		case <-heartbeat.C:
			sendMessage(ctx, outgoing, Message{Type: "heartbeat", ConnectionID: c.config.ConnectionID, AgentVersion: Version, AgentKind: c.config.Kind, Metadata: c.metadata(), Timestamp: time.Now().UTC()})
		case <-inventory.C:
			c.sendInventory(ctx, outgoing)
		}
	}
}

func (c *Client) metadata() map[string]string {
	metadata := map[string]string{
		"go":   runtime.Version(),
		"os":   runtime.GOOS,
		"arch": runtime.GOARCH,
	}
	hostname, _ := os.Hostname()
	if hostname != "" {
		metadata["hostname"] = hostname
	}
	maps.Copy(metadata, c.config.Metadata)
	return metadata
}

func (c *Client) sendInventory(ctx context.Context, outgoing chan<- Message) {
	workloads, err := c.provider.ListWorkloads(ctx)
	if err != nil {
		c.logger.Warn("inventory refresh failed", "error", err)
		return
	}
	namespaces, err := c.provider.Namespaces(ctx)
	if err != nil {
		namespaces = provider.UniqueNamespaces(workloads)
	}
	inventory := &model.Inventory{Workloads: workloads, Namespaces: namespaces, ObservedAt: time.Now().UTC()}
	metricsCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	metrics, metricsErr := c.provider.ListMetrics(metricsCtx)
	cancel()
	if metricsErr != nil {
		inventory.MetricsError = metricsErr.Error()
	} else {
		inventory.Metrics = metrics
	}
	sendMessage(ctx, outgoing, Message{Type: "inventory", ConnectionID: c.config.ConnectionID, AgentVersion: Version, AgentKind: c.config.Kind, Inventory: inventory, Timestamp: time.Now().UTC()})
}

func (c *Client) runStream(ctx context.Context, command Command, outgoing chan<- Message, done func()) {
	defer done()
	records := make(chan model.ActivityRecord, 512)
	errCh := make(chan error, 1)
	go func() {
		errCh <- c.provider.Stream(ctx, command.Request, records)
		close(records)
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case record, ok := <-records:
			if !ok {
				err := <-errCh
				if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					sendMessage(ctx, outgoing, Message{Type: "stream_error", StreamID: command.StreamID, Error: err.Error(), Timestamp: time.Now().UTC()})
				} else {
					sendMessage(ctx, outgoing, Message{Type: "stream_end", StreamID: command.StreamID, Timestamp: time.Now().UTC()})
				}
				return
			}
			recordCopy := record
			if !sendMessage(ctx, outgoing, Message{Type: "record", StreamID: command.StreamID, Record: &recordCopy, Timestamp: time.Now().UTC()}) {
				return
			}
		}
	}
}

func (c *Client) runMetricStream(ctx context.Context, command Command, outgoing chan<- Message, done func()) {
	defer done()
	samples := make(chan model.WorkloadMetric, 64)
	errCh := make(chan error, 1)
	go func() {
		errCh <- c.provider.StreamMetrics(ctx, command.MetricRequest, samples)
		close(samples)
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case sample, ok := <-samples:
			if !ok {
				err := <-errCh
				if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					sendMessage(ctx, outgoing, Message{Type: "metrics_error", StreamID: command.StreamID, Error: err.Error(), Timestamp: time.Now().UTC()})
				} else {
					sendMessage(ctx, outgoing, Message{Type: "metrics_end", StreamID: command.StreamID, Timestamp: time.Now().UTC()})
				}
				return
			}
			sampleCopy := sample
			if !sendMessage(ctx, outgoing, Message{Type: "metric", StreamID: command.StreamID, Metric: &sampleCopy, Timestamp: time.Now().UTC()}) {
				return
			}
		}
	}
}

func (c *Client) postEvents(ctx context.Context, outgoing <-chan Message) error {
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	reader, writer := io.Pipe()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, c.endpoint("/api/v1/agent/events"), reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.config.Token)
	req.Header.Set("Content-Type", "application/x-ndjson")
	req.Header.Set("X-Runwake-Connection", c.config.ConnectionID)
	encoder := json.NewEncoder(writer)
	writeErr := make(chan error, 1)
	go func() {
		defer func() { _ = writer.Close() }()
		for {
			select {
			case <-requestCtx.Done():
				writeErr <- requestCtx.Err()
				return
			case message, ok := <-outgoing:
				if !ok {
					writeErr <- nil
					return
				}
				if encodeErr := encoder.Encode(message); encodeErr != nil {
					writeErr <- encodeErr
					return
				}
			}
		}
	}()
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024))
		return fmt.Errorf("agent event endpoint returned %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	responseDone := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(io.Discard, resp.Body)
		responseDone <- copyErr
	}()
	select {
	case <-requestCtx.Done():
		_ = reader.CloseWithError(requestCtx.Err())
		return requestCtx.Err()
	case err := <-writeErr:
		return err
	case err := <-responseDone:
		if err != nil {
			return err
		}
		return errors.New("agent event response closed")
	}
}

func (c *Client) readCommands(ctx context.Context, handle func(Command)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("/api/v1/agent/commands"), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.config.Token)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("X-Runwake-Connection", c.config.ConnectionID)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024))
		return fmt.Errorf("agent command endpoint returned %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	var data strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if data.Len() > 0 {
				var command Command
				if err := json.Unmarshal([]byte(data.String()), &command); err == nil {
					handle(command)
				}
				data.Reset()
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return errors.New("agent command stream closed")
}

func (c *Client) endpoint(apiPath string) string {
	base, _ := url.Parse(c.config.ServerURL)
	base.Path = strings.TrimRight(base.Path, "/") + apiPath
	base.RawQuery = ""
	base.Fragment = ""
	return base.String()
}

func sendMessage(ctx context.Context, channel chan<- Message, message Message) bool {
	select {
	case channel <- message:
		return true
	case <-ctx.Done():
		return false
	}
}
