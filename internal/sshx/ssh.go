package sshx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/store"
)

type Config struct {
	Host           string
	Port           int
	User           string
	PrivateKey     []byte
	KnownHostsPath string
	HostKeyPolicy  string
	ProxyJump      string
}

func Load(value *model.SSHConnection, secrets *store.SecretStore) (Config, error) {
	if value == nil {
		return Config{}, errors.New("SSH configuration is required")
	}
	config := Config{
		Host:           value.Host,
		Port:           value.Port,
		User:           value.User,
		KnownHostsPath: value.KnownHostsPath,
		HostKeyPolicy:  value.HostKeyPolicy,
		ProxyJump:      value.ProxyJump,
	}
	if value.PrivateKeySecret != "" {
		if secrets == nil {
			return Config{}, errors.New("SSH secret store is not configured")
		}
		key, err := secrets.Get(value.PrivateKeySecret)
		if err != nil {
			return Config{}, fmt.Errorf("read SSH private key: %w", err)
		}
		config.PrivateKey = key
	}
	return config, config.Validate()
}

func (c Config) Validate() error {
	c.Host = strings.TrimSpace(c.Host)
	c.User = strings.TrimSpace(c.User)
	if c.Host == "" {
		return errors.New("SSH host is required")
	}
	for label, value := range map[string]string{"host": c.Host, "user": c.User, "proxy jump": c.ProxyJump} {
		if strings.ContainsAny(value, "\r\n\x00") {
			return fmt.Errorf("SSH %s contains an invalid character", label)
		}
	}
	if strings.HasPrefix(c.Host, "-") || strings.HasPrefix(c.User, "-") {
		return errors.New("SSH host and user cannot start with a dash")
	}
	if c.Port < 0 || c.Port > 65535 {
		return errors.New("SSH port must be between 1 and 65535")
	}
	switch c.HostKeyPolicy {
	case "", "strict", "accept-new":
	default:
		return errors.New("SSH host key policy must be strict or accept-new")
	}
	if len(c.PrivateKey) > 1024*1024 {
		return errors.New("SSH private key is larger than 1 MiB")
	}
	return nil
}

func (c Config) Target() string {
	host := strings.TrimSpace(c.Host)
	if user := strings.TrimSpace(c.User); user != "" {
		return user + "@" + host
	}
	return host
}

func (c Config) DisplayURL() string {
	target := c.Target()
	if c.Port > 0 && c.Port != 22 {
		target += ":" + strconv.Itoa(c.Port)
	}
	return "ssh://" + target
}

func (c Config) Command(ctx context.Context, environment map[string]string, remoteArgs ...string) (*exec.Cmd, func(), error) {
	if err := c.Validate(); err != nil {
		return nil, nil, err
	}
	binary, err := exec.LookPath("ssh")
	if err != nil {
		return nil, nil, errors.New("ssh was not found; install OpenSSH or add it to PATH")
	}
	args := []string{
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=2",
	}
	policy := c.HostKeyPolicy
	if policy == "" {
		policy = "accept-new"
	}
	args = append(args, "-o", "StrictHostKeyChecking="+policy)
	if c.Port > 0 && c.Port != 22 {
		args = append(args, "-p", strconv.Itoa(c.Port))
	}
	if path := strings.TrimSpace(c.KnownHostsPath); path != "" {
		args = append(args, "-o", "UserKnownHostsFile="+expandUserPath(path))
	}
	if jump := strings.TrimSpace(c.ProxyJump); jump != "" {
		args = append(args, "-J", jump)
	}
	cleanup := func() {}
	if len(c.PrivateKey) > 0 {
		file, createErr := os.CreateTemp("", "runwake-ssh-key-*")
		if createErr != nil {
			return nil, nil, fmt.Errorf("materialize SSH private key: %w", createErr)
		}
		path := file.Name()
		cleanup = func() { _ = os.Remove(path) }
		if chmodErr := file.Chmod(0o600); chmodErr != nil {
			_ = file.Close()
			cleanup()
			return nil, nil, chmodErr
		}
		if _, writeErr := file.Write(c.PrivateKey); writeErr != nil {
			_ = file.Close()
			cleanup()
			return nil, nil, writeErr
		}
		if closeErr := file.Close(); closeErr != nil {
			cleanup()
			return nil, nil, closeErr
		}
		args = append(args, "-o", "IdentitiesOnly=yes", "-i", path)
	}
	command := remoteCommand(environment, remoteArgs)
	args = append(args, "--", c.Target(), command)
	return exec.CommandContext(ctx, binary, args...), cleanup, nil //nolint:gosec // binary is resolved with exec.LookPath and arguments bypass a local shell.
}

func (c Config) Run(ctx context.Context, stdin []byte, environment map[string]string, remoteArgs ...string) ([]byte, []byte, error) {
	cmd, cleanup, err := c.Command(ctx, environment, remoteArgs...)
	if err != nil {
		return nil, nil, err
	}
	defer cleanup()
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return stdout.Bytes(), stderr.Bytes(), fmt.Errorf("SSH command failed: %s", message)
	}
	return stdout.Bytes(), stderr.Bytes(), nil
}

func (c Config) RunShell(ctx context.Context, stdin []byte, command string) ([]byte, []byte, error) {
	return c.Run(ctx, stdin, nil, "sh", "-lc", command)
}

func (c Config) DockerDialer(socketPath string) func(context.Context, string, string) (net.Conn, error) {
	return c.DockerDialerWithEnvironment(socketPath, nil)
}

func (c Config) DockerDialerWithEnvironment(endpoint string, environment map[string]string) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, _, _ string) (net.Conn, error) {
		host := strings.TrimSpace(endpoint)
		if host == "" {
			host = "unix:///var/run/docker.sock"
		} else if strings.HasPrefix(host, "/") {
			host = "unix://" + host
		} else if after, ok := strings.CutPrefix(host, "unix://"); ok {
			host = "unix://" + normalizeRemotePath(after, "/var/run/docker.sock")
		}
		remoteEnvironment := make(map[string]string, len(environment)+1)
		maps.Copy(remoteEnvironment, environment)
		remoteEnvironment["DOCKER_HOST"] = host
		// http.Transport may cancel its dial context immediately after DialContext
		// returns. The SSH process instead lives until the returned connection is
		// closed by the transport.
		cmd, cleanup, err := c.Command(context.WithoutCancel(ctx), remoteEnvironment, "docker", "system", "dial-stdio")
		if err != nil {
			return nil, err
		}
		stdin, err := cmd.StdinPipe()
		if err != nil {
			cleanup()
			return nil, err
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			_ = stdin.Close()
			cleanup()
			return nil, err
		}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			_ = stdin.Close()
			_ = stdout.Close()
			cleanup()
			return nil, fmt.Errorf("start SSH Docker transport: %w", err)
		}
		return &stdioConn{stdin: stdin, stdout: stdout, cmd: cmd, cleanup: cleanup, stderr: &stderr}, nil
	}
}

func NormalizeRemotePath(value, fallback string) string {
	return normalizeRemotePath(value, fallback)
}

func normalizeRemotePath(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = fallback
	}
	if value == "~" {
		return "."
	}
	if after, ok := strings.CutPrefix(value, "~/"); ok {
		return after
	}
	return value
}

func remoteCommand(environment map[string]string, args []string) string {
	parts := make([]string, 0, len(environment)+len(args)+1)
	if len(environment) > 0 {
		parts = append(parts, "env")
		keys := make([]string, 0, len(environment))
		for key := range environment {
			keys = append(keys, key)
		}
		sortStrings(keys)
		for _, key := range keys {
			parts = append(parts, shellQuote(key+"="+environment[key]))
		}
	}
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func expandUserPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "~" || strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
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

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

type stdioConn struct {
	stdin   io.WriteCloser
	stdout  io.ReadCloser
	cmd     *exec.Cmd
	cleanup func()
	stderr  *bytes.Buffer
	once    sync.Once
}

func (c *stdioConn) Read(p []byte) (int, error) {
	n, err := c.stdout.Read(p)
	if err != nil && n == 0 {
		if message := strings.TrimSpace(c.stderr.String()); message != "" {
			return 0, fmt.Errorf("SSH Docker transport: %s", message)
		}
	}
	return n, err
}

func (c *stdioConn) Write(p []byte) (int, error) { return c.stdin.Write(p) }

func (c *stdioConn) Close() error {
	var result error
	c.once.Do(func() {
		_ = c.stdin.Close()
		_ = c.stdout.Close()
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
		if err := c.cmd.Wait(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			result = err
		}
		c.cleanup()
	})
	return result
}

func (c *stdioConn) LocalAddr() net.Addr              { return sshAddr("local") }
func (c *stdioConn) RemoteAddr() net.Addr             { return sshAddr("remote") }
func (c *stdioConn) SetDeadline(time.Time) error      { return nil }
func (c *stdioConn) SetReadDeadline(time.Time) error  { return nil }
func (c *stdioConn) SetWriteDeadline(time.Time) error { return nil }

type sshAddr string

func (a sshAddr) Network() string { return "ssh" }
func (a sshAddr) String() string  { return string(a) }
