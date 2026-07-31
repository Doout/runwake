# MVP boundary

This first Runwake MVP is intentionally small. It is a live viewer, not a log platform.

## Implemented

### Delivery modes

- one dependency-light Go server with the web UI embedded;
- laptop mode that listens on loopback and opens the browser;
- hosted mode for a container or server;
- a thin Wails v2 wrapper source tree that starts the same Go server core;
- cross-platform browser-mode server builds.

### Kubernetes

- direct connections by kubeconfig path or encrypted stored kubeconfig;
- kubeconfig context selection;
- CA, client certificate/key, bearer-token, and basic authentication directly through the Kubernetes API;
- all-permitted or selected-namespace scope;
- workload discovery for Deployments, StatefulSets, DaemonSets, Jobs, and standalone Pods;
- on-demand current and previous container logs;
- a browser-memory log workbench with search, regular-expression and severity/source filters, before/after context, exact match navigation, a buffer-position rail, and reversible jumps;
- automatic JSON/key-value summaries plus per-workload and per-record raw, structured, stack-trace, and custom-regex formatting;
- current CPU and memory through `metrics.k8s.io`, including per-container samples and Pod memory limits when specified;
- Pod Event objects and exact Pod/container state changes;
- automatic attachment to replacement Pods during a rollout;

### Docker

- direct Engine connections over Unix socket, SSH, plain HTTP/TCP, or TLS;
- encrypted CA/client certificate/client key material;
- container discovery and exact inspect state;
- Compose topology across projects, services, containers, networks, ports, named volumes, and bind-mounted host paths;
- on-demand stdout/stderr logs and container lifecycle events;
- current CPU, working-set memory, limits, network and block I/O, and process count from Docker stats;
- read-only access by default, with an explicit per-connection opt-in for container restart, force-delete, and Compose-project restart;

### Runtime behavior

- one shared upstream stream when multiple viewers open the same workload;
- 500-record in-memory replay buffer per active stream;
- explicit dropped-record notice for a slow browser;
- logs and activity records are not persisted;
- overview metrics use an in-memory snapshot cache; selected-workload history exists only in the browser and is bounded to ten minutes or 600 samples;

### Security

- AES-256-GCM encryption for stored credentials;
- optional single administrative access token;
- no shell command construction for Kubernetes API operations;
- configurable deny/allowlist/allow policy for kubeconfig exec plugins.

## Deliberately not implemented

- durable log retention or full-text indexing;
- durable metric retention, Prometheus-compatible storage, traces, alerts, or generated incident diagnoses;
- multi-user identity, per-user authorization, or multi-tenancy;
- Kubernetes workload mutation, workload editing or scaling, and Docker actions beyond container restart/delete and Compose-project restart;
- private registry credential management;
- remote agents;
- native desktop release signing, notarization, and installers.

OpenShift, EKS, GKE, and AKS setup can derive fields from provider login commands. Matching credential-helper executables must still be installed where direct-mode Runwake runs.

## Validation completed in this repository

- `go test ./...`;
- `go test -race ./...`;
- `go vet ./...`;
- JavaScript syntax validation;
- shell-script parse validation;
- Compose and Kubernetes YAML parsing;
- local HTTP startup and API smoke test.

Live integration against a real Kubernetes cluster, Docker daemon, cloud credential helper, and signed native Wails build requires those external targets and toolchains and is not claimed by this repository snapshot.
