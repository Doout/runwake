package deploy

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/model"
)

type Request struct {
	ConnectionID      string
	Name              string
	Mode              string // persistent | temporary
	ServerURL         string
	Token             string
	Image             string
	Namespace         string
	Namespaces        []string
	TTL               time.Duration
	InventoryInterval time.Duration
}

type Result struct {
	ApplyManifest    string
	TeardownManifest string
	Deployment       model.AgentDeployment
}

var invalidDNS = regexp.MustCompile(`[^a-z0-9-]+`)

func Build(request Request) (Result, error) {
	if request.ConnectionID == "" || request.Token == "" || request.ServerURL == "" || request.Image == "" {
		return Result{}, errors.New("connection ID, token, server URL and image are required")
	}
	if request.Mode == "" {
		request.Mode = "persistent"
	}
	if request.Mode != "persistent" && request.Mode != "temporary" {
		return Result{}, errors.New("agent mode must be persistent or temporary")
	}
	if request.Namespace == "" {
		request.Namespace = "runwake-system"
	}
	if request.Name == "" {
		request.Name = "runwake-agent"
	}
	name := dnsName(request.Name + "-" + shortID(request.ConnectionID))
	roleName := dnsName("runwake-reader-" + shortID(request.ConnectionID))
	secretName := name + "-credentials"
	serviceAccount := name
	namespaces := normalizedNamespaces(request.Namespaces)
	if request.Mode == "temporary" && request.TTL <= 0 {
		request.TTL = 30 * time.Minute
	}
	if request.InventoryInterval <= 0 {
		request.InventoryInterval = 30 * time.Second
	}

	labels := map[string]string{
		"app.kubernetes.io/name":       "runwake-agent",
		"app.kubernetes.io/managed-by": "runwake",
		"runwake.io/connection-id":     request.ConnectionID,
	}
	var apply strings.Builder
	writeNamespace(&apply, request.Namespace, labels)
	writeServiceAccount(&apply, request.Namespace, serviceAccount, labels)
	writeClusterRole(&apply, roleName, labels)
	if len(namespaces) == 0 {
		writeClusterRoleBinding(&apply, roleName, request.Namespace, serviceAccount, labels)
	} else {
		for _, namespace := range namespaces {
			writeRoleBinding(&apply, namespace, roleName, request.Namespace, serviceAccount, labels)
		}
	}
	writeSecret(&apply, request.Namespace, secretName, request.ConnectionID, request.Token, labels)
	if request.Mode == "persistent" {
		writeDeployment(&apply, request, name, serviceAccount, secretName, labels, namespaces)
	} else {
		writeJob(&apply, request, name, serviceAccount, secretName, labels, namespaces)
	}

	var teardown strings.Builder
	// Never delete the namespace during teardown. It may have existed before
	// Runwake or may contain other agents and unrelated workloads.
	writeServiceAccount(&teardown, request.Namespace, serviceAccount, labels)
	writeClusterRole(&teardown, roleName, labels)
	if len(namespaces) == 0 {
		writeClusterRoleBinding(&teardown, roleName, request.Namespace, serviceAccount, labels)
	} else {
		for _, namespace := range namespaces {
			writeRoleBinding(&teardown, namespace, roleName, request.Namespace, serviceAccount, labels)
		}
	}
	writeSecret(&teardown, request.Namespace, secretName, request.ConnectionID, request.Token, labels)
	if request.Mode == "persistent" {
		writeDeployment(&teardown, request, name, serviceAccount, secretName, labels, namespaces)
	} else {
		writeJob(&teardown, request, name, serviceAccount, secretName, labels, namespaces)
	}

	deployment := model.AgentDeployment{
		Mode:           request.Mode,
		AgentNamespace: request.Namespace,
		ResourceName:   name,
		RoleName:       roleName,
		Namespaces:     namespaces,
		Image:          request.Image,
		ServerURL:      request.ServerURL,
	}
	if request.Mode == "temporary" {
		deployment.ExpiresAt = time.Now().UTC().Add(request.TTL)
	}
	return Result{ApplyManifest: apply.String(), TeardownManifest: teardown.String(), Deployment: deployment}, nil
}

func writeNamespace(out *strings.Builder, namespace string, labels map[string]string) {
	separator(out)
	fmt.Fprintf(out, "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: %s\n", namespace)
	writeLabels(out, labels)
}

func writeServiceAccount(out *strings.Builder, namespace, name string, labels map[string]string) {
	separator(out)
	fmt.Fprintf(out, "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: %s\n  namespace: %s\n", name, namespace)
	writeLabels(out, labels)
}

func writeClusterRole(out *strings.Builder, name string, labels map[string]string) {
	separator(out)
	fmt.Fprintf(out, "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: %s\n", name)
	writeLabels(out, labels)
	out.WriteString(`rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods"]
    verbs: ["get", "list"]
`)
}

func writeClusterRoleBinding(out *strings.Builder, roleName, namespace, serviceAccount string, labels map[string]string) {
	separator(out)
	fmt.Fprintf(out, "apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: %s\n", roleName)
	writeLabels(out, labels)
	fmt.Fprintf(out, "roleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: %s\nsubjects:\n  - kind: ServiceAccount\n    name: %s\n    namespace: %s\n", roleName, serviceAccount, namespace)
}

func writeRoleBinding(out *strings.Builder, targetNamespace, roleName, agentNamespace, serviceAccount string, labels map[string]string) {
	separator(out)
	fmt.Fprintf(out, "apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: %s\n  namespace: %s\n", roleName, targetNamespace)
	writeLabels(out, labels)
	fmt.Fprintf(out, "roleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: %s\nsubjects:\n  - kind: ServiceAccount\n    name: %s\n    namespace: %s\n", roleName, serviceAccount, agentNamespace)
}

func writeSecret(out *strings.Builder, namespace, name, connectionID, token string, labels map[string]string) {
	separator(out)
	fmt.Fprintf(out, "apiVersion: v1\nkind: Secret\ntype: Opaque\nmetadata:\n  name: %s\n  namespace: %s\n", name, namespace)
	writeLabels(out, labels)
	fmt.Fprintf(out, "stringData:\n  connection-id: %s\n  token: %s\n", yamlString(connectionID), yamlString(token))
}

func writeDeployment(out *strings.Builder, request Request, name, serviceAccount, secretName string, labels map[string]string, namespaces []string) {
	separator(out)
	fmt.Fprintf(out, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: %s\n  namespace: %s\n", name, request.Namespace)
	writeLabels(out, labels)
	fmt.Fprintf(out, "spec:\n  replicas: 1\n  selector:\n    matchLabels:\n      runwake.io/connection-id: %s\n  template:\n", yamlString(request.ConnectionID))
	writePodTemplate(out, request, serviceAccount, secretName, labels, namespaces, 6)
}

func writeJob(out *strings.Builder, request Request, name, serviceAccount, secretName string, labels map[string]string, namespaces []string) {
	separator(out)
	seconds := int64(request.TTL.Seconds())
	fmt.Fprintf(out, "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: %s\n  namespace: %s\n", name, request.Namespace)
	writeLabels(out, labels)
	fmt.Fprintf(out, "spec:\n  backoffLimit: 2\n  activeDeadlineSeconds: %d\n  ttlSecondsAfterFinished: 120\n  template:\n", seconds)
	writePodTemplate(out, request, serviceAccount, secretName, labels, namespaces, 4)
}

func writePodTemplate(out *strings.Builder, request Request, serviceAccount, secretName string, labels map[string]string, namespaces []string, indent int) {
	prefix := strings.Repeat(" ", indent)
	fmt.Fprintf(out, "%smetadata:\n", prefix)
	fmt.Fprintf(out, "%s  labels:\n", prefix)
	for _, key := range sortedKeys(labels) {
		fmt.Fprintf(out, "%s    %s: %s\n", prefix, key, yamlString(labels[key]))
	}
	fmt.Fprintf(out, "%sspec:\n%s  serviceAccountName: %s\n%s  automountServiceAccountToken: true\n%s  restartPolicy: %s\n", prefix, prefix, serviceAccount, prefix, prefix, map[bool]string{true: "Never", false: "Always"}[request.Mode == "temporary"])
	fmt.Fprintf(out, "%s  securityContext:\n%s    runAsNonRoot: true\n%s    runAsUser: 65532\n%s    runAsGroup: 65532\n%s    seccompProfile:\n%s      type: RuntimeDefault\n", prefix, prefix, prefix, prefix, prefix, prefix)
	fmt.Fprintf(out, "%s  containers:\n%s    - name: agent\n%s      image: %s\n%s      imagePullPolicy: IfNotPresent\n", prefix, prefix, prefix, yamlString(request.Image), prefix)
	fmt.Fprintf(out, "%s      env:\n", prefix)
	writeEnv(out, prefix+"        ", "RUNWAKE_SERVER_URL", request.ServerURL)
	writeSecretEnv(out, prefix+"        ", "RUNWAKE_CONNECTION_ID", secretName, "connection-id")
	writeSecretEnv(out, prefix+"        ", "RUNWAKE_AGENT_TOKEN", secretName, "token")
	writeEnv(out, prefix+"        ", "RUNWAKE_AGENT_KIND", "kubernetes")
	writeEnv(out, prefix+"        ", "RUNWAKE_NAMESPACES", strings.Join(namespaces, ","))
	writeEnv(out, prefix+"        ", "RUNWAKE_INVENTORY_INTERVAL", request.InventoryInterval.String())
	if request.Mode == "temporary" {
		writeEnv(out, prefix+"        ", "RUNWAKE_TEMPORARY_TTL", request.TTL.String())
	}
	fmt.Fprintf(out, "%s      resources:\n%s        requests:\n%s          cpu: 10m\n%s          memory: 24Mi\n%s        limits:\n%s          cpu: 200m\n%s          memory: 128Mi\n", prefix, prefix, prefix, prefix, prefix, prefix, prefix)
	fmt.Fprintf(out, "%s      securityContext:\n%s        allowPrivilegeEscalation: false\n%s        readOnlyRootFilesystem: true\n%s        capabilities:\n%s          drop: [\"ALL\"]\n", prefix, prefix, prefix, prefix, prefix)
}

func writeEnv(out *strings.Builder, indent, name, value string) {
	fmt.Fprintf(out, "%s- name: %s\n%s  value: %s\n", indent, name, indent, yamlString(value))
}

func writeSecretEnv(out *strings.Builder, indent, name, secret, key string) {
	fmt.Fprintf(out, "%s- name: %s\n%s  valueFrom:\n%s    secretKeyRef:\n%s      name: %s\n%s      key: %s\n", indent, name, indent, indent, indent, secret, indent, key)
}

func writeLabels(out *strings.Builder, labels map[string]string) {
	const indent = "  "
	out.WriteString(indent + "labels:\n")
	for _, key := range sortedKeys(labels) {
		fmt.Fprintf(out, "%s  %s: %s\n", indent, key, yamlString(labels[key]))
	}
}

func separator(out *strings.Builder) {
	if out.Len() > 0 {
		out.WriteString("---\n")
	}
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func normalizedNamespaces(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func dnsName(value string) string {
	value = strings.ToLower(value)
	value = invalidDNS.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	if len(value) > 63 {
		value = strings.Trim(value[:63], "-")
	}
	if value == "" {
		return "runwake-agent"
	}
	return value
}

func shortID(value string) string {
	if index := strings.LastIndex(value, "_"); index >= 0 {
		value = value[index+1:]
	}
	if len(value) > 8 {
		return value[:8]
	}
	return value
}

func yamlString(value string) string { return strconv.Quote(value) }
