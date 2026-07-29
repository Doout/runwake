package kube

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/model"
)

type listEnvelope struct {
	Items []json.RawMessage `json:"items"`
}

type objectMeta struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace"`
	UID               string            `json:"uid"`
	Labels            map[string]string `json:"labels"`
	CreationTimestamp time.Time         `json:"creationTimestamp"`
	OwnerReferences   []ownerReference  `json:"ownerReferences"`
}

type ownerReference struct {
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	UID        string `json:"uid"`
	Controller bool   `json:"controller"`
}

type labelSelector struct {
	MatchLabels      map[string]string `json:"matchLabels"`
	MatchExpressions []struct {
		Key      string   `json:"key"`
		Operator string   `json:"operator"`
		Values   []string `json:"values"`
	} `json:"matchExpressions"`
}

type workloadObject struct {
	Kind       string     `json:"kind"`
	APIVersion string     `json:"apiVersion"`
	Metadata   objectMeta `json:"metadata"`
	Spec       struct {
		Replicas    *int          `json:"replicas"`
		Completions *int          `json:"completions"`
		Selector    labelSelector `json:"selector"`
		Template    struct {
			Spec podSpec `json:"spec"`
		} `json:"template"`
	} `json:"spec"`
	Status map[string]json.RawMessage `json:"status"`
}

type podObject struct {
	Kind     string     `json:"kind"`
	Metadata objectMeta `json:"metadata"`
	Spec     podSpec    `json:"spec"`
	Status   podStatus  `json:"status"`
}

type podSpec struct {
	Containers          []containerSpec `json:"containers"`
	InitContainers      []containerSpec `json:"initContainers"`
	EphemeralContainers []containerSpec `json:"ephemeralContainers"`
}

type containerSpec struct {
	Name      string `json:"name"`
	Image     string `json:"image"`
	Resources struct {
		Limits map[string]string `json:"limits"`
	} `json:"resources"`
}

type podStatus struct {
	Phase                      string            `json:"phase"`
	Reason                     string            `json:"reason"`
	Message                    string            `json:"message"`
	Conditions                 []podCondition    `json:"conditions"`
	ContainerStatuses          []containerStatus `json:"containerStatuses"`
	InitContainerStatuses      []containerStatus `json:"initContainerStatuses"`
	EphemeralContainerStatuses []containerStatus `json:"ephemeralContainerStatuses"`
	StartTime                  time.Time         `json:"startTime"`
}

type podCondition struct {
	Type               string    `json:"type"`
	Status             string    `json:"status"`
	Reason             string    `json:"reason"`
	Message            string    `json:"message"`
	LastTransitionTime time.Time `json:"lastTransitionTime"`
}

type containerStatus struct {
	Name         string         `json:"name"`
	Ready        bool           `json:"ready"`
	RestartCount int            `json:"restartCount"`
	Image        string         `json:"image"`
	ContainerID  string         `json:"containerID"`
	State        containerState `json:"state"`
	LastState    containerState `json:"lastState"`
}

type containerState struct {
	Running *struct {
		StartedAt time.Time `json:"startedAt"`
	} `json:"running"`
	Waiting *struct {
		Reason  string `json:"reason"`
		Message string `json:"message"`
	} `json:"waiting"`
	Terminated *struct {
		ExitCode    int       `json:"exitCode"`
		Signal      int       `json:"signal"`
		Reason      string    `json:"reason"`
		Message     string    `json:"message"`
		StartedAt   time.Time `json:"startedAt"`
		FinishedAt  time.Time `json:"finishedAt"`
		ContainerID string    `json:"containerID"`
	} `json:"terminated"`
}

type eventList struct {
	Items []eventObject `json:"items"`
}

type eventObject struct {
	Metadata objectMeta `json:"metadata"`
	Type     string     `json:"type"`
	Reason   string     `json:"reason"`
	Message  string     `json:"message"`
	Count    int        `json:"count"`
	Source   struct {
		Component string `json:"component"`
		Host      string `json:"host"`
	} `json:"source"`
	InvolvedObject struct {
		Kind      string `json:"kind"`
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		UID       string `json:"uid"`
	} `json:"involvedObject"`
	EventTime      time.Time `json:"eventTime"`
	FirstTimestamp time.Time `json:"firstTimestamp"`
	LastTimestamp  time.Time `json:"lastTimestamp"`
	Series         *struct {
		Count            int       `json:"count"`
		LastObservedTime time.Time `json:"lastObservedTime"`
	} `json:"series"`
}

type watchEnvelope struct {
	Type   string          `json:"type"`
	Object json.RawMessage `json:"object"`
}

func podIdentity(pod podObject) string {
	if pod.Metadata.UID != "" {
		return pod.Metadata.UID
	}
	return pod.Metadata.Namespace + "/" + pod.Metadata.Name
}

func filterActivityPods(pods []podObject, name string) []podObject {
	if name == "" {
		return pods
	}
	filtered := make([]podObject, 0, 1)
	for _, pod := range pods {
		if pod.Metadata.Name == name {
			filtered = append(filtered, pod)
			break
		}
	}
	return filtered
}

func activityContainerSelected(selected, candidate string) bool {
	return selected == "" || selected == candidate
}

func podContainerStatuses(pod podObject) []containerStatus {
	out := make([]containerStatus, 0, len(pod.Status.InitContainerStatuses)+len(pod.Status.ContainerStatuses)+len(pod.Status.EphemeralContainerStatuses))
	out = append(out, pod.Status.InitContainerStatuses...)
	out = append(out, pod.Status.ContainerStatuses...)
	out = append(out, pod.Status.EphemeralContainerStatuses...)
	return out
}

func podRuntimeFingerprint(pod podObject) string {
	statuses := podContainerStatuses(pod)
	parts := make([]string, 0, len(statuses))
	for _, status := range statuses {
		parts = append(parts, status.Name+"="+status.ContainerID+":"+strconv.Itoa(status.RestartCount))
	}
	sort.Strings(parts)
	return strings.Join(parts, "|")
}

func parseWorkloadList(data []byte, connectionID, connectionName string, allowed map[string]bool) ([]model.Workload, error) {
	var envelope listEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, err
	}
	out := make([]model.Workload, 0, len(envelope.Items))
	for _, raw := range envelope.Items {
		var header struct {
			Kind     string     `json:"kind"`
			Metadata objectMeta `json:"metadata"`
		}
		if err := json.Unmarshal(raw, &header); err != nil {
			continue
		}
		if len(allowed) > 0 && !allowed[header.Metadata.Namespace] {
			continue
		}
		if strings.EqualFold(header.Kind, "Pod") {
			var pod podObject
			if err := json.Unmarshal(raw, &pod); err != nil {
				continue
			}
			if controlledPod(pod.Metadata.OwnerReferences) {
				continue
			}
			out = append(out, podToWorkload(pod, connectionID, connectionName))
			continue
		}
		var obj workloadObject
		if err := json.Unmarshal(raw, &obj); err != nil {
			continue
		}
		out = append(out, objectToWorkload(obj, connectionID, connectionName))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Kind < out[j].Kind
	})
	return out, nil
}

func controlledPod(refs []ownerReference) bool {
	for _, ref := range refs {
		if !ref.Controller {
			continue
		}
		switch ref.Kind {
		case "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob":
			return true
		}
	}
	return false
}

func objectToWorkload(obj workloadObject, connectionID, connectionName string) model.Workload {
	desired := intValue(obj.Status, "replicas")
	if obj.Spec.Replicas != nil {
		desired = *obj.Spec.Replicas
	}
	ready := intValue(obj.Status, "readyReplicas")
	available := intValue(obj.Status, "availableReplicas")
	updated := intValue(obj.Status, "updatedReplicas")
	failed := intValue(obj.Status, "failed")
	succeeded := intValue(obj.Status, "succeeded")
	active := intValue(obj.Status, "active")

	state, severity := "Unknown", "muted"
	switch obj.Kind {
	case "Deployment":
		if desired == 0 {
			state, severity = "Scaled to 0", "muted"
		} else if available >= desired && ready >= desired && updated >= desired {
			state, severity = fmt.Sprintf("%d/%d ready", ready, desired), "normal"
		} else {
			state, severity = fmt.Sprintf("%d/%d ready", ready, desired), "warning"
		}
	case "StatefulSet":
		if desired == 0 {
			state, severity = "Scaled to 0", "muted"
		} else if ready >= desired {
			state, severity = fmt.Sprintf("%d/%d ready", ready, desired), "normal"
		} else {
			state, severity = fmt.Sprintf("%d/%d ready", ready, desired), "warning"
		}
	case "DaemonSet":
		desired = intValue(obj.Status, "desiredNumberScheduled")
		ready = intValue(obj.Status, "numberReady")
		if desired > 0 && ready >= desired {
			state, severity = fmt.Sprintf("%d/%d ready", ready, desired), "normal"
		} else {
			state, severity = fmt.Sprintf("%d/%d ready", ready, desired), "warning"
		}
	case "Job":
		desired = 1
		if obj.Spec.Completions != nil {
			desired = *obj.Spec.Completions
		}
		ready = succeeded
		if failed > 0 {
			state, severity = fmt.Sprintf("%d failed", failed), "error"
		} else if active > 0 {
			state, severity = fmt.Sprintf("%d active", active), "normal"
		} else if succeeded > 0 {
			state, severity = fmt.Sprintf("%d succeeded", succeeded), "normal"
		} else {
			state, severity = "Pending", "muted"
		}
	default:
		if ready > 0 || desired > 0 {
			state = fmt.Sprintf("%d/%d ready", ready, desired)
		}
	}

	images, containers := templateContainers(obj.Spec.Template.Spec)
	return model.Workload{
		ConnectionID: connectionID,
		Connection:   connectionName,
		Platform:     model.ConnectionKubernetes,
		Kind:         obj.Kind,
		Namespace:    obj.Metadata.Namespace,
		Name:         obj.Metadata.Name,
		UID:          obj.Metadata.UID,
		State:        state,
		Severity:     severity,
		Ready:        ready,
		Desired:      desired,
		Images:       images,
		Containers:   containers,
		Labels:       obj.Metadata.Labels,
		Selector:     selectorString(obj.Spec.Selector),
		CreatedAt:    obj.Metadata.CreationTimestamp,
	}
}

func podToWorkload(pod podObject, connectionID, connectionName string) model.Workload {
	ready := 0
	restarts := 0
	severity := "normal"
	state := pod.Status.Phase
	for _, c := range pod.Status.Conditions {
		if c.Type == "Ready" && c.Status == "True" {
			ready = 1
		}
	}
	for _, c := range allContainerStatuses(pod.Status) {
		restarts += c.RestartCount
		if c.State.Waiting != nil {
			state = c.State.Waiting.Reason
			severity = "warning"
		}
		if c.State.Terminated != nil && c.State.Terminated.ExitCode != 0 {
			state = c.State.Terminated.Reason
			if state == "" {
				state = "Exited " + strconv.Itoa(c.State.Terminated.ExitCode)
			}
			severity = "error"
		}
	}
	if pod.Status.Phase == "Failed" {
		severity = "error"
	}
	if pod.Status.Phase == "Pending" || ready == 0 {
		severity = "warning"
	}
	images, containers := templateContainers(pod.Spec)
	return model.Workload{
		ConnectionID: connectionID,
		Connection:   connectionName,
		Platform:     model.ConnectionKubernetes,
		Kind:         "Pod",
		Namespace:    pod.Metadata.Namespace,
		Name:         pod.Metadata.Name,
		UID:          pod.Metadata.UID,
		State:        state,
		Severity:     severity,
		Ready:        ready,
		Desired:      1,
		Restarts:     restarts,
		Images:       images,
		Containers:   containers,
		Labels:       pod.Metadata.Labels,
		StartedAt:    pod.Status.StartTime,
	}
}

func templateContainers(spec podSpec) ([]string, []string) {
	all := make([]containerSpec, 0, len(spec.InitContainers)+len(spec.Containers)+len(spec.EphemeralContainers))
	all = append(all, spec.InitContainers...)
	all = append(all, spec.Containers...)
	all = append(all, spec.EphemeralContainers...)
	images := make([]string, 0, len(all))
	containers := make([]string, 0, len(all))
	for _, c := range all {
		images = append(images, c.Image)
		containers = append(containers, c.Name)
	}
	return unique(images), unique(containers)
}

func allContainerStatuses(status podStatus) []containerStatus {
	out := make([]containerStatus, 0, len(status.InitContainerStatuses)+len(status.ContainerStatuses)+len(status.EphemeralContainerStatuses))
	out = append(out, status.InitContainerStatuses...)
	out = append(out, status.ContainerStatuses...)
	out = append(out, status.EphemeralContainerStatuses...)
	return out
}

func intValue(status map[string]json.RawMessage, key string) int {
	raw, ok := status[key]
	if !ok {
		return 0
	}
	var n int
	_ = json.Unmarshal(raw, &n)
	return n
}

func selectorString(sel labelSelector) string {
	parts := make([]string, 0, len(sel.MatchLabels)+len(sel.MatchExpressions))
	keys := make([]string, 0, len(sel.MatchLabels))
	for k := range sel.MatchLabels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, k+"="+sel.MatchLabels[k])
	}
	for _, expr := range sel.MatchExpressions {
		vals := append([]string(nil), expr.Values...)
		sort.Strings(vals)
		switch expr.Operator {
		case "In":
			parts = append(parts, expr.Key+" in ("+strings.Join(vals, ",")+")")
		case "NotIn":
			parts = append(parts, expr.Key+" notin ("+strings.Join(vals, ",")+")")
		case "Exists":
			parts = append(parts, expr.Key)
		case "DoesNotExist":
			parts = append(parts, "!"+expr.Key)
		}
	}
	return strings.Join(parts, ",")
}

func unique(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, item := range in {
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func eventTimestamp(event eventObject) time.Time {
	if !event.EventTime.IsZero() {
		return event.EventTime
	}
	if event.Series != nil && !event.Series.LastObservedTime.IsZero() {
		return event.Series.LastObservedTime
	}
	if !event.LastTimestamp.IsZero() {
		return event.LastTimestamp
	}
	if !event.FirstTimestamp.IsZero() {
		return event.FirstTimestamp
	}
	return event.Metadata.CreationTimestamp
}

func eventRecord(event eventObject) model.ActivityRecord {
	level := "info"
	if strings.EqualFold(event.Type, "Warning") {
		level = "warning"
	}
	fields := map[string]any{
		"reason": event.Reason,
		"count":  event.Count,
		"kind":   event.InvolvedObject.Kind,
		"name":   event.InvolvedObject.Name,
	}
	if event.Source.Component != "" {
		fields["component"] = event.Source.Component
	}
	return model.ActivityRecord{
		Timestamp: eventTimestamp(event),
		Type:      "event",
		Level:     level,
		Message:   event.Message,
		Source:    "kubernetes-event",
		Pod: func() string {
			if event.InvolvedObject.Kind == "Pod" {
				return event.InvolvedObject.Name
			}
			return ""
		}(),
		Fields: fields,
	}
}

func podStateRecords(previous, current podObject) []model.ActivityRecord {
	var out []model.ActivityRecord
	now := time.Now().UTC()
	if previous.Status.Phase != current.Status.Phase {
		out = append(out, model.ActivityRecord{Timestamp: now, Type: "state", Level: "info", Source: "kubernetes-pod", Pod: current.Metadata.Name, Message: "Pod phase changed", Fields: map[string]any{"from": previous.Status.Phase, "to": current.Status.Phase}})
	}
	prev := map[string]containerStatus{}
	for _, status := range allContainerStatuses(previous.Status) {
		prev[status.Name] = status
	}
	for _, status := range allContainerStatuses(current.Status) {
		old := prev[status.Name]
		if status.RestartCount != old.RestartCount {
			fields := map[string]any{"from": old.RestartCount, "to": status.RestartCount}
			if status.LastState.Terminated != nil {
				fields["exit_code"] = status.LastState.Terminated.ExitCode
				fields["reason"] = status.LastState.Terminated.Reason
				fields["finished_at"] = status.LastState.Terminated.FinishedAt
			}
			out = append(out, model.ActivityRecord{Timestamp: now, Type: "state", Level: "warning", Source: "kubernetes-pod", Pod: current.Metadata.Name, Container: status.Name, Message: "Container restart count changed", Fields: fields})
		}
		oldState := containerStateName(old.State)
		newState := containerStateName(status.State)
		if oldState != newState {
			fields := map[string]any{"from": oldState, "to": newState}
			if status.State.Waiting != nil {
				fields["reason"] = status.State.Waiting.Reason
				fields["message"] = status.State.Waiting.Message
			}
			if status.State.Terminated != nil {
				fields["exit_code"] = status.State.Terminated.ExitCode
				fields["reason"] = status.State.Terminated.Reason
			}
			out = append(out, model.ActivityRecord{Timestamp: now, Type: "state", Level: "info", Source: "kubernetes-pod", Pod: current.Metadata.Name, Container: status.Name, Message: "Container state changed", Fields: fields})
		}
	}
	return out
}

func containerStateName(state containerState) string {
	switch {
	case state.Running != nil:
		return "Running"
	case state.Waiting != nil:
		if state.Waiting.Reason != "" {
			return "Waiting: " + state.Waiting.Reason
		}
		return "Waiting"
	case state.Terminated != nil:
		if state.Terminated.Reason != "" {
			return "Terminated: " + state.Terminated.Reason
		}
		return "Terminated"
	default:
		return "Unknown"
	}
}
