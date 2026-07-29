package kube

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/proxyx"
	"github.com/Doout/runwake/internal/sshx"
	"github.com/Doout/runwake/internal/store"
)

type KubectlProvider struct {
	connection model.Connection
	secrets    *store.SecretStore
	settings   func() model.Settings
}

func NewKubectlProvider(connection model.Connection, secrets *store.SecretStore, settings func() model.Settings) *KubectlProvider {
	return &KubectlProvider{connection: connection, secrets: secrets, settings: settings}
}

type kubectlSession struct {
	binary      string
	kubeconfig  string
	context     string
	cleanup     func()
	policy      string
	allowlist   []string
	environment map[string]string
	ssh         *sshx.Config
}

func (p *KubectlProvider) session(ctx context.Context) (*kubectlSession, error) {
	if p.connection.Kubernetes == nil {
		return nil, errors.New("missing Kubernetes connection configuration")
	}
	cfg := p.connection.Kubernetes
	settings := p.settings()
	binary := cfg.KubectlPath
	if binary == "" {
		binary = settings.KubectlPath
	}
	if binary == "" {
		binary = "kubectl"
	}
	resolved := binary
	var err error
	var sshConfig *sshx.Config
	if p.connection.SSH != nil {
		loaded, loadErr := sshx.Load(p.connection.SSH, p.secrets)
		if loadErr != nil {
			return nil, loadErr
		}
		sshConfig = &loaded
	} else {
		resolved, err = exec.LookPath(binary)
		if err != nil {
			return nil, fmt.Errorf("kubectl was not found (%s): %w", binary, err)
		}
	}
	kubeconfig := strings.TrimSpace(cfg.KubeconfigPath)
	if sshConfig == nil {
		kubeconfig = expandUserPath(kubeconfig)
	}
	cleanup := func() {}
	if cfg.KubeconfigSource == "stored" {
		if sshConfig != nil {
			return nil, errors.New("SSH Kubernetes connections require a kubeconfig path on the remote host")
		}
		kubeconfig, cleanup, err = p.secrets.Materialize(cfg.KubeconfigSecret, ".kubeconfig")
		if err != nil {
			return nil, fmt.Errorf("materialize kubeconfig: %w", err)
		}
	}
	if kubeconfig == "" {
		cleanup()
		return nil, errors.New("kubeconfig path or stored kubeconfig is required")
	}
	if sshConfig != nil {
		kubeconfig = sshx.NormalizeRemotePath(kubeconfig, ".kube/config")
	}
	policy := cfg.ExecPolicy
	if policy == "" {
		policy = settings.ExecPluginPolicy
	}
	allowlist := cfg.ExecAllowlist
	if len(allowlist) == 0 {
		allowlist = settings.ExecPluginAllowlist
	}
	environment := map[string]string{}
	if cfg.EnvironmentSecret != "" {
		if p.secrets == nil {
			cleanup()
			return nil, errors.New("kubernetes environment secret store is not configured")
		}
		data, readErr := p.secrets.Get(cfg.EnvironmentSecret)
		if readErr != nil {
			cleanup()
			return nil, fmt.Errorf("read Kubernetes environment: %w", readErr)
		}
		if unmarshalErr := json.Unmarshal(data, &environment); unmarshalErr != nil {
			cleanup()
			return nil, fmt.Errorf("decode Kubernetes environment: %w", unmarshalErr)
		}
	}
	if p.connection.HTTPProxy != nil {
		proxyConfig, proxyErr := proxyx.Load(p.connection.HTTPProxy, p.secrets)
		if proxyErr != nil {
			cleanup()
			return nil, proxyErr
		}
		maps.Copy(environment, proxyConfig.Environment())
	}
	s := &kubectlSession{binary: resolved, kubeconfig: kubeconfig, context: cfg.Context, cleanup: cleanup, policy: policy, allowlist: allowlist, environment: environment, ssh: sshConfig}
	if err := s.validateExecPolicy(ctx); err != nil {
		cleanup()
		return nil, err
	}
	return s, nil
}

func expandUserPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "~" || strings.HasPrefix(value, "~/") || strings.HasPrefix(value, "~\\") {
		home, err := os.UserHomeDir()
		if err == nil {
			if value == "~" {
				return home
			}
			return filepath.Join(home, value[2:])
		}
	}
	return value
}

func (s *kubectlSession) close() { s.cleanup() }

func (s *kubectlSession) baseArgs() []string {
	args := []string{"--kubeconfig", s.kubeconfig}
	if s.context != "" {
		args = append(args, "--context", s.context)
	}
	return args
}

func (s *kubectlSession) command(ctx context.Context, args ...string) (*exec.Cmd, func(), error) {
	all := append(s.baseArgs(), args...)
	if s.ssh != nil {
		return s.ssh.Command(ctx, s.environment, append([]string{s.binary}, all...)...)
	}
	cmd := exec.CommandContext(ctx, s.binary, all...) //nolint:gosec // The binary is resolved during session setup; kubectl arguments are the intended API.
	cmd.Env = mergeEnvironment(os.Environ(), s.environment)
	return cmd, func() {}, nil
}

func (s *kubectlSession) run(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	cmd, cleanup, err := s.command(ctx, args...)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return stdout.Bytes(), fmt.Errorf("kubectl %s: %s", strings.Join(args, " "), message)
	}
	return stdout.Bytes(), nil
}

func (s *kubectlSession) validateExecPolicy(ctx context.Context) error {
	if s.policy == "allow" {
		return nil
	}
	stdout, err := s.run(ctx, nil, "config", "view", "--raw", "--minify", "-o", "json")
	if err != nil {
		return fmt.Errorf("read kubeconfig through kubectl: %w", err)
	}
	var config struct {
		Users []struct {
			Name string `json:"name"`
			User struct {
				Exec *struct {
					Command string `json:"command"`
				} `json:"exec"`
			} `json:"user"`
		} `json:"users"`
	}
	if err := json.Unmarshal(stdout, &config); err != nil {
		return fmt.Errorf("decode kubeconfig: %w", err)
	}
	allowed := map[string]bool{}
	for _, item := range s.allowlist {
		allowed[item] = true
		allowed[filepath.Base(item)] = true
	}
	for _, user := range config.Users {
		if user.User.Exec == nil || user.User.Exec.Command == "" {
			continue
		}
		command := user.User.Exec.Command
		switch s.policy {
		case "deny", "":
			return fmt.Errorf("kubeconfig user %q requires exec credential plugin %q, but exec plugins are disabled", user.Name, command)
		case "allowlist":
			if !allowed[command] && !allowed[filepath.Base(command)] {
				return fmt.Errorf("kubeconfig user %q requires exec credential plugin %q, which is not in the configured allowlist", user.Name, command)
			}
		default:
			return fmt.Errorf("invalid exec plugin policy %q", s.policy)
		}
	}
	return nil
}

func (p *KubectlProvider) FlattenKubeconfig(ctx context.Context, source []byte, contextName string, policy string, allowlist []string, environment map[string]string) ([]byte, error) {
	settings := p.settings()
	binary := settings.KubectlPath
	if p.connection.Kubernetes != nil && p.connection.Kubernetes.KubectlPath != "" {
		binary = p.connection.Kubernetes.KubectlPath
	}
	if binary == "" {
		binary = "kubectl"
	}
	resolved, err := exec.LookPath(binary)
	if err != nil {
		return nil, fmt.Errorf("kubectl was not found: %w", err)
	}
	f, err := os.CreateTemp("", "runwake-kubeconfig-*")
	if err != nil {
		return nil, err
	}
	path := f.Name()
	defer func() { _ = os.Remove(path) }()
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return nil, err
	}
	if _, err := f.Write(source); err != nil {
		_ = f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	s := &kubectlSession{binary: resolved, kubeconfig: path, context: contextName, cleanup: func() {}, policy: policy, allowlist: allowlist, environment: environment}
	if err := s.validateExecPolicy(ctx); err != nil {
		return nil, err
	}
	args := []string{"--kubeconfig", path}
	if contextName != "" {
		args = append(args, "--context", contextName)
	}
	args = append(args, "config", "view", "--raw", "--flatten", "-o", "json")
	cmd := exec.CommandContext(ctx, resolved, args...) //nolint:gosec // resolved comes from exec.LookPath and args are generated internally.
	cmd.Env = mergeEnvironment(os.Environ(), environment)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("flatten kubeconfig: %s", strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

func mergeEnvironment(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return append([]string(nil), base...)
	}
	normalize := func(key string) string {
		if runtime.GOOS == "windows" {
			return strings.ToUpper(key)
		}
		return key
	}
	replaced := make(map[string]bool, len(overrides))
	for key := range overrides {
		replaced[normalize(key)] = true
	}
	out := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		key := entry
		if before, _, ok := strings.Cut(entry, "="); ok {
			key = before
		}
		if !replaced[normalize(key)] {
			out = append(out, entry)
		}
	}
	keys := make([]string, 0, len(overrides))
	for key := range overrides {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		out = append(out, key+"="+overrides[key])
	}
	return out
}

func (p *KubectlProvider) Test(ctx context.Context) (model.ProviderInfo, error) {
	s, err := p.session(ctx)
	if err != nil {
		return model.ProviderInfo{}, err
	}
	defer s.close()
	stdout, err := s.run(ctx, nil, "version", "-o", "json")
	if err != nil {
		return model.ProviderInfo{}, err
	}
	var v struct {
		ClientVersion struct {
			GitVersion string `json:"gitVersion"`
		} `json:"clientVersion"`
		ServerVersion struct {
			GitVersion string `json:"gitVersion"`
		} `json:"serverVersion"`
	}
	_ = json.Unmarshal(stdout, &v)
	details := map[string]string{}
	if v.ClientVersion.GitVersion != "" {
		details["kubectl"] = v.ClientVersion.GitVersion
	}
	if v.ServerVersion.GitVersion != "" {
		details["server"] = v.ServerVersion.GitVersion
	}
	if p.connection.Kubernetes.Context != "" {
		details["context"] = p.connection.Kubernetes.Context
	}
	return model.ProviderInfo{State: "connected", Details: details}, nil
}

func (p *KubectlProvider) Namespaces(ctx context.Context) ([]string, error) {
	s, err := p.session(ctx)
	if err != nil {
		return nil, err
	}
	defer s.close()
	if p.connection.Kubernetes.NamespaceMode == "selected" && len(p.connection.Kubernetes.Namespaces) > 0 {
		out := append([]string(nil), p.connection.Kubernetes.Namespaces...)
		sort.Strings(out)
		return out, nil
	}
	stdout, err := s.run(ctx, nil, "get", "namespaces", "-o", "json")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal(stdout, &list); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list.Items))
	for _, item := range list.Items {
		out = append(out, item.Metadata.Name)
	}
	sort.Strings(out)
	return out, nil
}

func (p *KubectlProvider) ListWorkloads(ctx context.Context) ([]model.Workload, error) {
	s, err := p.session(ctx)
	if err != nil {
		return nil, err
	}
	defer s.close()

	namespaces := []string(nil)
	if p.connection.Kubernetes.NamespaceMode == "selected" {
		namespaces = append(namespaces, p.connection.Kubernetes.Namespaces...)
	}
	commands := workloadListCommands(namespaces)
	var mu sync.Mutex
	var merged listEnvelope
	var firstErr error
	var wg sync.WaitGroup
	for _, args := range commands {
		commandArgs := append([]string(nil), args...)
		wg.Add(1)
		go func() {
			defer wg.Done()
			stdout, runErr := s.run(ctx, nil, commandArgs...)
			if runErr != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = runErr
				}
				mu.Unlock()
				return
			}
			var list listEnvelope
			if decodeErr := json.Unmarshal(stdout, &list); decodeErr != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = decodeErr
				}
				mu.Unlock()
				return
			}
			mu.Lock()
			merged.Items = append(merged.Items, list.Items...)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	data, err := json.Marshal(merged)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, namespace := range namespaces {
		allowed[namespace] = true
	}
	return parseWorkloadList(data, p.connection.ID, p.connection.Name, allowed)
}

func (p *KubectlProvider) StreamWorkloads(ctx context.Context, out chan<- model.Workload) error {
	s, err := p.session(ctx)
	if err != nil {
		return err
	}
	defer s.close()

	namespaces := []string(nil)
	if p.connection.Kubernetes.NamespaceMode == "selected" {
		namespaces = append(namespaces, p.connection.Kubernetes.Namespaces...)
	}
	allowed := map[string]bool{}
	for _, namespace := range namespaces {
		allowed[namespace] = true
	}
	commands := workloadStreamCommands(namespaces)
	type result struct {
		items []model.Workload
		err   error
	}
	results := make(chan result, len(commands))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for _, command := range commands {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				results <- result{err: ctx.Err()}
				return
			}
			stdout, runErr := s.run(ctx, nil, command.args...)
			<-sem
			if runErr != nil {
				results <- result{err: runErr}
				return
			}
			var list listEnvelope
			if decodeErr := json.Unmarshal(stdout, &list); decodeErr != nil {
				results <- result{err: decodeErr}
				return
			}
			for index := range list.Items {
				typed, stampErr := stampWorkloadKind(list.Items[index], command.kind)
				if stampErr != nil {
					results <- result{err: stampErr}
					return
				}
				list.Items[index] = typed
			}
			data, marshalErr := json.Marshal(list)
			if marshalErr != nil {
				results <- result{err: marshalErr}
				return
			}
			items, parseErr := parseWorkloadList(data, p.connection.ID, p.connection.Name, allowed)
			results <- result{items: items, err: parseErr}
		}()
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	var firstErr error
	for result := range results {
		if result.err != nil {
			if firstErr == nil {
				firstErr = result.err
			}
			continue
		}
		for _, workload := range result.items {
			select {
			case out <- workload:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return firstErr
}

func workloadListCommands(namespaces []string) [][]string {
	const resources = "deployments,statefulsets,daemonsets,jobs,pods"
	if len(namespaces) == 0 {
		return [][]string{{"get", resources, "-A", "-o", "json", "--request-timeout=20s"}}
	}
	commands := make([][]string, 0, len(namespaces))
	for _, namespace := range namespaces {
		commands = append(commands, []string{"get", resources, "-n", namespace, "-o", "json", "--request-timeout=20s"})
	}
	return commands
}

type workloadStreamCommand struct {
	args []string
	kind string
}

func workloadStreamCommands(namespaces []string) []workloadStreamCommand {
	resources := []struct {
		name string
		kind string
	}{
		{name: "deployments", kind: "Deployment"},
		{name: "statefulsets", kind: "StatefulSet"},
		{name: "daemonsets", kind: "DaemonSet"},
		{name: "jobs", kind: "Job"},
		{name: "pods", kind: "Pod"},
	}
	scopes := namespaces
	if len(scopes) == 0 {
		scopes = []string{""}
	}
	commands := make([]workloadStreamCommand, 0, len(scopes)*len(resources))
	for _, namespace := range scopes {
		for _, resource := range resources {
			args := []string{"get", resource.name}
			if namespace == "" {
				args = append(args, "-A")
			} else {
				args = append(args, "-n", namespace)
			}
			args = append(args, "-o", "json", "--request-timeout=20s")
			commands = append(commands, workloadStreamCommand{args: args, kind: resource.kind})
		}
	}
	return commands
}

type kubectlPodSelection struct {
	namespace string
	exactName string
	selector  string
}

type activeKubectlPod struct {
	pod         podObject
	fingerprint string
	cancel      context.CancelFunc
}

func (p *KubectlProvider) Stream(ctx context.Context, request model.StreamRequest, out chan<- model.ActivityRecord) error {
	s, err := p.session(ctx)
	if err != nil {
		return err
	}
	defer s.close()
	selection, err := s.podSelection(ctx, request)
	if err != nil {
		return err
	}
	tail := request.TailLines
	if tail < 0 {
		tail = 0
	} else if tail == 0 {
		tail = p.settings().DefaultTailLines
	}

	active := map[string]*activeKubectlPod{}
	var streams sync.WaitGroup
	waitingNotified := false
	lastReadError := ""

	startPod := func(pod podObject, includeRecentEvents bool) {
		podCtx, cancel := context.WithCancel(ctx)
		entry := &activeKubectlPod{pod: pod, fingerprint: podRuntimeFingerprint(pod), cancel: cancel}
		active[podIdentity(pod)] = entry
		streams.Add(1)
		go func() {
			defer streams.Done()
			p.runKubectlPodStreams(podCtx, s, request, pod, tail, includeRecentEvents, out)
		}()
	}

	reconcile := func(initial bool) error {
		pods, readErr := s.listSelectedPods(ctx, selection)
		if readErr != nil {
			if initial {
				return readErr
			}
			if readErr.Error() != lastReadError {
				lastReadError = readErr.Error()
				emitActivity(ctx, out, model.ActivityRecord{
					Timestamp: time.Now().UTC(), Type: "error", Level: "warning", Source: "kubernetes-watch",
					Message: "Could not refresh matching Pods", Fields: map[string]any{"error": readErr.Error()},
				})
			}
			return nil
		}
		lastReadError = ""
		pods = filterActivityPods(pods, request.Pod)
		seen := make(map[string]bool, len(pods))
		for _, pod := range pods {
			key := podIdentity(pod)
			seen[key] = true
			current := active[key]
			fingerprint := podRuntimeFingerprint(pod)
			if current == nil {
				emitActivity(ctx, out, model.ActivityRecord{
					Timestamp: time.Now().UTC(), Type: "system", Level: "info", Source: "kubernetes-watch", Pod: pod.Metadata.Name,
					Message: "Pod added to activity stream", Fields: map[string]any{"uid": pod.Metadata.UID, "phase": pod.Status.Phase},
				})
				startPod(pod, true)
				continue
			}
			for _, record := range podStateRecords(current.pod, pod) {
				emitActivity(ctx, out, record)
			}
			if fingerprint != current.fingerprint {
				current.cancel()
				delete(active, key)
				startPod(pod, false)
				continue
			}
			current.pod = pod
		}
		for key, current := range active {
			if seen[key] {
				continue
			}
			current.cancel()
			delete(active, key)
			emitActivity(ctx, out, model.ActivityRecord{
				Timestamp: time.Now().UTC(), Type: "system", Level: "info", Source: "kubernetes-watch", Pod: current.pod.Metadata.Name,
				Message: "Pod removed from activity stream", Fields: map[string]any{"uid": current.pod.Metadata.UID},
			})
		}
		if len(pods) == 0 && !waitingNotified {
			waitingNotified = true
			emitActivity(ctx, out, model.ActivityRecord{
				Timestamp: time.Now().UTC(), Type: "state", Level: "info", Source: "kubernetes-watch",
				Message: "No matching Pods are currently available; waiting for changes",
			})
		} else if len(pods) > 0 {
			waitingNotified = false
		}
		return nil
	}

	if err := reconcile(true); err != nil {
		return err
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	defer func() {
		for _, current := range active {
			current.cancel()
		}
		streams.Wait()
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := reconcile(false); err != nil {
				return err
			}
		}
	}
}

func emitActivity(ctx context.Context, out chan<- model.ActivityRecord, record model.ActivityRecord) {
	select {
	case out <- record:
	case <-ctx.Done():
	}
}

func (p *KubectlProvider) runKubectlPodStreams(ctx context.Context, s *kubectlSession, request model.StreamRequest, pod podObject, tail int, includeRecentEvents bool, out chan<- model.ActivityRecord) {
	p.emitCurrentPodState(pod, out)
	var wg sync.WaitGroup
	if request.Events {
		if includeRecentEvents {
			p.emitRecentEvents(ctx, s, pod, out)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.watchEvents(ctx, s, pod, out)
		}()
	}
	for _, status := range podContainerStatuses(pod) {
		if !activityContainerSelected(request.Container, status.Name) {
			continue
		}
		if request.Previous && status.RestartCount > 0 {
			wg.Add(1)
			go func(status containerStatus) {
				defer wg.Done()
				p.streamKubectlLogs(ctx, s, pod.Metadata.Namespace, pod.Metadata.Name, status.Name, tail, true, false, out)
			}(status)
		}
		wg.Add(1)
		go func(status containerStatus) {
			defer wg.Done()
			p.streamKubectlLogs(ctx, s, pod.Metadata.Namespace, pod.Metadata.Name, status.Name, tail, false, true, out)
		}(status)
	}
	wg.Wait()
}

func (s *kubectlSession) podSelection(ctx context.Context, request model.StreamRequest) (kubectlPodSelection, error) {
	selection := kubectlPodSelection{namespace: request.Namespace}
	kind := strings.ToLower(request.Kind)
	if kind == "pod" {
		selection.exactName = request.Name
		return selection, nil
	}
	stdout, err := s.run(ctx, nil, "get", kind, request.Name, "-n", request.Namespace, "-o", "json")
	if err != nil {
		return kubectlPodSelection{}, err
	}
	var obj workloadObject
	if err := json.Unmarshal(stdout, &obj); err != nil {
		return kubectlPodSelection{}, err
	}
	selection.selector = selectorString(obj.Spec.Selector)
	if kind == "job" && selection.selector == "" {
		selection.selector = "batch.kubernetes.io/job-name=" + request.Name
	}
	if selection.selector == "" {
		return kubectlPodSelection{}, errors.New("workload does not expose a pod selector")
	}
	return selection, nil
}

func (s *kubectlSession) listSelectedPods(ctx context.Context, selection kubectlPodSelection) ([]podObject, error) {
	if selection.exactName != "" {
		stdout, err := s.run(ctx, nil, "get", "pod", selection.exactName, "-n", selection.namespace, "-o", "json", "--request-timeout=10s")
		if err != nil {
			return nil, err
		}
		var pod podObject
		if err := json.Unmarshal(stdout, &pod); err != nil {
			return nil, err
		}
		return []podObject{pod}, nil
	}
	stdout, err := s.run(ctx, nil, "get", "pods", "-n", selection.namespace, "-l", selection.selector, "-o", "json", "--request-timeout=10s")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []podObject `json:"items"`
	}
	if err := json.Unmarshal(stdout, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (s *kubectlSession) resolvePods(ctx context.Context, request model.StreamRequest) ([]podObject, error) {
	selection, err := s.podSelection(ctx, request)
	if err != nil {
		return nil, err
	}
	return s.listSelectedPods(ctx, selection)
}

func (p *KubectlProvider) emitCurrentPodState(pod podObject, out chan<- model.ActivityRecord) {
	for _, status := range allContainerStatuses(pod.Status) {
		fields := map[string]any{
			"ready":         status.Ready,
			"restart_count": status.RestartCount,
			"state":         containerStateName(status.State),
		}
		if status.LastState.Terminated != nil {
			fields["previous_exit_code"] = status.LastState.Terminated.ExitCode
			fields["previous_reason"] = status.LastState.Terminated.Reason
			fields["previous_finished_at"] = status.LastState.Terminated.FinishedAt
		}
		record := model.ActivityRecord{Timestamp: time.Now().UTC(), Type: "state", Level: "info", Source: "kubernetes-pod", Pod: pod.Metadata.Name, Container: status.Name, Message: "Current container state", Fields: fields}
		select {
		case out <- record:
		case <-time.After(time.Second):
		}
	}
}

func (p *KubectlProvider) emitRecentEvents(ctx context.Context, s *kubectlSession, pod podObject, out chan<- model.ActivityRecord) {
	stdout, err := s.run(ctx, nil, "get", "events", "-n", pod.Metadata.Namespace, "--field-selector", "involvedObject.name="+pod.Metadata.Name, "-o", "json")
	if err != nil {
		return
	}
	var events eventList
	if json.Unmarshal(stdout, &events) != nil {
		return
	}
	sort.Slice(events.Items, func(i, j int) bool { return eventTimestamp(events.Items[i]).Before(eventTimestamp(events.Items[j])) })
	start := 0
	if len(events.Items) > 30 {
		start = len(events.Items) - 30
	}
	for _, event := range events.Items[start:] {
		select {
		case out <- eventRecord(event):
		case <-ctx.Done():
			return
		}
	}
}

func (p *KubectlProvider) watchEvents(ctx context.Context, s *kubectlSession, pod podObject, out chan<- model.ActivityRecord) {
	cmd, cleanup, err := s.command(ctx, "get", "events", "-n", pod.Metadata.Namespace, "--field-selector", "involvedObject.name="+pod.Metadata.Name, "--watch-only", "--output-watch-events", "-o", "json")
	if err != nil {
		return
	}
	defer cleanup()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return
	}
	decoder := json.NewDecoder(stdout)
	for {
		var envelope watchEnvelope
		if err := decoder.Decode(&envelope); err != nil {
			break
		}
		var event eventObject
		if json.Unmarshal(envelope.Object, &event) != nil {
			continue
		}
		select {
		case out <- eventRecord(event):
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return
		}
	}
	_ = cmd.Wait()
}

func (p *KubectlProvider) streamKubectlLogs(ctx context.Context, s *kubectlSession, namespace, pod, container string, tail int, previous, follow bool, out chan<- model.ActivityRecord) {
	args := []string{"logs", "-n", namespace, pod, "-c", container, "--timestamps=true", "--tail=" + strconv.Itoa(tail)}
	if previous {
		args = append(args, "--previous=true")
	}
	if follow {
		args = append(args, "--follow=true")
	}
	cmd, cleanup, err := s.command(ctx, args...)
	if err != nil {
		return
	}
	defer cleanup()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		return
	}
	var wg sync.WaitGroup
	consume := func(reader io.Reader, level string) {
		defer wg.Done()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			ts, message := splitTimestamp(line)
			fields := map[string]any{}
			if previous {
				fields["previous"] = true
			}
			record := model.ActivityRecord{Timestamp: ts, Type: "log", Level: level, Source: "kubernetes-log", Pod: pod, Container: container, Message: message, Fields: fields}
			select {
			case out <- record:
			case <-ctx.Done():
				return
			}
		}
	}
	wg.Add(2)
	go consume(stdout, "log")
	go consume(stderr, "error")
	wg.Wait()
	_ = cmd.Wait()
}

func splitTimestamp(line string) (time.Time, string) {
	parts := strings.SplitN(line, " ", 2)
	if len(parts) == 2 {
		if ts, err := time.Parse(time.RFC3339Nano, parts[0]); err == nil {
			return ts, parts[1]
		}
	}
	return time.Now().UTC(), line
}

func (p *KubectlProvider) ApplyManifest(ctx context.Context, manifest string) error {
	s, err := p.session(ctx)
	if err != nil {
		return err
	}
	defer s.close()
	_, err = s.run(ctx, []byte(manifest), "apply", "-f", "-")
	return err
}

func (p *KubectlProvider) DeleteManifest(ctx context.Context, manifest string) error {
	s, err := p.session(ctx)
	if err != nil {
		return err
	}
	defer s.close()
	_, err = s.run(ctx, []byte(manifest), "delete", "-f", "-", "--ignore-not-found=true", "--wait=false")
	return err
}

func (p *KubectlProvider) ListMetrics(ctx context.Context) ([]model.WorkloadMetric, error) {
	workloads, err := p.ListWorkloads(ctx)
	if err != nil {
		return nil, err
	}
	s, err := p.session(ctx)
	if err != nil {
		return nil, err
	}
	defer s.close()
	pods, err := s.listMetricPods(ctx, p.connection.Kubernetes.Namespaces, p.connection.Kubernetes.NamespaceMode == "selected")
	if err != nil {
		return nil, err
	}
	items, err := s.listPodMetrics(ctx, p.connection.Kubernetes.Namespaces, p.connection.Kubernetes.NamespaceMode == "selected")
	if err != nil {
		return nil, err
	}
	return aggregateAllMetrics(p.connection.ID, p.connection.Name, workloads, pods, items), nil
}

func (p *KubectlProvider) StreamMetrics(ctx context.Context, request model.MetricRequest, out chan<- model.WorkloadMetric) error {
	s, err := p.session(ctx)
	if err != nil {
		return err
	}
	defer s.close()
	pods, err := s.resolvePods(ctx, model.StreamRequest{ConnectionID: request.ConnectionID, Kind: request.Kind, Namespace: request.Namespace, Name: request.Name})
	if err != nil {
		return err
	}
	interval := time.Duration(request.IntervalSeconds) * time.Second
	if interval < 10*time.Second {
		interval = 15 * time.Second
	}
	emit := func() error {
		items, readErr := s.metricsForPods(ctx, pods)
		if readErr != nil {
			return readErr
		}
		metric, aggregateErr := aggregateSelectedMetrics(p.connection.ID, p.connection.Name, request, pods, items)
		if aggregateErr != nil {
			return aggregateErr
		}
		select {
		case out <- metric:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if emitErr := emit(); emitErr != nil {
		return emitErr
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			// Workload Pods may change during a rollout. Refresh the selection before every sample.
			pods, err = s.resolvePods(ctx, model.StreamRequest{ConnectionID: request.ConnectionID, Kind: request.Kind, Namespace: request.Namespace, Name: request.Name})
			if err != nil {
				return err
			}
			if err := emit(); err != nil {
				return err
			}
		}
	}
}

func (s *kubectlSession) listMetricPods(ctx context.Context, namespaces []string, selected bool) ([]podObject, error) {
	var merged []podObject
	if selected && len(namespaces) > 0 {
		for _, namespace := range namespaces {
			stdout, err := s.run(ctx, nil, "get", "pods", "-n", namespace, "-o", "json", "--request-timeout=15s")
			if err != nil {
				return nil, err
			}
			var list struct {
				Items []podObject `json:"items"`
			}
			if err := json.Unmarshal(stdout, &list); err != nil {
				return nil, err
			}
			merged = append(merged, list.Items...)
		}
		return merged, nil
	}
	stdout, err := s.run(ctx, nil, "get", "pods", "-A", "-o", "json", "--request-timeout=15s")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []podObject `json:"items"`
	}
	if err := json.Unmarshal(stdout, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (s *kubectlSession) listPodMetrics(ctx context.Context, namespaces []string, selected bool) ([]podMetric, error) {
	var merged []podMetric
	paths := []string{"/apis/metrics.k8s.io/v1beta1/pods"}
	if selected && len(namespaces) > 0 {
		paths = paths[:0]
		for _, namespace := range namespaces {
			paths = append(paths, "/apis/metrics.k8s.io/v1beta1/namespaces/"+url.PathEscape(namespace)+"/pods")
		}
	}
	for _, path := range paths {
		stdout, err := s.run(ctx, nil, "get", "--raw", path, "--request-timeout=15s")
		if err != nil {
			return nil, fmt.Errorf("kubernetes Metrics API is unavailable or access was denied: %w", err)
		}
		var list podMetricsList
		if err := json.Unmarshal(stdout, &list); err != nil {
			return nil, fmt.Errorf("decode Kubernetes Metrics API response: %w", err)
		}
		merged = append(merged, list.Items...)
	}
	return merged, nil
}

func (s *kubectlSession) metricsForPods(ctx context.Context, pods []podObject) ([]podMetric, error) {
	items := make([]podMetric, 0, len(pods))
	for _, pod := range pods {
		path := "/apis/metrics.k8s.io/v1beta1/namespaces/" + url.PathEscape(pod.Metadata.Namespace) + "/pods/" + url.PathEscape(pod.Metadata.Name)
		stdout, err := s.run(ctx, nil, "get", "--raw", path, "--request-timeout=15s")
		if err != nil {
			return nil, fmt.Errorf("kubernetes Metrics API is unavailable or access was denied: %w", err)
		}
		var item podMetric
		if err := json.Unmarshal(stdout, &item); err != nil {
			return nil, fmt.Errorf("decode Kubernetes Metrics API response: %w", err)
		}
		items = append(items, item)
	}
	return items, nil
}
