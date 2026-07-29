package provider

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/Doout/runwake/internal/dockerapi"
	"github.com/Doout/runwake/internal/kube"
	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/proxyx"
	"github.com/Doout/runwake/internal/sshx"
	"github.com/Doout/runwake/internal/store"
)

type DirectFactory struct {
	Secrets  *store.SecretStore
	Settings func() model.Settings
	Agents   AgentProviderFactory
}

type AgentProviderFactory interface {
	ProviderForAgent(connection model.Connection) (Provider, error)
}

func (f *DirectFactory) ProviderFor(connection model.Connection) (Provider, error) {
	if connection.Mode == model.ModeAgent {
		if f.Agents == nil {
			return nil, errors.New("agent provider is not configured")
		}
		return f.Agents.ProviderForAgent(connection)
	}
	switch connection.Kind {
	case model.ConnectionKubernetes:
		if connection.SSH != nil {
			return kube.NewKubectlProvider(connection, f.Secrets, f.Settings), nil
		}
		return kube.NewKubeconfigProvider(connection, f.Secrets, f.Settings)
	case model.ConnectionDocker:
		return newDockerProvider(connection, f.Secrets)
	default:
		return nil, Unsupported(connection)
	}
}

type dockerProvider struct {
	connection model.Connection
	client     *dockerapi.Client
}

func NewDockerProvider(connection model.Connection, secrets *store.SecretStore) (Provider, error) {
	return newDockerProvider(connection, secrets)
}

func newDockerProvider(connection model.Connection, secrets *store.SecretStore) (*dockerProvider, error) {
	if connection.Docker == nil {
		return nil, errors.New("missing Docker connection configuration")
	}
	material := dockerapi.TLSMaterial{ServerName: connection.Docker.TLSServerName}
	var err error
	if connection.Docker.TLSCASecret != "" {
		if secrets == nil {
			return nil, errors.New("docker CA secret store is not configured")
		}
		material.CA, err = secrets.Get(connection.Docker.TLSCASecret)
		if err != nil {
			return nil, fmt.Errorf("read Docker CA: %w", err)
		}
	}
	if connection.Docker.TLSCertSecret != "" {
		if secrets == nil {
			return nil, errors.New("docker client certificate secret store is not configured")
		}
		material.Cert, err = secrets.Get(connection.Docker.TLSCertSecret)
		if err != nil {
			return nil, fmt.Errorf("read Docker client certificate: %w", err)
		}
	}
	if connection.Docker.TLSKeySecret != "" {
		if secrets == nil {
			return nil, errors.New("docker client key secret store is not configured")
		}
		material.Key, err = secrets.Get(connection.Docker.TLSKeySecret)
		if err != nil {
			return nil, fmt.Errorf("read Docker client key: %w", err)
		}
	}
	var client *dockerapi.Client
	var proxyConfig proxyx.Config
	var proxyEnvironment map[string]string
	if connection.HTTPProxy != nil {
		proxyConfig, err = proxyx.Load(connection.HTTPProxy, secrets)
		if err != nil {
			return nil, err
		}
		proxyEnvironment = proxyConfig.Environment()
	}
	if connection.SSH != nil {
		sshConfig, loadErr := sshx.Load(connection.SSH, secrets)
		if loadErr != nil {
			return nil, loadErr
		}
		client, err = dockerapi.NewWithDialer(sshConfig.DisplayURL(), sshConfig.DockerDialerWithEnvironment(connection.Docker.Endpoint, proxyEnvironment))
	} else if connection.HTTPProxy != nil {
		client, err = dockerapi.NewWithProxy(connection.Docker.Endpoint, material, proxyConfig.URL)
	} else {
		client, err = dockerapi.New(connection.Docker.Endpoint, material)
	}
	if err != nil {
		return nil, err
	}
	return &dockerProvider{connection: connection, client: client}, nil
}

func (p *dockerProvider) Test(ctx context.Context) (model.ProviderInfo, error) {
	version, err := p.client.Negotiate(ctx)
	if err != nil {
		return model.ProviderInfo{}, err
	}
	return model.ProviderInfo{
		State: "connected",
		Details: map[string]string{
			"engine":      version.Version,
			"api_version": version.APIVersion,
			"os":          version.OS,
			"arch":        version.Arch,
			"endpoint":    p.client.Endpoint(),
		},
	}, nil
}

func (p *dockerProvider) Namespaces(context.Context) ([]string, error) {
	return nil, nil
}

func (p *dockerProvider) ListWorkloads(ctx context.Context) ([]model.Workload, error) {
	return p.client.ListWorkloads(ctx, p.connection.ID, p.connection.Name)
}

func (p *dockerProvider) StreamWorkloads(ctx context.Context, out chan<- model.Workload) error {
	return p.client.StreamWorkloads(ctx, p.connection.ID, p.connection.Name, out)
}

func (p *dockerProvider) ListMetrics(ctx context.Context) ([]model.WorkloadMetric, error) {
	return p.client.ListMetrics(ctx, p.connection.ID, p.connection.Name)
}

func (p *dockerProvider) Stream(ctx context.Context, request model.StreamRequest, out chan<- model.ActivityRecord) error {
	return p.client.StreamContainer(ctx, request, out)
}

func (p *dockerProvider) StreamMetrics(ctx context.Context, request model.MetricRequest, out chan<- model.WorkloadMetric) error {
	return p.client.StreamMetrics(ctx, request, p.connection.Name, out)
}

func UniqueNamespaces(workloads []model.Workload) []string {
	seen := map[string]bool{}
	for _, workload := range workloads {
		if workload.Namespace != "" {
			seen[workload.Namespace] = true
		}
	}
	out := make([]string, 0, len(seen))
	for namespace := range seen {
		out = append(out, namespace)
	}
	sort.Strings(out)
	return out
}

// NewDockerRuntimeProvider creates a Docker provider for the remote agent.
// It accepts already-loaded TLS material because the agent reads secrets from
// its local filesystem or environment rather than Runwake's encrypted store.
func NewDockerRuntimeProvider(connectionID, name, endpoint string, material dockerapi.TLSMaterial) (Provider, error) {
	if endpoint == "" {
		endpoint = "unix:///var/run/docker.sock"
	}
	client, err := dockerapi.New(endpoint, material)
	if err != nil {
		return nil, err
	}
	return &dockerProvider{
		connection: model.Connection{ID: connectionID, Name: name, Kind: model.ConnectionDocker, Mode: model.ModeAgent},
		client:     client,
	}, nil
}
