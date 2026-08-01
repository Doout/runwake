# Development

This guide contains local setup, build, test, packaging, and repository details. Product and operator documentation remains linked from the main README.

## Requirements

- Go 1.23 or newer for the server.
- Go 1.25 or newer for the full contributor checks and native desktop shell.
- Node.js for the embedded JavaScript syntax check.
- Docker for container builds and Docker integration testing.
- Wails v2.13.0 only when building the optional native desktop shell.

## Run from source

Build the server:

```sh
make build
```

Open the browser-based desktop mode:

```sh
./bin/runwake desktop
```

Run a local hosted instance:

```sh
./bin/runwake serve \
  --listen 127.0.0.1:8080 \
  --data-dir ./data \
  --open
```

The same Go core and embedded web interface back desktop and hosted modes.

Investigations are experimental and disabled by default. Enable the interface
for local development with either the command-line flag or environment variable:

```sh
./bin/runwake desktop --enable-investigations
RUNWAKE_ENABLE_INVESTIGATIONS=true ./bin/runwake serve
RUNWAKE_ENABLE_INVESTIGATIONS=true make desktop
```

On an empty desktop profile, startup checks `DOCKER_HOST`, the active Docker CLI context, and standard local socket paths. The first endpoint that answers the Docker version API is saved as `Local Docker`. Hosted mode does not perform this discovery.

## Checks

Run the standard checks:

```sh
make check
make vuln
make race
make build
./scripts/smoke.sh
```

These cover formatting, both Go modules, GolangCI-Lint, race detection, vetting,
JavaScript syntax, compilation, startup, and basic HTTP/API behavior.

Additional configuration validation:

```sh
sh -n scripts/*.sh
docker compose config
kubectl apply --dry-run=client -f deploy/runwake-server.yaml
```

Live infrastructure results and remaining coverage are tracked in [verification.md](verification.md).

## Docker images

Build the default dependency-free server image:

```sh
docker build -t runwake:0.1.0 .
```

Remote agents are not part of the `0.1.x` build.

## Native desktop shell

The optional Wails wrapper starts the same loopback server and embedded interface used by browser mode.

```sh
make desktop
```

This installs Wails v2.13.0 when needed, builds the native application, and launches it on macOS.

For a build without launching:

```sh
make desktop-build
```

For development mode:

```sh
make desktop-dev
```

Keep business logic in the shared Go core rather than the desktop wrapper.

## Release archives

Build versioned command-line archives:

```sh
make release VERSION=0.1.0
```

The release script produces:

- Linux amd64 and arm64 server bundles.
- macOS amd64 and arm64 browser-mode binaries.
- Windows amd64 browser-mode binary.
- SHA-256 checksums in `dist/SHA256SUMS`.

Verify the archives:

```sh
(cd dist && sha256sum -c SHA256SUMS)
```

Native desktop signing, notarization, and installers are separate platform release tasks.

Pushing a semantic-version tag such as `v1.2.3` runs the release workflow. It
uploads the server archives and macOS application to the matching GitHub
Release, and publishes multi-platform container images as
`ghcr.io/doout/runwake:1.2.3` and `ghcr.io/doout/runwake:latest`.

## Useful Make targets

```text
make build        Build the server binary
make fix          Apply Go source migrations and formatting
make test         Run server and desktop Go tests
make race         Run server and desktop tests with the race detector
make lint         Run the pinned GolangCI-Lint checks
make vuln         Scan both Go modules for known vulnerabilities
make check        Format-check, test, vet, lint, and check JavaScript
make run          Start a local hosted server
make docker       Build the server image
make desktop      Install, build, and launch the Wails application on macOS
make desktop-build Build the Wails application without launching
make desktop-dev  Start Wails development mode
make release      Build cross-platform archives
make smoke        Build and run the startup smoke test
make clean        Remove generated local artifacts
```

## Repository layout

```text
cmd/runwake/          Server and browser-desktop command
internal/kube/        Direct and in-cluster Kubernetes providers
internal/dockerapi/   Docker Engine client
internal/activity/    Shared activity streams and bounded replay
internal/metrics/     Current snapshots and on-demand metric streams
internal/server/      HTTP API, SSE, authentication, and web serving
internal/store/       State and encrypted connection credentials
webembed/dist/        Shared dependency-free web interface
desktop-wails/        Optional native desktop wrapper
deploy/               Hosted deployment example
scripts/              Smoke and release scripts
```

The agent and deployment packages remain in the tree for later development but
are gated off and excluded from `0.1.x` artifacts.
