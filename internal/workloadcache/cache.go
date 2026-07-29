package workloadcache

import (
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
)

// Cache stores workload inventory by connection. Implementations may keep the
// inventory in memory or persist it in another store without changing the
// server or API layers.
type Cache interface {
	Get(connectionID string) (Snapshot, bool)
	Put(connectionID string, workloads []model.Workload, observedAt time.Time)
	Delete(connectionID string)
}

type Snapshot struct {
	ConnectionID string
	Workloads    []model.Workload
	ObservedAt   time.Time
}

type Memory struct {
	mu      sync.RWMutex
	entries map[string]Snapshot
}

func NewMemory() *Memory {
	return &Memory{entries: make(map[string]Snapshot)}
}

func (m *Memory) Get(connectionID string) (Snapshot, bool) {
	m.mu.RLock()
	snapshot, ok := m.entries[connectionID]
	m.mu.RUnlock()
	if !ok {
		return Snapshot{}, false
	}
	snapshot.Workloads = cloneWorkloads(snapshot.Workloads)
	return snapshot, true
}

func (m *Memory) Put(connectionID string, workloads []model.Workload, observedAt time.Time) {
	if observedAt.IsZero() {
		observedAt = time.Now().UTC()
	}
	m.mu.Lock()
	m.entries[connectionID] = Snapshot{
		ConnectionID: connectionID,
		Workloads:    cloneWorkloads(workloads),
		ObservedAt:   observedAt.UTC(),
	}
	m.mu.Unlock()
}

func (m *Memory) Delete(connectionID string) {
	m.mu.Lock()
	delete(m.entries, connectionID)
	m.mu.Unlock()
}

func cloneWorkloads(workloads []model.Workload) []model.Workload {
	out := make([]model.Workload, len(workloads))
	for index, workload := range workloads {
		out[index] = workload
		out[index].Images = slices.Clone(workload.Images)
		out[index].Containers = slices.Clone(workload.Containers)
		out[index].Labels = maps.Clone(workload.Labels)
		if workload.Docker == nil {
			continue
		}
		docker := *workload.Docker
		docker.DependsOn = slices.Clone(workload.Docker.DependsOn)
		docker.Mounts = slices.Clone(workload.Docker.Mounts)
		docker.Ports = slices.Clone(workload.Docker.Ports)
		docker.Networks = slices.Clone(workload.Docker.Networks)
		for networkIndex := range docker.Networks {
			docker.Networks[networkIndex].Aliases = slices.Clone(docker.Networks[networkIndex].Aliases)
		}
		out[index].Docker = &docker
	}
	return out
}
