# Changelog

## 0.1.0 — Initial release

### Added

- Embedded web interface and native macOS desktop shell.
- Direct Docker Engine connections through local sockets, SSH, HTTP, and TLS.
- Direct Kubernetes connections through kubeconfig files, uploaded configuration, SSH, OpenShift, EKS, GKE, and AKS setup.
- Streaming workload logs with search, filters, context lines, match navigation, follow mode, and bounded browser buffers.
- Automatic JSON, key/value, HTTP access-log, and stack-trace formatting with raw and custom formatting controls.
- Current Docker and Kubernetes CPU and memory metrics.
- Docker Compose topology for services, containers, networks, ports, volumes, and host paths.
- Reusable SSH profiles and HTTP proxy configuration.
- Encrypted connection credentials and optional server access token.
- Cross-platform server archives and checksums.
- Per-connection in-memory workload snapshots with filtered incremental refresh.

### Boundaries

- Remote agents are disabled and planned for a later release.
- Logs and metric history are not stored.
- Runwake does not modify, restart, scale, or delete workloads.
- Native desktop signing, notarization, and installers are not included.
