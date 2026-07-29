package metrics

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
)

// Manager shares one upstream metrics stream across all viewers of the same
// workload. Samples are held in memory only and are discarded when the stream
// has no viewers.
type Manager struct {
	mu        sync.Mutex
	factory   provider.Factory
	streams   map[string]*liveStream
	sequence  atomic.Uint64
	linger    time.Duration
	ringSize  int
	snapshots map[string]*snapshotEntry
}

type liveStream struct {
	key         string
	request     model.MetricRequest
	provider    provider.Provider
	ctx         context.Context
	cancel      context.CancelFunc
	subscribers map[uint64]*subscriber
	nextSubID   uint64
	ring        []model.WorkloadMetric
	closed      bool
	closeTimer  *time.Timer
}

type subscriber struct {
	channel chan model.WorkloadMetric
	dropped int
}

type snapshotEntry struct {
	observed time.Time
	items    []model.WorkloadMetric
	err      error
	loading  chan struct{}
}

func NewManager(factory provider.Factory) *Manager {
	return &Manager{factory: factory, streams: map[string]*liveStream{}, snapshots: map[string]*snapshotEntry{}, linger: 10 * time.Second, ringSize: 600}
}

func (m *Manager) Snapshot(ctx context.Context, connection model.Connection, maxAge time.Duration) ([]model.WorkloadMetric, error) {
	if maxAge <= 0 {
		maxAge = 30 * time.Second
	}
	for {
		m.mu.Lock()
		entry := m.snapshots[connection.ID]
		if entry != nil && entry.loading == nil && !entry.observed.IsZero() && time.Since(entry.observed) < maxAge {
			items, err := cloneMetrics(entry.items), entry.err
			m.mu.Unlock()
			return items, err
		}
		if entry != nil && entry.loading != nil {
			wait := entry.loading
			m.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-wait:
				continue
			}
		}
		loading := make(chan struct{})
		if entry == nil {
			entry = &snapshotEntry{}
			m.snapshots[connection.ID] = entry
		}
		entry.loading = loading
		m.mu.Unlock()

		provider, err := m.factory.ProviderFor(connection)
		var items []model.WorkloadMetric
		if err == nil {
			// A snapshot can have several waiting HTTP requests. Do not let the
			// first browser disconnect cancel the shared provider read for all of
			// them, but keep a hard upper bound so a broken runtime cannot leave
			// the cache entry loading forever.
			loadCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 45*time.Second)
			items, err = provider.ListMetrics(loadCtx)
			cancel()
		}
		m.mu.Lock()
		entry.items = cloneMetrics(items)
		entry.err = err
		entry.observed = time.Now().UTC()
		entry.loading = nil
		close(loading)
		m.mu.Unlock()
		return cloneMetrics(items), err
	}
}

func (m *Manager) InvalidateSnapshot(connectionID string) {
	m.mu.Lock()
	delete(m.snapshots, connectionID)
	m.mu.Unlock()
}

func cloneMetrics(items []model.WorkloadMetric) []model.WorkloadMetric {
	out := append([]model.WorkloadMetric(nil), items...)
	for index := range out {
		out[index].Containers = append([]model.ContainerMetric(nil), items[index].Containers...)
	}
	return out
}

func (m *Manager) Subscribe(ctx context.Context, connection model.Connection, request model.MetricRequest) (<-chan model.WorkloadMetric, func(), error) {
	p, err := m.factory.ProviderFor(connection)
	if err != nil {
		return nil, nil, err
	}
	key := request.Key()
	m.mu.Lock()
	stream := m.streams[key]
	if stream == nil || stream.closed {
		streamCtx, cancel := context.WithCancel(context.Background())
		stream = &liveStream{
			key:         key,
			request:     request,
			provider:    p,
			ctx:         streamCtx,
			cancel:      cancel,
			subscribers: map[uint64]*subscriber{},
		}
		m.streams[key] = stream
		go m.run(stream)
	}
	if stream.closeTimer != nil {
		stream.closeTimer.Stop()
		stream.closeTimer = nil
	}
	stream.nextSubID++
	subID := stream.nextSubID
	capacity := 128
	if needed := len(stream.ring) + 32; needed > capacity {
		capacity = needed
	}
	sub := &subscriber{channel: make(chan model.WorkloadMetric, capacity)}
	for _, sample := range stream.ring {
		sub.channel <- sample
	}
	stream.subscribers[subID] = sub
	m.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			m.mu.Lock()
			current := m.streams[key]
			if current != nil {
				if existing, ok := current.subscribers[subID]; ok {
					delete(current.subscribers, subID)
					close(existing.channel)
				}
				if len(current.subscribers) == 0 && !current.closed {
					current.closeTimer = time.AfterFunc(m.linger, func() { m.stopIfUnused(key, current) })
				}
			}
			m.mu.Unlock()
		})
	}
	go func() {
		<-ctx.Done()
		unsubscribe()
	}()
	return sub.channel, unsubscribe, nil
}

func (m *Manager) run(stream *liveStream) {
	samples := make(chan model.WorkloadMetric, 64)
	errCh := make(chan error, 1)
	go func() {
		errCh <- stream.provider.StreamMetrics(stream.ctx, stream.request, samples)
		close(samples)
	}()
	for sample := range samples {
		sample.Sequence = m.sequence.Add(1)
		if sample.Timestamp.IsZero() {
			sample.Timestamp = time.Now().UTC()
		}
		m.broadcast(stream, sample)
	}
	err := <-errCh
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		m.broadcast(stream, model.WorkloadMetric{
			Timestamp: time.Now().UTC(), ConnectionID: stream.request.ConnectionID,
			Kind: stream.request.Kind, Namespace: stream.request.Namespace, Name: stream.request.Name,
			Source: "runwake", Error: err.Error(),
		})
	}
	m.mu.Lock()
	stream.closed = true
	delete(m.streams, stream.key)
	for id, sub := range stream.subscribers {
		close(sub.channel)
		delete(stream.subscribers, id)
	}
	m.mu.Unlock()
}

func (m *Manager) broadcast(stream *liveStream, sample model.WorkloadMetric) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if stream.closed {
		return
	}
	stream.ring = append(stream.ring, sample)
	if len(stream.ring) > m.ringSize {
		stream.ring = append([]model.WorkloadMetric(nil), stream.ring[len(stream.ring)-m.ringSize:]...)
	}
	for _, sub := range stream.subscribers {
		select {
		case sub.channel <- sample:
		default:
			sub.dropped++
		}
	}
}

func (m *Manager) stopIfUnused(key string, expected *liveStream) {
	m.mu.Lock()
	defer m.mu.Unlock()
	stream := m.streams[key]
	if stream != expected || stream.closed || len(stream.subscribers) != 0 {
		return
	}
	stream.cancel()
}
