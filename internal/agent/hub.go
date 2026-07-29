package agent

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
	"github.com/Doout/runwake/internal/store"
)

type Hub struct {
	mu       sync.RWMutex
	store    *store.Store
	sessions map[string]*session
}

type session struct {
	commands         chan Command
	commandsAttached bool
	connectedAt      time.Time
	lastSeen         time.Time
	version          string
	kind             string
	metadata         map[string]string
	inventory        model.Inventory
	streamSinks      map[string]chan streamResult
	metricSinks      map[string]chan metricResult
	generation       uint64
	lastPersisted    time.Time
}

type streamResult struct {
	record *model.ActivityRecord
	err    error
	end    bool
}

type metricResult struct {
	metric *model.WorkloadMetric
	err    error
	end    bool
}

func NewHub(state *store.Store) *Hub {
	return &Hub{store: state, sessions: map[string]*session{}}
}

func (h *Hub) ensure(id string) *session {
	s := h.sessions[id]
	if s == nil {
		s = &session{commands: make(chan Command, 128), streamSinks: map[string]chan streamResult{}, metricSinks: map[string]chan metricResult{}, metadata: map[string]string{}}
		h.sessions[id] = s
	}
	return s
}

func (h *Hub) Authenticate(connectionID, token string) bool {
	connection, ok := h.store.GetConnection(connectionID)
	if !ok || connection.Mode != model.ModeAgent || connection.Agent == nil {
		return false
	}
	return VerifyToken(token, connection.Agent.TokenHash)
}

func (h *Hub) AttachCommands(connectionID string) (<-chan Command, func()) {
	h.mu.Lock()
	s := h.ensure(connectionID)
	s.generation++
	generation := s.generation
	// Every command attachment gets a fresh queue. If an old SSE request is
	// still unwinding during reconnect, it cannot consume commands intended
	// for the new agent session.
	s.commands = make(chan Command, 128)
	s.commandsAttached = true
	s.connectedAt = time.Now().UTC()
	s.lastSeen = s.connectedAt
	commands := s.commands
	h.mu.Unlock()
	h.persistAgentState(connectionID, true)
	return commands, func() {
		h.mu.Lock()
		current := h.sessions[connectionID]
		if current != nil && current.generation == generation {
			current.commandsAttached = false
			for id, sink := range current.streamSinks {
				sendTerminal(sink, streamResult{err: errors.New("remote agent disconnected"), end: true})
				delete(current.streamSinks, id)
			}
			for id, sink := range current.metricSinks {
				sendMetricTerminal(sink, metricResult{err: errors.New("remote agent disconnected"), end: true})
				delete(current.metricSinks, id)
			}
		}
		h.mu.Unlock()
		h.persistAgentState(connectionID, true)
	}
}

func (h *Hub) HandleMessage(connectionID string, message Message) {
	h.mu.Lock()
	s := h.ensure(connectionID)
	s.lastSeen = time.Now().UTC()
	if message.AgentVersion != "" {
		s.version = message.AgentVersion
	}
	if message.AgentKind != "" {
		s.kind = message.AgentKind
	}
	if message.Metadata != nil {
		s.metadata = cloneStringMap(message.Metadata)
	}
	if message.Inventory != nil {
		s.inventory = *message.Inventory
	}
	var sink chan streamResult
	var metricSink chan metricResult
	if message.StreamID != "" {
		sink = s.streamSinks[message.StreamID]
		metricSink = s.metricSinks[message.StreamID]
	}
	h.mu.Unlock()

	if sink != nil {
		switch message.Type {
		case "record":
			if message.Record != nil {
				select {
				case sink <- streamResult{record: message.Record}:
				default:
					sendTerminal(sink, streamResult{err: errors.New("remote stream consumer is too slow"), end: true})
				}
			}
		case "stream_error":
			sendTerminal(sink, streamResult{err: errors.New(message.Error), end: true})
		case "stream_end":
			sendTerminal(sink, streamResult{end: true})
		}
	}
	if metricSink != nil {
		switch message.Type {
		case "metric":
			if message.Metric != nil {
				select {
				case metricSink <- metricResult{metric: message.Metric}:
				default:
					sendMetricTerminal(metricSink, metricResult{err: errors.New("remote metrics consumer is too slow"), end: true})
				}
			}
		case "metrics_error":
			sendMetricTerminal(metricSink, metricResult{err: errors.New(message.Error), end: true})
		case "metrics_end":
			sendMetricTerminal(metricSink, metricResult{end: true})
		}
	}
	if message.Type == "hello" || message.Type == "heartbeat" || message.Type == "inventory" {
		h.persistAgentState(connectionID, message.Type == "hello")
	}
}

func (h *Hub) persistAgentState(connectionID string, force bool) {
	h.mu.Lock()
	s := h.sessions[connectionID]
	if s == nil {
		h.mu.Unlock()
		return
	}
	now := time.Now().UTC()
	if !force && !s.lastPersisted.IsZero() && now.Sub(s.lastPersisted) < time.Minute {
		h.mu.Unlock()
		return
	}
	s.lastPersisted = now
	lastSeen := s.lastSeen
	version := s.version
	metadata := cloneStringMap(s.metadata)
	h.mu.Unlock()
	connection, ok := h.store.GetConnection(connectionID)
	if !ok || connection.Agent == nil {
		return
	}
	connection.Agent.LastSeen = lastSeen
	connection.Agent.Version = version
	connection.Agent.Metadata = metadata
	_ = h.store.UpdateConnection(connection)
}

func (h *Hub) Inventory(connectionID string) (model.Inventory, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	s := h.sessions[connectionID]
	if s == nil || s.inventory.ObservedAt.IsZero() {
		return model.Inventory{}, false
	}
	inventory := s.inventory
	inventory.Workloads = append([]model.Workload(nil), s.inventory.Workloads...)
	inventory.Namespaces = append([]string(nil), s.inventory.Namespaces...)
	inventory.Metrics = append([]model.WorkloadMetric(nil), s.inventory.Metrics...)
	return inventory, true
}

func (h *Hub) Status(connectionID string) model.ConnectionStatus {
	h.mu.RLock()
	defer h.mu.RUnlock()
	s := h.sessions[connectionID]
	if s == nil {
		return model.ConnectionStatus{State: "disconnected", Message: "Agent has not connected"}
	}
	state := "disconnected"
	message := "Agent is offline"
	online := s.commandsAttached && time.Since(s.lastSeen) < 45*time.Second
	if online {
		state, message = "connected", "Agent connected"
	}
	details := map[string]string{}
	if s.version != "" {
		details["agent_version"] = s.version
	}
	if s.kind != "" {
		details["agent_kind"] = s.kind
	}
	maps.Copy(details, s.metadata)
	return model.ConnectionStatus{State: state, Message: message, LastSeen: s.lastSeen, AgentOnline: online, Details: details}
}

func (h *Hub) sendCommand(connectionID string, command Command) error {
	h.mu.RLock()
	s := h.sessions[connectionID]
	if s == nil || !s.commandsAttached || time.Since(s.lastSeen) >= 45*time.Second {
		h.mu.RUnlock()
		return errors.New("remote agent is not connected")
	}
	commands := s.commands
	h.mu.RUnlock()
	select {
	case commands <- command:
		return nil
	case <-time.After(3 * time.Second):
		return errors.New("remote agent command queue is full")
	}
}

func (h *Hub) OpenStream(ctx context.Context, connectionID string, request model.StreamRequest, out chan<- model.ActivityRecord) error {
	streamID := store.NewID("stream")
	sink := make(chan streamResult, 512)
	h.mu.Lock()
	s := h.ensure(connectionID)
	if !s.commandsAttached || time.Since(s.lastSeen) >= 45*time.Second {
		h.mu.Unlock()
		return errors.New("remote agent is not connected")
	}
	s.streamSinks[streamID] = sink
	h.mu.Unlock()

	command := NewCommand("open_stream")
	command.StreamID = streamID
	command.Request = request
	if err := h.sendCommand(connectionID, command); err != nil {
		h.removeStream(connectionID, streamID)
		return err
	}
	defer func() {
		closeCommand := NewCommand("close_stream")
		closeCommand.StreamID = streamID
		_ = h.sendCommand(connectionID, closeCommand)
		h.removeStream(connectionID, streamID)
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case result, ok := <-sink:
			if !ok {
				return nil
			}
			if result.record != nil {
				select {
				case out <- *result.record:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			if result.end {
				return result.err
			}
		}
	}
}

func (h *Hub) OpenMetricStream(ctx context.Context, connectionID string, request model.MetricRequest, out chan<- model.WorkloadMetric) error {
	streamID := store.NewID("metrics")
	sink := make(chan metricResult, 128)
	h.mu.Lock()
	s := h.ensure(connectionID)
	if !s.commandsAttached || time.Since(s.lastSeen) >= 45*time.Second {
		h.mu.Unlock()
		return errors.New("remote agent is not connected")
	}
	s.metricSinks[streamID] = sink
	h.mu.Unlock()

	command := NewCommand("open_metrics")
	command.StreamID = streamID
	command.MetricRequest = request
	if err := h.sendCommand(connectionID, command); err != nil {
		h.removeMetricStream(connectionID, streamID)
		return err
	}
	defer func() {
		closeCommand := NewCommand("close_stream")
		closeCommand.StreamID = streamID
		_ = h.sendCommand(connectionID, closeCommand)
		h.removeMetricStream(connectionID, streamID)
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case result, ok := <-sink:
			if !ok {
				return nil
			}
			if result.metric != nil {
				select {
				case out <- *result.metric:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			if result.end {
				return result.err
			}
		}
	}
}

// sendTerminal makes room for a terminal result when a consumer queue is
// full. Stream sink channels are deliberately not closed: HandleMessage may
// have captured a sink just before it is removed, and avoiding closes prevents
// send-on-closed-channel races during agent reconnects.
func sendTerminal(sink chan streamResult, result streamResult) {
	select {
	case sink <- result:
		return
	default:
	}
	select {
	case <-sink:
	default:
	}
	select {
	case sink <- result:
	default:
	}
}

func sendMetricTerminal(sink chan metricResult, result metricResult) {
	select {
	case sink <- result:
		return
	default:
	}
	select {
	case <-sink:
	default:
	}
	select {
	case sink <- result:
	default:
	}
}

func (h *Hub) removeMetricStream(connectionID, streamID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.sessions[connectionID]; s != nil {
		delete(s.metricSinks, streamID)
	}
}

func (h *Hub) removeStream(connectionID, streamID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s := h.sessions[connectionID]; s != nil {
		delete(s.streamSinks, streamID)
	}
}

func (h *Hub) RefreshInventory(connectionID string) error {
	command := NewCommand("refresh_inventory")
	return h.sendCommand(connectionID, command)
}

func cloneStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	maps.Copy(out, in)
	return out
}

type RemoteProviderFactory struct{ Hub *Hub }

func (f *RemoteProviderFactory) ProviderForAgent(connection model.Connection) (provider.Provider, error) {
	if connection.Agent == nil {
		return nil, errors.New("missing agent connection configuration")
	}
	return &remoteProvider{connection: connection, hub: f.Hub}, nil
}

type remoteProvider struct {
	connection model.Connection
	hub        *Hub
}

func (p *remoteProvider) Test(context.Context) (model.ProviderInfo, error) {
	status := p.hub.Status(p.connection.ID)
	if status.State != "connected" {
		return model.ProviderInfo{State: status.State, Message: status.Message, Details: status.Details}, errors.New(status.Message)
	}
	return model.ProviderInfo{State: status.State, Message: status.Message, Details: status.Details}, nil
}

func (p *remoteProvider) Namespaces(context.Context) ([]string, error) {
	inventory, ok := p.hub.Inventory(p.connection.ID)
	if !ok {
		return nil, errors.New("agent inventory is not available")
	}
	return inventory.Namespaces, nil
}

func (p *remoteProvider) ListWorkloads(context.Context) ([]model.Workload, error) {
	inventory, ok := p.hub.Inventory(p.connection.ID)
	if !ok {
		return nil, errors.New("agent inventory is not available")
	}
	workloads := append([]model.Workload(nil), inventory.Workloads...)
	for i := range workloads {
		workloads[i].ConnectionID = p.connection.ID
		workloads[i].Connection = p.connection.Name
	}
	return workloads, nil
}

func (p *remoteProvider) StreamWorkloads(ctx context.Context, out chan<- model.Workload) error {
	workloads, err := p.ListWorkloads(ctx)
	if err != nil {
		return err
	}
	for _, workload := range workloads {
		select {
		case out <- workload:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (p *remoteProvider) ListMetrics(context.Context) ([]model.WorkloadMetric, error) {
	inventory, ok := p.hub.Inventory(p.connection.ID)
	if !ok {
		return nil, errors.New("agent inventory is not available")
	}
	if inventory.MetricsError != "" {
		return nil, errors.New(inventory.MetricsError)
	}
	metrics := append([]model.WorkloadMetric(nil), inventory.Metrics...)
	for i := range metrics {
		metrics[i].ConnectionID = p.connection.ID
		metrics[i].Connection = p.connection.Name
	}
	return metrics, nil
}

func (p *remoteProvider) Stream(ctx context.Context, request model.StreamRequest, out chan<- model.ActivityRecord) error {
	return p.hub.OpenStream(ctx, p.connection.ID, request, out)
}

func (p *remoteProvider) StreamMetrics(ctx context.Context, request model.MetricRequest, out chan<- model.WorkloadMetric) error {
	return p.hub.OpenMetricStream(ctx, p.connection.ID, request, out)
}

func (h *Hub) DebugString(connectionID string) string {
	status := h.Status(connectionID)
	return fmt.Sprintf("%s: %s", status.State, status.Message)
}
