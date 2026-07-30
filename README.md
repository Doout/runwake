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

Or start the latest container image:

```sh
docker run --detach \
  --name runwake \
  --publish 127.0.0.1:8080:8080 \
  --volume runwake-data:/data \
  --volume /var/run/docker.sock:/var/run/docker.sock:ro \
  --group-add "$(ls -Lln /var/run/docker.sock | awk '{print $4}')" \
  ghcr.io/doout/runwake:latest
```

Then open [http://localhost:8080](http://localhost:8080), add a Docker
connection, and keep the default `unix:///var/run/docker.sock` endpoint.

To build and run the current source with Docker Compose instead:

```sh
DOCKER_GID="$(ls -Lln /var/run/docker.sock | awk '{print $4}')" \
  docker compose up --build --detach
```

Both container commands persist configuration in a named Docker volume. For a
shared deployment, pass `RUNWAKE_AUTH_TOKEN` into the container and put Runwake
behind HTTPS. The Docker socket is a privileged host capability even with a
read-only bind mount; only expose it to images you trust.

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
- Kubernetes directly through its API using a local kubeconfig or encrypted upload, without requiring `kubectl`.
- Selected Kubernetes namespaces or all permitted namespaces.
- Static bearer-token, client-certificate, and basic kubeconfig authentication.

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
