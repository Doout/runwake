package sshx

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConfigCommandUsesNonInteractiveSafeDefaults(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	dir := t.TempDir()
	ssh := filepath.Join(dir, "ssh")
	if err := os.WriteFile(ssh, []byte("#!/bin/sh\nprintf ready\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	config := Config{
		Host: "cluster.example.com", User: "operator", Port: 2222,
		HostKeyPolicy: "accept-new", PrivateKey: []byte("private key"),
	}
	cmd, cleanup, err := config.Command(context.Background(), map[string]string{"PROFILE": "prod"}, "kubectl", "version")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, "BatchMode=yes") || !strings.Contains(joined, "StrictHostKeyChecking=accept-new") || !strings.Contains(joined, "operator@cluster.example.com") {
		t.Fatalf("unsafe or incomplete SSH arguments: %s", joined)
	}
	identityIndex := -1
	for i, value := range cmd.Args {
		if value == "-i" && i+1 < len(cmd.Args) {
			identityIndex = i + 1
			break
		}
	}
	if identityIndex < 0 {
		t.Fatal("materialized identity was not passed to ssh")
	}
	identity := cmd.Args[identityIndex]
	if info, statErr := os.Stat(identity); statErr != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("identity permissions are not private: %v %v", info, statErr)
	}
	cleanup()
	if _, statErr := os.Stat(identity); !os.IsNotExist(statErr) {
		t.Fatal("materialized identity was not removed")
	}
}

func TestRunUsesSSHBinaryWithoutPrompting(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	dir := t.TempDir()
	ssh := filepath.Join(dir, "ssh")
	if err := os.WriteFile(ssh, []byte("#!/bin/sh\nprintf ready\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	stdout, _, err := (Config{Host: "server"}).Run(context.Background(), nil, nil, "true")
	if err != nil {
		t.Fatal(err)
	}
	if string(stdout) != "ready" {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestNormalizeRemotePath(t *testing.T) {
	if got := NormalizeRemotePath("~/.kube/config", ".kube/config"); got != ".kube/config" {
		t.Fatalf("normalized path = %q", got)
	}
	if got := NormalizeRemotePath("", "/var/run/docker.sock"); got != "/var/run/docker.sock" {
		t.Fatalf("fallback path = %q", got)
	}
}
