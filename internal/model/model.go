package model

import (
	"strconv"
	"time"
)

const (
	ConnectionKubernetes = "kubernetes"
	ConnectionDocker     = "docker"
	ModeDirect           = "direct"
	ModeAgent            = "agent"
	AccessReadOnly       = "read_only"
	AccessManage         = "manage"
)

type Settings struct {
	DefaultTailLines               int      `json:"default_tail_lines"`
	DefaultAgentImage              string   `json:"default_agent_image,omitempty"`
	PublicURL                      string   `json:"public_url,omitempty"`
	KubectlPath                    string   `json:"kubectl_path,omitempty"`
	ExecPluginPolicy               string   `json:"exec_plugin_policy"`
	ExecPluginAllowlist            []string `json:"exec_plugin_allowlist,omitempty"`
	OverviewMetricsIntervalSeconds int      `json:"overview_metrics_interval_seconds"`
	SelectedMetricsIntervalSeconds int      `json:"selected_metrics_interval_seconds"`
}

func DefaultSettings() Settings {
	return Settings{
		DefaultTailLines:               200,
		KubectlPath:                    "kubectl",
		ExecPluginPolicy:               "allowlist",
		ExecPluginAllowlist:            []string{"aws", "az", "gcloud", "gke-gcloud-auth-plugin", "kubelogin", "oc"},
		OverviewMetricsIntervalSeconds: 30,
		SelectedMetricsIntervalSeconds: 2,
	}
}

type Connection struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Kind       string    `json:"kind"`
	Mode       string    `json:"mode"`
	AccessMode string    `json:"access_mode,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`

	Kubernetes *KubernetesConnection `json:"kubernetes,omitempty"`
	Docker     *DockerConnection     `json:"docker,omitempty"`
	Agent      *AgentConnection      `json:"agent,omitempty"`
	SSH        *SSHConnection        `json:"ssh,omitempty"`
	HTTPProxy  *HTTPProxyConnection  `json:"http_proxy,omitempty"`
	Deployment *AgentDeployment      `json:"deployment,omitempty"`
}

type SSHConnection struct {
	Host             string `json:"host"`
	Port             int    `json:"port,omitempty"`
	User             string `json:"user,omitempty"`
	PrivateKeySecret string `json:"private_key_secret,omitempty"`
	KnownHostsPath   string `json:"known_hosts_path,omitempty"`
	HostKeyPolicy    string `json:"host_key_policy,omitempty"` // strict | accept-new
	ProxyJump        string `json:"proxy_jump,omitempty"`
}

type SSHProfile struct {
	ID               string    `json:"id"`
	Name             string    `json:"name"`
	Host             string    `json:"host"`
	Port             int       `json:"port,omitempty"`
	User             string    `json:"user,omitempty"`
	PrivateKeySecret string    `json:"private_key_secret,omitempty"`
	HasPrivateKey    bool      `json:"has_private_key,omitempty"`
	KnownHostsPath   string    `json:"known_hosts_path,omitempty"`
	HostKeyPolicy    string    `json:"host_key_policy,omitempty"` // strict | accept-new
	ProxyJump        string    `json:"proxy_jump,omitempty"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type HTTPProxyConnection struct {
	DisplayURL string   `json:"display_url"`
	URLSecret  string   `json:"url_secret,omitempty"`
	NoProxy    []string `json:"no_proxy,omitempty"`
}

func (profile SSHProfile) Redacted() SSHProfile {
	profile.HasPrivateKey = profile.PrivateKeySecret != ""
	profile.PrivateKeySecret = ""
	return profile
}

type KubernetesConnection struct {
	KubeconfigSource  string   `json:"kubeconfig_source,omitempty"` // path | stored
	KubeconfigPath    string   `json:"kubeconfig_path,omitempty"`
	KubeconfigSecret  string   `json:"kubeconfig_secret,omitempty"`
	Context           string   `json:"context,omitempty"`
	KubectlPath       string   `json:"kubectl_path,omitempty"`
	NamespaceMode     string   `json:"namespace_mode,omitempty"` // all | selected
	Namespaces        []string `json:"namespaces,omitempty"`
	ExecPolicy        string   `json:"exec_policy,omitempty"` // deny | allowlist | allow
	ExecAllowlist     []string `json:"exec_allowlist,omitempty"`
	EnvironmentSecret string   `json:"environment_secret,omitempty"`
}

type DockerConnection struct {
	Endpoint      string `json:"endpoint,omitempty"`
	TLSCASecret   string `json:"tls_ca_secret,omitempty"`
	TLSCertSecret string `json:"tls_cert_secret,omitempty"`
	TLSKeySecret  string `json:"tls_key_secret,omitempty"`
	TLSServerName string `json:"tls_server_name,omitempty"`
}

type AgentConnection struct {
	TokenHash  string            `json:"token_hash,omitempty"`
	LastSeen   time.Time         `json:"last_seen,omitempty"`
	Version    string            `json:"version,omitempty"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	RunMode    string            `json:"run_mode,omitempty"` // persistent | temporary
	ServerURL  string            `json:"server_url,omitempty"`
	Image      string            `json:"image,omitempty"`
	Namespaces []string          `json:"namespaces,omitempty"`
	ExpiresAt  time.Time         `json:"expires_at,omitempty"`
}

type AgentDeployment struct {
	BootstrapConnectionID string    `json:"bootstrap_connection_id"`
	Mode                  string    `json:"mode"`                // persistent | temporary
	Transport             string    `json:"transport,omitempty"` // direct | ssh
	TargetKind            string    `json:"target_kind,omitempty"`
	AgentNamespace        string    `json:"agent_namespace"`
	ResourceName          string    `json:"resource_name"`
	RoleName              string    `json:"role_name"`
	Namespaces            []string  `json:"namespaces,omitempty"`
	ExpiresAt             time.Time `json:"expires_at,omitempty"`
	Image                 string    `json:"image"`
	ServerURL             string    `json:"server_url"`
	ManifestSecret        string    `json:"manifest_secret,omitempty"`
	RemoteKubeconfigPath  string    `json:"remote_kubeconfig_path,omitempty"`
	RemoteKubectlPath     string    `json:"remote_kubectl_path,omitempty"`
	DockerSocketPath      string    `json:"docker_socket_path,omitempty"`
}

type ConnectionStatus struct {
	State       string            `json:"state"`
	Message     string            `json:"message,omitempty"`
	LastSeen    time.Time         `json:"last_seen,omitempty"`
	Details     map[string]string `json:"details,omitempty"`
	AgentOnline bool              `json:"agent_online,omitempty"`
}

type ConnectionView struct {
	Connection
	Status ConnectionStatus `json:"status"`
}

func (c Connection) Redacted() Connection {
	out := c
	if out.Kind == ConnectionDocker && out.AccessMode == "" {
		out.AccessMode = AccessReadOnly
	}
	if out.Agent != nil {
		a := *out.Agent
		a.TokenHash = ""
		out.Agent = &a
	}
	if out.Kubernetes != nil {
		k := *out.Kubernetes
		k.KubeconfigSecret = ""
		k.EnvironmentSecret = ""
		out.Kubernetes = &k
	}
	if out.Docker != nil {
		d := *out.Docker
		d.TLSCASecret = ""
		d.TLSCertSecret = ""
		d.TLSKeySecret = ""
		out.Docker = &d
	}
	if out.SSH != nil {
		ssh := *out.SSH
		ssh.PrivateKeySecret = ""
		out.SSH = &ssh
	}
	if out.HTTPProxy != nil {
		proxy := *out.HTTPProxy
		proxy.URLSecret = ""
		proxy.NoProxy = append([]string(nil), out.HTTPProxy.NoProxy...)
		out.HTTPProxy = &proxy
	}
	if out.Deployment != nil {
		d := *out.Deployment
		d.ManifestSecret = ""
		out.Deployment = &d
	}
	return out
}

func (c Connection) CanManageDocker() bool {
	return c.Kind == ConnectionDocker && c.Mode == ModeDirect && c.AccessMode == AccessManage
}

type Workload struct {
	ConnectionID string            `json:"connection_id"`
	Connection   string            `json:"connection"`
	Platform     string            `json:"platform"`
	Kind         string            `json:"kind"`
	Namespace    string            `json:"namespace,omitempty"`
	Name         string            `json:"name"`
	UID          string            `json:"uid,omitempty"`
	State        string            `json:"state"`
	Severity     string            `json:"severity"`
	Ready        int               `json:"ready,omitempty"`
	Desired      int               `json:"desired,omitempty"`
	Restarts     int               `json:"restarts,omitempty"`
	Images       []string          `json:"images,omitempty"`
	Containers   []string          `json:"containers,omitempty"`
	Labels       map[string]string `json:"labels,omitempty"`
	Selector     string            `json:"selector,omitempty"`
	CreatedAt    time.Time         `json:"created_at,omitempty"`
	StartedAt    time.Time         `json:"started_at,omitempty"`
	Docker       *DockerWorkload   `json:"docker,omitempty"`
}

type DockerWorkload struct {
	ComposeProject         string                    `json:"compose_project,omitempty"`
	ComposeService         string                    `json:"compose_service,omitempty"`
	ComposeContainerNumber string                    `json:"compose_container_number,omitempty"`
	ComposeWorkingDir      string                    `json:"compose_working_dir,omitempty"`
	ComposeConfigFiles     string                    `json:"compose_config_files,omitempty"`
	ComposeVersion         string                    `json:"compose_version,omitempty"`
	DependsOn              []string                  `json:"depends_on,omitempty"`
	Hostname               string                    `json:"hostname,omitempty"`
	NetworkMode            string                    `json:"network_mode,omitempty"`
	Networks               []DockerNetworkAttachment `json:"networks,omitempty"`
	Mounts                 []DockerMount             `json:"mounts,omitempty"`
	Ports                  []DockerPort              `json:"ports,omitempty"`
}

type DockerNetworkAttachment struct {
	Name              string   `json:"name"`
	NetworkID         string   `json:"network_id,omitempty"`
	EndpointID        string   `json:"endpoint_id,omitempty"`
	Gateway           string   `json:"gateway,omitempty"`
	IPAddress         string   `json:"ip_address,omitempty"`
	GlobalIPv6Address string   `json:"global_ipv6_address,omitempty"`
	Aliases           []string `json:"aliases,omitempty"`
}

type DockerMount struct {
	Type        string `json:"type"`
	Name        string `json:"name,omitempty"`
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination"`
	Driver      string `json:"driver,omitempty"`
	Mode        string `json:"mode,omitempty"`
	Propagation string `json:"propagation,omitempty"`
	ReadOnly    bool   `json:"read_only,omitempty"`
}

type DockerPort struct {
	ContainerPort int    `json:"container_port"`
	Protocol      string `json:"protocol"`
	HostIP        string `json:"host_ip,omitempty"`
	HostPort      int    `json:"host_port,omitempty"`
}

func (w Workload) Key() string {
	return w.ConnectionID + "|" + w.Namespace + "|" + w.Kind + "|" + w.Name
}

type StreamRequest struct {
	ConnectionID string `json:"connection_id"`
	Kind         string `json:"kind"`
	Namespace    string `json:"namespace,omitempty"`
	Name         string `json:"name"`
	Pod          string `json:"pod,omitempty"`
	Container    string `json:"container,omitempty"`
	TailLines    int    `json:"tail_lines,omitempty"`
	Previous     bool   `json:"previous,omitempty"`
	Events       bool   `json:"events,omitempty"`
}

func (r StreamRequest) Key() string {
	return r.ConnectionID + "|" + r.Namespace + "|" + r.Kind + "|" + r.Name +
		"|pod=" + r.Pod + "|container=" + r.Container +
		"|tail=" + strconv.Itoa(r.TailLines) + "|previous=" + strconv.FormatBool(r.Previous) + "|events=" + strconv.FormatBool(r.Events)
}

type MetricRequest struct {
	ConnectionID    string `json:"connection_id"`
	Kind            string `json:"kind"`
	Namespace       string `json:"namespace,omitempty"`
	Name            string `json:"name"`
	IntervalSeconds int    `json:"interval_seconds,omitempty"`
}

func (r MetricRequest) Key() string {
	return r.ConnectionID + "|" + r.Namespace + "|" + r.Kind + "|" + r.Name +
		"|interval=" + strconv.Itoa(r.IntervalSeconds)
}

type ContainerMetric struct {
	Pod                  string   `json:"pod,omitempty"`
	Container            string   `json:"container"`
	CPUCores             float64  `json:"cpu_cores,omitempty"`
	CPUPercent           *float64 `json:"cpu_percent,omitempty"`
	MemoryBytes          int64    `json:"memory_bytes,omitempty"`
	MemoryLimitBytes     int64    `json:"memory_limit_bytes,omitempty"`
	NetworkReceiveBytes  int64    `json:"network_receive_bytes,omitempty"`
	NetworkTransmitBytes int64    `json:"network_transmit_bytes,omitempty"`
	BlockReadBytes       int64    `json:"block_read_bytes,omitempty"`
	BlockWriteBytes      int64    `json:"block_write_bytes,omitempty"`
	PIDs                 int64    `json:"pids,omitempty"`
}

type WorkloadMetric struct {
	Sequence             uint64            `json:"sequence,omitempty"`
	Timestamp            time.Time         `json:"timestamp"`
	ConnectionID         string            `json:"connection_id"`
	Connection           string            `json:"connection,omitempty"`
	Platform             string            `json:"platform"`
	Kind                 string            `json:"kind"`
	Namespace            string            `json:"namespace,omitempty"`
	Name                 string            `json:"name"`
	Source               string            `json:"source"`
	Error                string            `json:"error,omitempty"`
	CPUCores             float64           `json:"cpu_cores,omitempty"`
	CPUPercent           *float64          `json:"cpu_percent,omitempty"`
	MemoryBytes          int64             `json:"memory_bytes,omitempty"`
	MemoryLimitBytes     int64             `json:"memory_limit_bytes,omitempty"`
	NetworkReceiveBytes  int64             `json:"network_receive_bytes,omitempty"`
	NetworkTransmitBytes int64             `json:"network_transmit_bytes,omitempty"`
	BlockReadBytes       int64             `json:"block_read_bytes,omitempty"`
	BlockWriteBytes      int64             `json:"block_write_bytes,omitempty"`
	PIDs                 int64             `json:"pids,omitempty"`
	Containers           []ContainerMetric `json:"containers,omitempty"`
}

func (m WorkloadMetric) Key() string {
	return m.ConnectionID + "|" + m.Namespace + "|" + m.Kind + "|" + m.Name
}

type ActivityRecord struct {
	Sequence  uint64         `json:"sequence,omitempty"`
	Timestamp time.Time      `json:"timestamp"`
	Type      string         `json:"type"`
	Level     string         `json:"level,omitempty"`
	Message   string         `json:"message"`
	Source    string         `json:"source,omitempty"`
	Pod       string         `json:"pod,omitempty"`
	Container string         `json:"container,omitempty"`
	Fields    map[string]any `json:"fields,omitempty"`
}

type ProviderInfo struct {
	State   string            `json:"state"`
	Message string            `json:"message,omitempty"`
	Details map[string]string `json:"details,omitempty"`
}

type Inventory struct {
	Workloads    []Workload       `json:"workloads"`
	Namespaces   []string         `json:"namespaces,omitempty"`
	Metrics      []WorkloadMetric `json:"metrics,omitempty"`
	MetricsError string           `json:"metrics_error,omitempty"`
	ObservedAt   time.Time        `json:"observed_at"`
}
