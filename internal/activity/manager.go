package activity

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
)

type Manager struct {
	mu       sync.Mutex
	factory  provider.Factory
	streams  map[string]*liveStream
	sequence atomic.Uint64
	linger   time.Duration
	ringSize int
}

type liveStream struct {
	key         string
	request     model.StreamRequest
	provider    provider.Provider
	ctx         context.Context
	cancel      context.CancelFunc
	subscribers map[uint64]*subscriber
	nextSubID   uint64
	ring        []model.ActivityRecord
	closed      bool
	closeTimer  *time.Timer
}

type subscriber struct {
	channel chan model.ActivityRecord
	dropped int
}

func NewManager(factory provider.Factory) *Manager {
	return &Manager{factory: factory, streams: map[string]*liveStream{}, linger: 10 * time.Second, ringSize: 500}
}

func (m *Manager) Subscribe(ctx context.Context, connection model.Connection, request model.StreamRequest) (<-chan model.ActivityRecord, func(), error) {
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
	capacity := 256
	if needed := len(stream.ring) + 64; needed > capacity {
		capacity = needed
	}
	sub := &subscriber{channel: make(chan model.ActivityRecord, capacity)}
	// Queue replay while holding the manager lock. This preserves ordering with
	// live broadcasts and avoids a replay goroutine sending after unsubscribe
	// closes the subscriber channel.
	for _, record := range stream.ring {
		sub.channel <- record
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
	records := make(chan model.ActivityRecord, 512)
	errCh := make(chan error, 1)
	go func() {
		errCh <- stream.provider.Stream(stream.ctx, stream.request, records)
		close(records)
	}()
	for record := range records {
		if !recordMatchesStreamScope(stream.request, record) {
			continue
		}
		enrichActivityRecord(&record)
		record.Sequence = m.sequence.Add(1)
		if record.Timestamp.IsZero() {
			record.Timestamp = time.Now().UTC()
		}
		m.broadcast(stream, record)
	}
	err := <-errCh
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		m.broadcast(stream, model.ActivityRecord{
			Sequence:  m.sequence.Add(1),
			Timestamp: time.Now().UTC(),
			Type:      "error",
			Level:     "error",
			Source:    "runwake",
			Message:   err.Error(),
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

func recordMatchesStreamScope(request model.StreamRequest, record model.ActivityRecord) bool {
	if request.Pod != "" && record.Pod != "" && record.Pod != request.Pod {
		return false
	}
	if request.Container != "" && record.Container != "" && record.Container != request.Container {
		return false
	}
	return true
}

func (m *Manager) broadcast(stream *liveStream, record model.ActivityRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if stream.closed {
		return
	}
	stream.ring = append(stream.ring, record)
	if len(stream.ring) > m.ringSize {
		stream.ring = append([]model.ActivityRecord(nil), stream.ring[len(stream.ring)-m.ringSize:]...)
	}
	for _, sub := range stream.subscribers {
		if sub.dropped > 0 {
			dropped := model.ActivityRecord{
				Sequence:  m.sequence.Add(1),
				Timestamp: time.Now().UTC(),
				Type:      "system",
				Level:     "warning",
				Source:    "runwake",
				Message:   "Records were dropped for this viewer because it could not keep up",
				Fields:    map[string]any{"dropped": sub.dropped},
			}
			select {
			case sub.channel <- dropped:
				sub.dropped = 0
			default:
			}
		}
		select {
		case sub.channel <- record:
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
