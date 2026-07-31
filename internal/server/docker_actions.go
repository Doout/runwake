package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/provider"
)

var dockerContainerIDPattern = regexp.MustCompile(`^[a-f0-9]{12,64}$`)

type dockerComposeRestartRequest struct {
	Project        string `json:"project"`
	TimeoutSeconds *int   `json:"timeout_seconds,omitempty"`
}

func (s *Server) handleDockerContainerRestart(w http.ResponseWriter, r *http.Request) {
	controller, connection, ok := s.dockerController(w, r.PathValue("id"))
	if !ok {
		return
	}
	containerID := strings.ToLower(strings.TrimSpace(r.PathValue("container_id")))
	if !dockerContainerIDPattern.MatchString(containerID) {
		writeError(w, http.StatusBadRequest, "a valid Docker container ID is required")
		return
	}
	timeoutSeconds, err := dockerActionTimeout(r.URL.Query().Get("timeout_seconds"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSeconds+30)*time.Second)
	defer cancel()
	if err := controller.RestartContainer(ctx, containerID, timeoutSeconds); err != nil {
		writeError(w, http.StatusBadGateway, "restart container: "+err.Error())
		return
	}
	s.invalidateDockerRuntime(connection.ID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "restarted"})
}

func (s *Server) handleDockerContainerDelete(w http.ResponseWriter, r *http.Request) {
	controller, connection, ok := s.dockerController(w, r.PathValue("id"))
	if !ok {
		return
	}
	containerID := strings.ToLower(strings.TrimSpace(r.PathValue("container_id")))
	if !dockerContainerIDPattern.MatchString(containerID) {
		writeError(w, http.StatusBadRequest, "a valid Docker container ID is required")
		return
	}
	force := false
	if value := r.URL.Query().Get("force"); value != "" {
		var err error
		force, err = strconv.ParseBool(value)
		if err != nil {
			writeError(w, http.StatusBadRequest, "force must be true or false")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	if err := controller.DeleteContainer(ctx, containerID, force); err != nil {
		writeError(w, http.StatusBadGateway, "delete container: "+err.Error())
		return
	}
	s.invalidateDockerRuntime(connection.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDockerComposeRestart(w http.ResponseWriter, r *http.Request) {
	controller, connection, ok := s.dockerController(w, r.PathValue("id"))
	if !ok {
		return
	}
	var request dockerComposeRestartRequest
	if !decodeJSON(w, r, 16<<10, &request) {
		return
	}
	request.Project = strings.TrimSpace(request.Project)
	if request.Project == "" {
		writeError(w, http.StatusBadRequest, "Compose project is required")
		return
	}
	if len(request.Project) > 255 {
		writeError(w, http.StatusBadRequest, "Compose project cannot be longer than 255 characters")
		return
	}
	timeoutValue := ""
	if request.TimeoutSeconds != nil {
		timeoutValue = strconv.Itoa(*request.TimeoutSeconds)
	}
	timeoutSeconds, err := dockerActionTimeout(timeoutValue)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSeconds+45)*time.Second)
	defer cancel()
	restarted, err := controller.RestartComposeProject(ctx, request.Project, timeoutSeconds)
	if err != nil {
		writeError(w, http.StatusBadGateway, "restart Compose project: "+err.Error())
		return
	}
	s.invalidateDockerRuntime(connection.ID)
	writeJSON(w, http.StatusOK, map[string]any{"status": "restarted", "containers": restarted})
}

func (s *Server) dockerController(w http.ResponseWriter, connectionID string) (provider.DockerController, model.Connection, bool) {
	connection, ok := s.state.GetConnection(connectionID)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return nil, model.Connection{}, false
	}
	if connection.Kind != model.ConnectionDocker {
		writeError(w, http.StatusBadRequest, "runtime actions are only available for Docker connections")
		return nil, model.Connection{}, false
	}
	if !connection.CanManageDocker() {
		writeError(w, http.StatusForbidden, "Docker connection is read-only")
		return nil, model.Connection{}, false
	}
	runtimeProvider, err := s.factory.ProviderFor(connection)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return nil, model.Connection{}, false
	}
	controller, ok := runtimeProvider.(provider.DockerController)
	if !ok {
		writeError(w, http.StatusNotImplemented, "Docker runtime actions are not supported by this connection")
		return nil, model.Connection{}, false
	}
	return controller, connection, true
}

func (s *Server) invalidateDockerRuntime(connectionID string) {
	s.workloads.Delete(connectionID)
	s.metrics.InvalidateSnapshot(connectionID)
}

func dockerActionTimeout(value string) (int, error) {
	if value == "" {
		return 10, nil
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 0 || seconds > 300 {
		return 0, errors.New("timeout_seconds must be between 0 and 300")
	}
	return seconds, nil
}
