package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
)

type Store struct {
	mu          sync.RWMutex
	dir         string
	connections map[string]model.Connection
	sshProfiles map[string]model.SSHProfile
	settings    model.Settings
}

func Open(dir string, defaults model.Settings) (*Store, error) {
	if dir == "" {
		return nil, errors.New("data directory is required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	s := &Store{dir: dir, connections: map[string]model.Connection{}, sshProfiles: map[string]model.SSHProfile{}, settings: defaults}
	if err := s.loadConnections(); err != nil {
		return nil, err
	}
	if err := s.loadSSHProfiles(); err != nil {
		return nil, err
	}
	if err := s.loadSettings(); err != nil {
		return nil, err
	}
	return s, nil
}
func (s *Store) Dir() string { return s.dir }
func (s *Store) ListConnections() []model.Connection {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Connection, 0, len(s.connections))
	for _, c := range s.connections {
		out = append(out, cloneConnection(c))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
func (s *Store) GetConnection(id string) (model.Connection, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.connections[id]
	if !ok {
		return model.Connection{}, false
	}
	return cloneConnection(c), true
}
func (s *Store) SaveConnection(c model.Connection) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.ID == "" {
		return errors.New("connection ID is required")
	}
	now := time.Now().UTC()
	if c.CreatedAt.IsZero() {
		c.CreatedAt = now
	}
	c.UpdatedAt = now
	previous, existed := s.connections[c.ID]
	s.connections[c.ID] = cloneConnection(c)
	if err := s.writeConnectionsLocked(); err != nil {
		if existed {
			s.connections[c.ID] = previous
		} else {
			delete(s.connections, c.ID)
		}
		return err
	}
	return nil
}
func (s *Store) DeleteConnection(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, ok := s.connections[id]
	if !ok {
		return os.ErrNotExist
	}
	delete(s.connections, id)
	if err := s.writeConnectionsLocked(); err != nil {
		s.connections[id] = previous
		return err
	}
	return nil
}
func (s *Store) ListSSHProfiles() []model.SSHProfile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.SSHProfile, 0, len(s.sshProfiles))
	for _, profile := range s.sshProfiles {
		out = append(out, profile)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
func (s *Store) GetSSHProfile(id string) (model.SSHProfile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile, ok := s.sshProfiles[id]
	return profile, ok
}
func (s *Store) SaveSSHProfile(profile model.SSHProfile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if profile.ID == "" {
		return errors.New("SSH profile ID is required")
	}
	now := time.Now().UTC()
	if profile.CreatedAt.IsZero() {
		profile.CreatedAt = now
	}
	profile.UpdatedAt = now
	previous, existed := s.sshProfiles[profile.ID]
	s.sshProfiles[profile.ID] = profile
	if err := s.writeSSHProfilesLocked(); err != nil {
		if existed {
			s.sshProfiles[profile.ID] = previous
		} else {
			delete(s.sshProfiles, profile.ID)
		}
		return err
	}
	return nil
}
func (s *Store) DeleteSSHProfile(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, ok := s.sshProfiles[id]
	if !ok {
		return os.ErrNotExist
	}
	delete(s.sshProfiles, id)
	if err := s.writeSSHProfilesLocked(); err != nil {
		s.sshProfiles[id] = previous
		return err
	}
	return nil
}
func (s *Store) Settings() model.Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneSettings(s.settings)
}
func (s *Store) SaveSettings(settings model.Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	settings = cloneSettings(settings)
	previous := s.settings
	s.settings = settings
	if err := writeJSONAtomic(filepath.Join(s.dir, "settings.json"), settings, 0o600); err != nil {
		s.settings = previous
		return err
	}
	return nil
}
func (s *Store) loadConnections() error {
	data, err := os.ReadFile(filepath.Join(s.dir, "connections.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read connections: %w", err)
	}
	var values []model.Connection
	if err := json.Unmarshal(data, &values); err != nil {
		return fmt.Errorf("decode connections: %w", err)
	}
	for _, c := range values {
		s.connections[c.ID] = c
	}
	return nil
}
func (s *Store) loadSettings() error {
	data, err := os.ReadFile(filepath.Join(s.dir, "settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read settings: %w", err)
	}
	var settings model.Settings
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("decode settings: %w", err)
	}
	defaults := s.settings
	if settings.DefaultTailLines == 0 {
		settings.DefaultTailLines = defaults.DefaultTailLines
	}
	if settings.KubectlPath == "" {
		settings.KubectlPath = defaults.KubectlPath
	}
	if settings.ExecPluginPolicy == "" {
		settings.ExecPluginPolicy = defaults.ExecPluginPolicy
	}
	if len(settings.ExecPluginAllowlist) == 0 {
		settings.ExecPluginAllowlist = append([]string(nil), defaults.ExecPluginAllowlist...)
	}
	if settings.DefaultAgentImage == "" {
		settings.DefaultAgentImage = defaults.DefaultAgentImage
	}
	if settings.OverviewMetricsIntervalSeconds <= 0 {
		settings.OverviewMetricsIntervalSeconds = defaults.OverviewMetricsIntervalSeconds
	}
	if settings.SelectedMetricsIntervalSeconds <= 0 {
		settings.SelectedMetricsIntervalSeconds = defaults.SelectedMetricsIntervalSeconds
	}
	s.settings = settings
	return nil
}
func (s *Store) loadSSHProfiles() error {
	data, err := os.ReadFile(filepath.Join(s.dir, "ssh_profiles.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read SSH profiles: %w", err)
	}
	var values []model.SSHProfile
	if err := json.Unmarshal(data, &values); err != nil {
		return fmt.Errorf("decode SSH profiles: %w", err)
	}
	for _, profile := range values {
		s.sshProfiles[profile.ID] = profile
	}
	return nil
}
func (s *Store) writeConnectionsLocked() error {
	values := make([]model.Connection, 0, len(s.connections))
	for _, c := range s.connections {
		values = append(values, c)
	}
	sort.Slice(values, func(i, j int) bool { return values[i].Name < values[j].Name })
	return writeJSONAtomic(filepath.Join(s.dir, "connections.json"), values, 0o600)
}
func (s *Store) writeSSHProfilesLocked() error {
	values := make([]model.SSHProfile, 0, len(s.sshProfiles))
	for _, profile := range s.sshProfiles {
		values = append(values, profile)
	}
	sort.Slice(values, func(i, j int) bool { return values[i].Name < values[j].Name })
	return writeJSONAtomic(filepath.Join(s.dir, "ssh_profiles.json"), values, 0o600)
}
func writeJSONAtomic(path string, value any, mode os.FileMode) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func cloneSettings(settings model.Settings) model.Settings {
	out := settings
	out.ExecPluginAllowlist = append([]string(nil), settings.ExecPluginAllowlist...)
	return out
}

func cloneConnection(connection model.Connection) model.Connection {
	out := connection
	if connection.Kubernetes != nil {
		value := *connection.Kubernetes
		value.Namespaces = append([]string(nil), connection.Kubernetes.Namespaces...)
		value.ExecAllowlist = append([]string(nil), connection.Kubernetes.ExecAllowlist...)
		out.Kubernetes = &value
	}
	if connection.Docker != nil {
		value := *connection.Docker
		out.Docker = &value
	}
	if connection.Agent != nil {
		value := *connection.Agent
		value.Namespaces = append([]string(nil), connection.Agent.Namespaces...)
		if connection.Agent.Metadata != nil {
			value.Metadata = make(map[string]string, len(connection.Agent.Metadata))
			maps.Copy(value.Metadata, connection.Agent.Metadata)
		}
		out.Agent = &value
	}
	if connection.SSH != nil {
		value := *connection.SSH
		out.SSH = &value
	}
	if connection.HTTPProxy != nil {
		value := *connection.HTTPProxy
		value.NoProxy = append([]string(nil), connection.HTTPProxy.NoProxy...)
		out.HTTPProxy = &value
	}
	if connection.Deployment != nil {
		value := *connection.Deployment
		value.Namespaces = append([]string(nil), connection.Deployment.Namespaces...)
		out.Deployment = &value
	}
	return out
}

func (s *Store) UpdateConnection(connection model.Connection) error {
	if _, ok := s.GetConnection(connection.ID); !ok {
		return os.ErrNotExist
	}
	return s.SaveConnection(connection)
}
