# Runwake

Runwake is a lightweight operations viewer for Docker and Kubernetes workloads.

It puts live logs, exact runtime events, and current CPU and memory usage in one small interface. Connections are read-only by default. A Docker connection can explicitly allow container restart, container delete, and Compose-project restart. Runwake does not store logs, retain metric history, or guess at root causes.

## What it does

- Discovers Docker containers and Kubernetes workloads.
- Streams logs only while a workload is open, with search, filters, context lines, and reversible match navigation.
- Recognizes JSON and common key/value logs, with workload and per-record formatting controls for malformed output and stack traces.
- Shows runtime state and lifecycle events beside the logs.
- Reads current metrics from Docker or `metrics.k8s.io`.
- Optionally restarts or deletes Docker containers and restarts Docker Compose projects on connections configured to allow changes.
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

Or start the latest container image:

```sh
docker run --detach \
  --name runwake \
  --user 0 \
  --publish 127.0.0.1:8080:8080 \
  --volume runwake-data:/data \
  --volume "${RUNWAKE_DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock:ro" \
  ghcr.io/doout/runwake:latest
```

Then open [http://localhost:8080](http://localhost:8080), add a Docker
connection, and keep the default `unix:///var/run/docker.sock` endpoint.

Rootless Docker uses a per-user socket. Set its path before running either
command:

```sh
export RUNWAKE_DOCKER_SOCKET="/run/user/$(id -u)/docker.sock"
```

To build and run the current source with Docker Compose instead:

```sh
docker compose up --build --detach
```

Both container commands persist configuration in a named Docker volume. For a
shared deployment, pass `RUNWAKE_AUTH_TOKEN` into the container and put Runwake
behind HTTPS. These commands run the container as root so it can access the
selected Docker socket without a host-specific group ID. The socket is a
privileged host capability even with a read-only bind mount; only expose it to
images you trust.

### Opening the macOS app

Runwake's macOS app is not currently signed or notarized with Apple. Until
signed releases are introduced, macOS may prevent the downloaded app from
opening.

If you downloaded `Runwake.app` from the official GitHub release, either
Control-click the app, select **Open**, and confirm **Open**, or use **Open
Anyway** in **System Settings → Privacy & Security**.

You can also remove the quarantine attribute in Terminal:

```sh
xattr -dr com.apple.quarantine Runwake.app
```

Only bypass this protection for a copy you trust and downloaded from the
official Runwake GitHub repository. Apple signing and notarization are planned
for a future release.

## Connections

Runwake supports:

- Docker Engine over a local socket, SSH, HTTP, or TLS.
- Per-connection Docker access: read-only by default, with an explicit opt-in for restart and delete actions.
- Kubernetes directly through its API using a local kubeconfig or encrypted upload, without requiring `kubectl`.
- Selected Kubernetes namespaces or all permitted namespaces.
- Static bearer-token, client-certificate, and basic kubeconfig authentication.

Kubernetes metrics require Metrics Server or another `metrics.k8s.io` provider. Logs, events, and inventory continue working when metrics are unavailable.

Remote agents are planned for a later release and are disabled in `0.1.x`.

## Security

Runwake encrypts stored connection credentials with AES-256-GCM.

A Docker socket remains a privileged host capability. Runwake's per-connection read-only setting gates its own API and controls; it does not reduce the Docker endpoint's underlying privileges.

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
