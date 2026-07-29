# Runwake

Runwake is a lightweight viewer for Docker and Kubernetes workloads.

It puts live logs, exact runtime events, and current CPU and memory usage in one small interface. It does not store logs, retain metric history, modify workloads, or guess at root causes.

## What it does

- Discovers Docker containers and Kubernetes workloads.
- Streams logs only while a workload is open, with search, filters, context lines, and reversible match navigation.
- Recognizes JSON and common key/value logs, with workload and per-record formatting controls for malformed output and stack traces.
- Shows runtime state and lifecycle events beside the logs.
- Reads current metrics from Docker or `metrics.k8s.io`.
- Runs as a desktop app, single hosted binary, or container.

## Quick start

Run locally in your browser:

```sh
runwake desktop
```

On a new desktop profile, Runwake detects a reachable local Docker Engine and adds it automatically.

Run as a hosted service:

```sh
runwake serve \
  --listen 0.0.0.0:8080 \
  --data-dir ./runwake-data \
  --auth-token "$(openssl rand -hex 24)"
```

Put hosted deployments behind HTTPS.

Docker Compose is also supported:

```sh
docker compose up --build
```

Set `RUNWAKE_AUTH_TOKEN` for a shared deployment.

## Connections

Runwake supports:

- Docker Engine over a local socket, SSH, HTTP, or TLS.
- Kubernetes through a local kubeconfig, encrypted upload, or kubectl on an SSH host.
- Selected Kubernetes namespaces or all permitted namespaces.
- Kubernetes exec credential plugins with deny, allowlist, and allow policies.

Kubernetes metrics require Metrics Server or another `metrics.k8s.io` provider. Logs, events, and inventory continue working when metrics are unavailable.

Remote agents are planned for a later release and are disabled in `0.1.x`.

## Security

Runwake encrypts stored connection credentials with AES-256-GCM.

A Docker socket remains a privileged host capability even when Runwake performs read-oriented operations.

## Documentation

- [Getting started for developers](docs/development.md)
- [MVP scope](docs/MVP_STATUS.md)
- [Architecture](docs/architecture.md)
- [Authentication](docs/authentication.md)
- [Roadmap: remote agents](docs/agents.md)
- [Security](docs/security.md)
- [HTTP API](docs/api.md)
- [Verification report](docs/verification.md)
- [Changelog](CHANGELOG.md)

## License

See [LICENSE](LICENSE).
