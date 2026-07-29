package kube

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/proxyx"
	"github.com/Doout/runwake/internal/store"
	"gopkg.in/yaml.v3"
)

type kubeconfigFile struct {
	CurrentContext string `yaml:"current-context" json:"current-context"`
	Clusters       []struct {
		Name    string            `yaml:"name" json:"name"`
		Cluster kubeconfigCluster `yaml:"cluster" json:"cluster"`
	} `yaml:"clusters" json:"clusters"`
	Contexts []struct {
		Name    string            `yaml:"name" json:"name"`
		Context kubeconfigContext `yaml:"context" json:"context"`
	} `yaml:"contexts" json:"contexts"`
	Users []struct {
		Name string         `yaml:"name" json:"name"`
		User kubeconfigUser `yaml:"user" json:"user"`
	} `yaml:"users" json:"users"`
}

type kubeconfigCluster struct {
	Server                   string `yaml:"server" json:"server"`
	TLSServerName            string `yaml:"tls-server-name,omitempty" json:"tls-server-name,omitempty"`
	InsecureSkipTLSVerify    bool   `yaml:"insecure-skip-tls-verify,omitempty" json:"insecure-skip-tls-verify,omitempty"`
	CertificateAuthority     string `yaml:"certificate-authority,omitempty" json:"certificate-authority,omitempty"`
	CertificateAuthorityData string `yaml:"certificate-authority-data,omitempty" json:"certificate-authority-data,omitempty"`
	ProxyURL                 string `yaml:"proxy-url,omitempty" json:"proxy-url,omitempty"`
}

type kubeconfigContext struct {
	Cluster   string `yaml:"cluster" json:"cluster"`
	User      string `yaml:"user" json:"user"`
	Namespace string `yaml:"namespace,omitempty" json:"namespace,omitempty"`
}

type kubeconfigUser struct {
	Token                 string          `yaml:"token,omitempty" json:"token,omitempty"`
	TokenFile             string          `yaml:"tokenFile,omitempty" json:"tokenFile,omitempty"`
	Username              string          `yaml:"username,omitempty" json:"username,omitempty"`
	Password              string          `yaml:"password,omitempty" json:"password,omitempty"`
	ClientCertificate     string          `yaml:"client-certificate,omitempty" json:"client-certificate,omitempty"`
	ClientCertificateData string          `yaml:"client-certificate-data,omitempty" json:"client-certificate-data,omitempty"`
	ClientKey             string          `yaml:"client-key,omitempty" json:"client-key,omitempty"`
	ClientKeyData         string          `yaml:"client-key-data,omitempty" json:"client-key-data,omitempty"`
	Exec                  *kubeconfigExec `yaml:"exec,omitempty" json:"exec,omitempty"`
	AuthProvider          *struct {
		Name   string            `yaml:"name" json:"name"`
		Config map[string]string `yaml:"config" json:"config"`
	} `yaml:"auth-provider,omitempty" json:"auth-provider,omitempty"`
}

type kubeconfigExec struct {
	Command string `yaml:"command" json:"command"`
}

func NewKubeconfigProvider(connection model.Connection, secrets *store.SecretStore, settings func() model.Settings) (*InClusterProvider, error) {
	if connection.Kubernetes == nil {
		return nil, errors.New("missing Kubernetes connection configuration")
	}
	cfg := connection.Kubernetes
	var (
		data    []byte
		baseDir string
		err     error
	)
	switch cfg.KubeconfigSource {
	case "stored":
		if secrets == nil {
			return nil, errors.New("kubeconfig secret store is not configured")
		}
		data, err = secrets.Get(cfg.KubeconfigSecret)
	default:
		path := expandUserPath(strings.TrimSpace(cfg.KubeconfigPath))
		if path == "" {
			return nil, errors.New("kubeconfig path or stored kubeconfig is required")
		}
		data, err = os.ReadFile(path) //nolint:gosec // The kubeconfig path is explicitly selected by the user.
		baseDir = filepath.Dir(path)
	}
	if err != nil {
		return nil, fmt.Errorf("read kubeconfig: %w", err)
	}
	parsed, err := parseKubeconfig(data, cfg.Context)
	if err != nil {
		return nil, err
	}
	policy := cfg.ExecPolicy
	if policy == "" {
		policy = settings().ExecPluginPolicy
	}
	allowlist := cfg.ExecAllowlist
	if len(allowlist) == 0 {
		allowlist = settings().ExecPluginAllowlist
	}
	if policyErr := validateKubeconfigExec(parsed.userName, parsed.user.Exec, policy, allowlist); policyErr != nil {
		return nil, policyErr
	}
	if parsed.user.Exec != nil {
		return nil, fmt.Errorf("kubeconfig user %q requires exec credential plugin %q; direct API connections do not execute external credential binaries", parsed.userName, parsed.user.Exec.Command)
	}

	rootCAs, err := kubeconfigRootCAs(parsed.cluster, baseDir)
	if err != nil {
		return nil, err
	}
	certificates := make([]tls.Certificate, 0, 1)
	certPEM, err := kubeconfigData(parsed.user.ClientCertificateData, parsed.user.ClientCertificate, baseDir)
	if err != nil {
		return nil, fmt.Errorf("read kubeconfig client certificate: %w", err)
	}
	keyPEM, err := kubeconfigData(parsed.user.ClientKeyData, parsed.user.ClientKey, baseDir)
	if err != nil {
		return nil, fmt.Errorf("read kubeconfig client key: %w", err)
	}
	if len(certPEM) != 0 || len(keyPEM) != 0 {
		if len(certPEM) == 0 || len(keyPEM) == 0 {
			return nil, errors.New("kubeconfig must provide both client certificate and client key")
		}
		certificate, certErr := tls.X509KeyPair(certPEM, keyPEM)
		if certErr != nil {
			return nil, fmt.Errorf("load kubeconfig client certificate: %w", certErr)
		}
		certificates = append(certificates, certificate)
	}
	token := strings.TrimSpace(parsed.user.Token)
	if token == "" && parsed.user.TokenFile != "" {
		tokenData, readErr := os.ReadFile(resolveKubeconfigPath(baseDir, parsed.user.TokenFile))
		if readErr != nil {
			return nil, fmt.Errorf("read kubeconfig token file: %w", readErr)
		}
		token = strings.TrimSpace(string(tokenData))
	}
	if token == "" && parsed.user.AuthProvider != nil {
		token = strings.TrimSpace(parsed.user.AuthProvider.Config["access-token"])
	}
	authentication := "anonymous"
	switch {
	case token != "":
		authentication = "bearer-token"
	case len(certificates) != 0:
		authentication = "client-certificate"
	case parsed.user.Username != "":
		authentication = "basic"
	}

	proxy := http.ProxyFromEnvironment
	if parsed.cluster.ProxyURL != "" {
		proxyURL, parseErr := url.Parse(parsed.cluster.ProxyURL)
		if parseErr != nil {
			return nil, fmt.Errorf("parse kubeconfig proxy URL: %w", parseErr)
		}
		proxy = http.ProxyURL(proxyURL)
	}
	if connection.HTTPProxy != nil {
		proxyConfig, loadErr := proxyx.Load(connection.HTTPProxy, secrets)
		if loadErr != nil {
			return nil, loadErr
		}
		proxyURL, parseErr := url.Parse(proxyConfig.URL)
		if parseErr != nil {
			return nil, fmt.Errorf("parse configured proxy URL: %w", parseErr)
		}
		proxy = http.ProxyURL(proxyURL)
	}
	transport := &http.Transport{
		Proxy: proxy,
		TLSClientConfig: &tls.Config{
			MinVersion:         tls.VersionTLS12,
			RootCAs:            rootCAs,
			Certificates:       certificates,
			ServerName:         parsed.cluster.TLSServerName,
			InsecureSkipVerify: parsed.cluster.InsecureSkipTLSVerify, //nolint:gosec // Explicit kubeconfig setting controlled by the user.
		},
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
	}
	namespaces := append([]string(nil), cfg.Namespaces...)
	if cfg.NamespaceMode != "selected" {
		namespaces = nil
	}
	tailLines := settings().DefaultTailLines
	if tailLines <= 0 {
		tailLines = 200
	}
	return &InClusterProvider{
		connectionID: connection.ID, connectionName: connection.Name,
		baseURL: strings.TrimRight(parsed.cluster.Server, "/"),
		token:   token, username: parsed.user.Username, password: parsed.user.Password,
		authentication: authentication,
		client:         &http.Client{Transport: transport}, namespaces: namespaces, tailLines: tailLines,
	}, nil
}

type selectedKubeconfig struct {
	cluster  kubeconfigCluster
	user     kubeconfigUser
	userName string
}

func parseKubeconfig(data []byte, contextName string) (selectedKubeconfig, error) {
	var config kubeconfigFile
	if err := yaml.Unmarshal(data, &config); err != nil {
		return selectedKubeconfig{}, fmt.Errorf("decode kubeconfig: %w", err)
	}
	if contextName == "" {
		contextName = config.CurrentContext
	}
	var selectedContext *kubeconfigContext
	for index := range config.Contexts {
		if config.Contexts[index].Name == contextName {
			selectedContext = &config.Contexts[index].Context
			break
		}
	}
	if selectedContext == nil {
		return selectedKubeconfig{}, fmt.Errorf("kubeconfig context %q was not found", contextName)
	}
	var selected selectedKubeconfig
	for _, item := range config.Clusters {
		if item.Name == selectedContext.Cluster {
			selected.cluster = item.Cluster
			break
		}
	}
	if selected.cluster.Server == "" {
		return selectedKubeconfig{}, fmt.Errorf("kubeconfig cluster %q was not found or has no server", selectedContext.Cluster)
	}
	selected.userName = selectedContext.User
	for _, item := range config.Users {
		if item.Name == selectedContext.User {
			selected.user = item.User
			return selected, nil
		}
	}
	if selectedContext.User == "" {
		return selected, nil
	}
	return selectedKubeconfig{}, fmt.Errorf("kubeconfig user %q was not found", selectedContext.User)
}

func validateKubeconfigExec(user string, plugin *kubeconfigExec, policy string, allowlist []string) error {
	if plugin == nil || plugin.Command == "" {
		return nil
	}
	switch policy {
	case "allow":
		return nil
	case "deny", "":
		return fmt.Errorf("kubeconfig user %q requires exec credential plugin %q, but exec plugins are disabled", user, plugin.Command)
	case "allowlist":
		for _, allowed := range allowlist {
			if allowed == plugin.Command || filepath.Base(allowed) == filepath.Base(plugin.Command) {
				return nil
			}
		}
		return fmt.Errorf("kubeconfig user %q requires exec credential plugin %q, which is not in the configured allowlist", user, plugin.Command)
	default:
		return fmt.Errorf("invalid exec plugin policy %q", policy)
	}
}

func kubeconfigRootCAs(cluster kubeconfigCluster, baseDir string) (*x509.CertPool, error) {
	if cluster.InsecureSkipTLSVerify {
		return nil, nil
	}
	caPEM, err := kubeconfigData(cluster.CertificateAuthorityData, cluster.CertificateAuthority, baseDir)
	if err != nil {
		return nil, fmt.Errorf("read kubeconfig certificate authority: %w", err)
	}
	if len(caPEM) == 0 {
		return nil, nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("kubeconfig certificate authority does not contain a valid certificate")
	}
	return pool, nil
}

func kubeconfigData(encoded, path, baseDir string) ([]byte, error) {
	if encoded != "" {
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("decode base64 data: %w", err)
		}
		return data, nil
	}
	if path == "" {
		return nil, nil
	}
	return os.ReadFile(resolveKubeconfigPath(baseDir, path))
}

func resolveKubeconfigPath(baseDir, path string) string {
	path = expandUserPath(path)
	if filepath.IsAbs(path) || baseDir == "" {
		return path
	}
	return filepath.Join(baseDir, path)
}

func FlattenKubeconfig(source []byte, contextName string, policy string, allowlist []string) ([]byte, error) {
	selected, err := parseKubeconfig(source, contextName)
	if err != nil {
		return nil, err
	}
	if policyErr := validateKubeconfigExec(selected.userName, selected.user.Exec, policy, allowlist); policyErr != nil {
		return nil, policyErr
	}
	cluster := selected.cluster
	user := selected.user
	cluster.CertificateAuthorityData, err = inlineKubeconfigData(cluster.CertificateAuthorityData, cluster.CertificateAuthority)
	if err != nil {
		return nil, fmt.Errorf("inline kubeconfig certificate authority: %w", err)
	}
	cluster.CertificateAuthority = ""
	user.ClientCertificateData, err = inlineKubeconfigData(user.ClientCertificateData, user.ClientCertificate)
	if err != nil {
		return nil, fmt.Errorf("inline kubeconfig client certificate: %w", err)
	}
	user.ClientCertificate = ""
	user.ClientKeyData, err = inlineKubeconfigData(user.ClientKeyData, user.ClientKey)
	if err != nil {
		return nil, fmt.Errorf("inline kubeconfig client key: %w", err)
	}
	user.ClientKey = ""
	if user.Token == "" && user.TokenFile != "" {
		token, readErr := os.ReadFile(expandUserPath(user.TokenFile))
		if readErr != nil {
			return nil, fmt.Errorf("inline kubeconfig token: %w", readErr)
		}
		user.Token = strings.TrimSpace(string(token))
		user.TokenFile = ""
	}
	flattened := map[string]any{
		"apiVersion":      "v1",
		"kind":            "Config",
		"current-context": "runwake",
		"clusters":        []any{map[string]any{"name": "runwake", "cluster": cluster}},
		"contexts":        []any{map[string]any{"name": "runwake", "context": kubeconfigContext{Cluster: "runwake", User: "runwake"}}},
		"users":           []any{map[string]any{"name": "runwake", "user": user}},
	}
	return json.Marshal(flattened)
}

func inlineKubeconfigData(encoded, path string) (string, error) {
	if encoded != "" || path == "" {
		return encoded, nil
	}
	data, err := os.ReadFile(expandUserPath(path))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}
