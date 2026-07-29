package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
)

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	filters := connectionFilterSet(r)
	connections := s.availableConnections()
	type result struct {
		items []model.WorkloadMetric
		id    string
		err   error
	}
	results := make(chan result, len(connections))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, connection := range connections {
		if len(filters) > 0 && !filters[connection.ID] {
			continue
		}

		wg.Add(1)
		go func(ctx context.Context, connection model.Connection) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			interval := time.Duration(s.state.Settings().OverviewMetricsIntervalSeconds) * time.Second
			items, err := s.metrics.Snapshot(ctx, connection, interval)
			results <- result{id: connection.ID, items: items, err: err}
		}(ctx, connection)
	}
	wg.Wait()
	close(results)
	items := []model.WorkloadMetric{}
	failures := map[string]string{}
	for value := range results {
		if value.err != nil {
			failures[value.id] = value.err.Error()
		} else {
			items = append(items, value.items...)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Connection == items[j].Connection {
			if items[i].Namespace == items[j].Namespace {
				return items[i].Name < items[j].Name
			}
			return items[i].Namespace < items[j].Namespace
		}
		return items[i].Connection < items[j].Connection
	})
	writeJSON(w, http.StatusOK, map[string]any{"metrics": items, "errors": failures, "observed_at": time.Now().UTC()})
}

func (s *Server) handleMetricsStream(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	request := model.MetricRequest{
		ConnectionID: q.Get("connection_id"), Kind: q.Get("kind"), Namespace: q.Get("namespace"), Name: q.Get("name"),
	}
	if value := q.Get("interval_seconds"); value != "" {
		request.IntervalSeconds, _ = strconv.Atoi(value)
	}
	if request.ConnectionID == "" || request.Kind == "" || request.Name == "" {
		writeError(w, http.StatusBadRequest, "connection_id, kind, and name are required")
		return
	}
	connection, ok := s.state.GetConnection(request.ConnectionID)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	if request.IntervalSeconds <= 0 {
		request.IntervalSeconds = s.state.Settings().SelectedMetricsIntervalSeconds
	}
	if request.IntervalSeconds < 1 {
		request.IntervalSeconds = 1
	}
	samples, unsubscribe, err := s.metrics.Subscribe(r.Context(), connection, request)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case sample, ok := <-samples:
			if !ok {
				return
			}
			data, _ := json.Marshal(sample)
			_, _ = fmt.Fprintf(w, "id: %d\nevent: metric\ndata: %s\n\n", sample.Sequence, data)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}
