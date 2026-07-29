package metrics

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
)

type testFactory struct{ provider provider.Provider }

func (f testFactory) ProviderFor(model.Connection) (provider.Provider, error) { return f.provider, nil }

type testProvider struct {
	listCalls   atomic.Int32
	streamCalls atomic.Int32
	listGate    chan struct{}
	metrics     []model.WorkloadMetric
}

func (p *testProvider) Test(context.Context) (model.ProviderInfo, error) {
	return model.ProviderInfo{}, nil
}
func (p *testProvider) Namespaces(context.Context) ([]string, error) { return nil, nil }
func (p *testProvider) ListWorkloads(context.Context) ([]model.Workload, error) {
	return nil, nil
}
func (p *testProvider) ListMetrics(ctx context.Context) ([]model.WorkloadMetric, error) {
	p.listCalls.Add(1)
	if p.listGate != nil {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-p.listGate:
		}
	}
	return cloneMetrics(p.metrics), nil
}
func (p *testProvider) Stream(context.Context, model.StreamRequest, chan<- model.ActivityRecord) error {
	return nil
}
func (p *testProvider) StreamMetrics(ctx context.Context, _ model.MetricRequest, out chan<- model.WorkloadMetric) error {
	p.streamCalls.Add(1)
	for _, metric := range p.metrics {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case out <- metric:
		}
	}
	<-ctx.Done()
	return ctx.Err()
}

func TestSnapshotCachesAndCoalescesConcurrentLoads(t *testing.T) {
	gate := make(chan struct{})
	p := &testProvider{
		listGate: gate,
		metrics:  []model.WorkloadMetric{{ConnectionID: "c1", Name: "api", MemoryBytes: 64 << 20}},
	}
	manager := NewManager(testFactory{provider: p})
	connection := model.Connection{ID: "c1"}

	const callers = 8
	var wg sync.WaitGroup
	wg.Add(callers)
	errs := make(chan error, callers)
	for range callers {
		go func() {
			defer wg.Done()
			items, err := manager.Snapshot(context.Background(), connection, time.Minute)
			if err == nil && (len(items) != 1 || items[0].MemoryBytes != 64<<20) {
				t.Errorf("unexpected metrics: %#v", items)
			}
			errs <- err
		}()
	}

	deadline := time.Now().Add(time.Second)
	for p.listCalls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(gate)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := p.listCalls.Load(); got != 1 {
		t.Fatalf("expected one coalesced provider call, got %d", got)
	}

	items, err := manager.Snapshot(context.Background(), connection, time.Minute)
	if err != nil || len(items) != 1 {
		t.Fatalf("cached snapshot failed: items=%#v err=%v", items, err)
	}
	if got := p.listCalls.Load(); got != 1 {
		t.Fatalf("cached snapshot called provider again: %d", got)
	}

	manager.InvalidateSnapshot(connection.ID)
	p.listGate = nil
	if _, err := manager.Snapshot(context.Background(), connection, time.Minute); err != nil {
		t.Fatal(err)
	}
	if got := p.listCalls.Load(); got != 2 {
		t.Fatalf("expected reload after invalidation, got %d calls", got)
	}
}

func TestSubscribeSharesOneUpstreamStream(t *testing.T) {
	p := &testProvider{metrics: []model.WorkloadMetric{{ConnectionID: "c1", Kind: "Deployment", Name: "api", CPUCores: 0.1}}}
	manager := NewManager(testFactory{provider: p})
	manager.linger = time.Millisecond
	request := model.MetricRequest{ConnectionID: "c1", Kind: "Deployment", Name: "api", IntervalSeconds: 2}
	connection := model.Connection{ID: "c1"}

	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()
	first, unsubscribe1, err := manager.Subscribe(ctx1, connection, request)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe1()

	select {
	case sample := <-first:
		if sample.Sequence == 0 || sample.CPUCores != 0.1 {
			t.Fatalf("unexpected sample: %#v", sample)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first sample")
	}

	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	second, unsubscribe2, err := manager.Subscribe(ctx2, connection, request)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe2()
	select {
	case sample := <-second:
		if sample.CPUCores != 0.1 {
			t.Fatalf("unexpected replayed sample: %#v", sample)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for replayed sample")
	}
	if got := p.streamCalls.Load(); got != 1 {
		t.Fatalf("expected one shared upstream stream, got %d", got)
	}
}
