package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/store"
)

type sshProfileRequest struct {
	Name string `json:"name"`
	sshConnectionBody
}

func (s *Server) handleSSHProfilesList(w http.ResponseWriter, _ *http.Request) {
	profiles := s.state.ListSSHProfiles()
	out := make([]model.SSHProfile, 0, len(profiles))
	for _, profile := range profiles {
		out = append(out, profile.Redacted())
	}
	writeJSON(w, http.StatusOK, map[string]any{"ssh_profiles": out})
}

func (s *Server) handleSSHProfileCreate(w http.ResponseWriter, r *http.Request) {
	var request sshProfileRequest
	if !decodeJSON(w, r, 2<<20, &request) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		writeError(w, http.StatusBadRequest, "SSH profile name is required")
		return
	}
	config, err := sshConfigFromBody(&request.sshConnectionBody)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	profile := model.SSHProfile{
		ID: store.NewID("ssh_profile"), Name: request.Name, Host: config.Host, Port: config.Port,
		User: config.User, KnownHostsPath: config.KnownHostsPath,
		HostKeyPolicy: config.HostKeyPolicy, ProxyJump: config.ProxyJump,
	}
	if len(config.PrivateKey) > 0 {
		profile.PrivateKeySecret, err = s.secrets.Put(config.PrivateKey)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if err := s.state.SaveSSHProfile(profile); err != nil {
		_ = s.secrets.Delete(profile.PrivateKeySecret)
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	saved, _ := s.state.GetSSHProfile(profile.ID)
	writeJSON(w, http.StatusCreated, saved.Redacted())
}

func (s *Server) handleSSHProfileDelete(w http.ResponseWriter, r *http.Request) {
	profile, ok := s.state.GetSSHProfile(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "SSH profile not found")
		return
	}
	if err := s.state.DeleteSSHProfile(profile.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = s.secrets.Delete(profile.PrivateKeySecret)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSSHProfileTest(w http.ResponseWriter, r *http.Request) {
	profile, ok := s.state.GetSSHProfile(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "SSH profile not found")
		return
	}
	body, err := s.sshBodyFromProfile(profile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	config, err := sshConfigFromBody(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if _, _, err := config.Run(ctx, nil, nil, "true"); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, model.ProviderInfo{
		State: "connected", Message: "SSH profile is ready",
		Details: map[string]string{"target": config.DisplayURL()},
	})
}

func (s *Server) resolveSSHBody(profileID string, inline *sshConnectionBody) (*sshConnectionBody, error) {
	profileID = strings.TrimSpace(profileID)
	if profileID != "" && inline != nil {
		return nil, errors.New("choose an SSH profile or provide SSH configuration, not both")
	}
	if profileID == "" {
		return inline, nil
	}
	profile, ok := s.state.GetSSHProfile(profileID)
	if !ok {
		return nil, errors.New("SSH profile not found")
	}
	return s.sshBodyFromProfile(profile)
}

func (s *Server) sshBodyFromProfile(profile model.SSHProfile) (*sshConnectionBody, error) {
	body := &sshConnectionBody{
		Host: profile.Host, Port: profile.Port, User: profile.User,
		KnownHostsPath: profile.KnownHostsPath, HostKeyPolicy: profile.HostKeyPolicy,
		ProxyJump: profile.ProxyJump,
	}
	if profile.PrivateKeySecret == "" {
		return body, nil
	}
	value, err := s.secrets.Get(profile.PrivateKeySecret)
	if err != nil {
		return nil, err
	}
	body.PrivateKey = string(value)
	return body, nil
}
