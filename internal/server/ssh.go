package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/sshx"
)

type sshTestRequest struct {
	SSH                  *sshConnectionBody `json:"ssh"`
	SSHProfileID         string             `json:"ssh_profile_id,omitempty"`
	Kind                 string             `json:"kind"`
	RemoteKubeconfigPath string             `json:"remote_kubeconfig_path,omitempty"`
	RemoteKubectlPath    string             `json:"remote_kubectl_path,omitempty"`
	DockerSocketPath     string             `json:"docker_socket_path,omitempty"`
}

func (s *Server) handleSSHTest(w http.ResponseWriter, r *http.Request) {
	var request sshTestRequest
	if !decodeJSON(w, r, 2<<20, &request) {
		return
	}
	body, err := s.resolveSSHBody(request.SSHProfileID, request.SSH)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	config, err := sshConfigFromBody(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	details := map[string]string{"target": config.DisplayURL()}
	switch strings.ToLower(strings.TrimSpace(request.Kind)) {
	case model.ConnectionKubernetes:
		binary := strings.TrimSpace(request.RemoteKubectlPath)
		if binary == "" {
			binary = "kubectl"
		}
		kubeconfig := sshx.NormalizeRemotePath(request.RemoteKubeconfigPath, ".kube/config")
		stdout, _, runErr := config.Run(ctx, nil, nil, binary, "--kubeconfig", kubeconfig, "version", "-o", "json")
		if runErr != nil {
			writeError(w, http.StatusBadGateway, runErr.Error())
			return
		}
		details["runtime"] = "Kubernetes"
		if len(stdout) > 0 {
			details["kubectl"] = binary
		}
	case model.ConnectionDocker:
		socket := sshx.NormalizeRemotePath(request.DockerSocketPath, "/var/run/docker.sock")
		if !strings.HasPrefix(socket, "/") {
			writeError(w, http.StatusBadRequest, "remote Docker socket path must be absolute")
			return
		}
		stdout, _, runErr := config.Run(ctx, nil, map[string]string{"DOCKER_HOST": "unix://" + socket}, "docker", "version", "--format", "{{.Server.Version}}")
		if runErr != nil {
			writeError(w, http.StatusBadGateway, runErr.Error())
			return
		}
		version := strings.TrimSpace(string(stdout))
		details["runtime"] = "Docker"
		details["socket"] = socket
		if version != "" {
			details["server_version"] = version
		}
	default:
		writeError(w, http.StatusBadRequest, errors.New("SSH target kind must be kubernetes or docker").Error())
		return
	}
	writeJSON(w, http.StatusOK, model.ProviderInfo{State: "connected", Message: "SSH target is ready", Details: details})
}
