package kube

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/model"
)

type podMetricsList struct {
	Items []podMetric `json:"items"`
}

type podMetric struct {
	Metadata   objectMeta `json:"metadata"`
	Timestamp  time.Time  `json:"timestamp"`
	Window     string     `json:"window"`
	Containers []struct {
		Name  string            `json:"name"`
		Usage map[string]string `json:"usage"`
	} `json:"containers"`
}

func aggregateAllMetrics(connectionID, connectionName string, workloads []model.Workload, pods []podObject, metrics []podMetric) []model.WorkloadMetric {
	podIndex := make(map[string]podObject, len(pods))
	for _, pod := range pods {
		podIndex[pod.Metadata.Namespace+"/"+pod.Metadata.Name] = pod
	}
	byNamespace := map[string][]model.Workload{}
	for _, workload := range workloads {
		byNamespace[workload.Namespace] = append(byNamespace[workload.Namespace], workload)
	}
	aggregates := map[string]*model.WorkloadMetric{}
	for _, item := range metrics {
		pod, ok := podIndex[item.Metadata.Namespace+"/"+item.Metadata.Name]
		if !ok {
			continue
		}
		workload, ok := metricWorkloadForPod(pod, byNamespace[pod.Metadata.Namespace])
		if !ok {
			continue
		}
		key := workload.Key()
		target := aggregates[key]
		if target == nil {
			target = &model.WorkloadMetric{
				Timestamp: item.Timestamp, ConnectionID: connectionID, Connection: connectionName,
				Platform: model.ConnectionKubernetes, Kind: workload.Kind, Namespace: workload.Namespace,
				Name: workload.Name, Source: "kubernetes-metrics-api",
			}
			aggregates[key] = target
		}
		mergePodMetric(target, pod, item)
	}
	out := make([]model.WorkloadMetric, 0, len(aggregates))
	for _, metric := range aggregates {
		out = append(out, *metric)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func aggregateSelectedMetrics(connectionID, connectionName string, request model.MetricRequest, pods []podObject, metrics []podMetric) (model.WorkloadMetric, error) {
	if len(metrics) == 0 {
		return model.WorkloadMetric{}, errors.New("kubernetes Metrics API returned no samples for the selected workload")
	}
	podIndex := make(map[string]podObject, len(pods))
	for _, pod := range pods {
		podIndex[pod.Metadata.Namespace+"/"+pod.Metadata.Name] = pod
	}
	result := model.WorkloadMetric{
		ConnectionID: connectionID, Connection: connectionName, Platform: model.ConnectionKubernetes,
		Kind: request.Kind, Namespace: request.Namespace, Name: request.Name, Source: "kubernetes-metrics-api",
	}
	for _, item := range metrics {
		pod, ok := podIndex[item.Metadata.Namespace+"/"+item.Metadata.Name]
		if !ok {
			continue
		}
		mergePodMetric(&result, pod, item)
	}
	if result.Timestamp.IsZero() {
		return model.WorkloadMetric{}, errors.New("kubernetes Metrics API samples did not match the selected Pods")
	}
	return result, nil
}

func mergePodMetric(target *model.WorkloadMetric, pod podObject, item podMetric) {
	if item.Timestamp.After(target.Timestamp) || target.Timestamp.IsZero() {
		target.Timestamp = item.Timestamp
	}
	limits := podContainerMemoryLimits(pod)
	for _, container := range item.Containers {
		cpu, _ := parseCPUQuantity(container.Usage["cpu"])
		memory, _ := parseByteQuantity(container.Usage["memory"])
		metric := model.ContainerMetric{
			Pod: pod.Metadata.Name, Container: container.Name, CPUCores: cpu,
			MemoryBytes: memory, MemoryLimitBytes: limits[container.Name],
		}
		target.CPUCores += cpu
		target.MemoryBytes += memory
		target.MemoryLimitBytes += metric.MemoryLimitBytes
		target.Containers = append(target.Containers, metric)
	}
}

func podContainerMemoryLimits(pod podObject) map[string]int64 {
	out := map[string]int64{}
	all := make([]containerSpec, 0, len(pod.Spec.InitContainers)+len(pod.Spec.Containers)+len(pod.Spec.EphemeralContainers))
	all = append(all, pod.Spec.InitContainers...)
	all = append(all, pod.Spec.Containers...)
	all = append(all, pod.Spec.EphemeralContainers...)
	for _, container := range all {
		if raw := container.Resources.Limits["memory"]; raw != "" {
			if value, err := parseByteQuantity(raw); err == nil {
				out[container.Name] = value
			}
		}
	}
	return out
}

func metricWorkloadForPod(pod podObject, candidates []model.Workload) (model.Workload, bool) {
	var best model.Workload
	bestScore := -1
	for _, workload := range candidates {
		if strings.EqualFold(workload.Kind, "Pod") {
			if workload.Name == pod.Metadata.Name {
				return workload, true
			}
			continue
		}
		if workload.Selector == "" || !selectorMatches(workload.Selector, pod.Metadata.Labels) {
			continue
		}
		score := selectorSpecificity(workload.Selector)
		if score > bestScore {
			best, bestScore = workload, score
		}
	}
	return best, bestScore >= 0
}

func selectorSpecificity(selector string) int { return len(splitSelectorTerms(selector)) }

func selectorMatches(selector string, labels map[string]string) bool {
	for _, term := range splitSelectorTerms(selector) {
		term = strings.TrimSpace(term)
		if term == "" {
			continue
		}
		if strings.HasPrefix(term, "!") {
			if _, exists := labels[strings.TrimSpace(term[1:])]; exists {
				return false
			}
			continue
		}
		if before, after, ok := strings.Cut(term, " notin "); ok {
			key := strings.TrimSpace(before)
			values := selectorValues(after)
			if value, exists := labels[key]; exists && values[value] {
				return false
			}
			continue
		}
		if before, after, ok := strings.Cut(term, " in "); ok {
			key := strings.TrimSpace(before)
			values := selectorValues(after)
			value, exists := labels[key]
			if !exists || !values[value] {
				return false
			}
			continue
		}
		if before, after, ok := strings.Cut(term, "!="); ok {
			key, expected := strings.TrimSpace(before), strings.TrimSpace(after)
			if value, exists := labels[key]; exists && value == expected {
				return false
			}
			continue
		}
		if before, after, ok := strings.Cut(term, "=="); ok {
			key, expected := strings.TrimSpace(before), strings.TrimSpace(after)
			if labels[key] != expected {
				return false
			}
			continue
		}
		if before, after, ok := strings.Cut(term, "="); ok {
			key, expected := strings.TrimSpace(before), strings.TrimSpace(after)
			if labels[key] != expected {
				return false
			}
			continue
		}
		if _, exists := labels[term]; !exists {
			return false
		}
	}
	return true
}

func splitSelectorTerms(selector string) []string {
	var out []string
	start, depth := 0, 0
	for index, r := range selector {
		switch r {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				out = append(out, selector[start:index])
				start = index + 1
			}
		}
	}
	out = append(out, selector[start:])
	return out
}

func selectorValues(raw string) map[string]bool {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "(")
	raw = strings.TrimSuffix(raw, ")")
	out := map[string]bool{}
	for _, value := range strings.Split(raw, ",") {
		if value = strings.TrimSpace(value); value != "" {
			out[value] = true
		}
	}
	return out
}

func parseCPUQuantity(value string) (float64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, errors.New("empty CPU quantity")
	}
	factors := []struct {
		suffix string
		factor float64
	}{{"n", 1e-9}, {"u", 1e-6}, {"µ", 1e-6}, {"m", 1e-3}}
	for _, item := range factors {
		if before, ok := strings.CutSuffix(value, item.suffix); ok {
			number, err := strconv.ParseFloat(before, 64)
			return number * item.factor, err
		}
	}
	return strconv.ParseFloat(value, 64)
}

func parseByteQuantity(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, errors.New("empty byte quantity")
	}
	binary := map[string]float64{"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "Ti": 1 << 40, "Pi": 1 << 50, "Ei": 1 << 60}
	decimal := map[string]float64{"k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18, "m": 1e-3}
	for suffix, factor := range binary {
		if before, ok := strings.CutSuffix(value, suffix); ok {
			number, err := strconv.ParseFloat(before, 64)
			if err != nil {
				return 0, err
			}
			return saturatingInt64(number * factor), nil
		}
	}
	for suffix, factor := range decimal {
		if before, ok := strings.CutSuffix(value, suffix); ok {
			number, err := strconv.ParseFloat(before, 64)
			if err != nil {
				return 0, err
			}
			return saturatingInt64(number * factor), nil
		}
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("parse quantity %q: %w", value, err)
	}
	return saturatingInt64(number), nil
}

func saturatingInt64(value float64) int64 {
	if value >= math.MaxInt64 {
		return math.MaxInt64
	}
	if value <= math.MinInt64 {
		return math.MinInt64
	}
	return int64(value)
}
