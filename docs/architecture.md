# Architecture

Runwake uses one shared Go core for browser, hosted, container, and desktop delivery.

```text
Browser or native WebView
        │ HTTP + SSE
        ▼
runwake server
        │
        ├── Kubernetes HTTP API
        └── Docker Engine API
```

## Core principles

1. Inventory and current metric snapshots remain inexpensive and bounded.
2. Logs and detailed metric streams open only while a user views them.
3. Runtime facts, application output, and metric samples remain distinct.
4. The server does not require an external database, log backend, or time-series store.
5. Connections default to read-only; the server permits the narrow Docker action interface only after a saved connection explicitly opts into changes.

## Core packages

- `internal/kube` — direct Kubernetes API access and kubeconfig parsing;
- `internal/dockerapi` — Docker Engine inventory, events, logs, metrics, Compose metadata, and guarded container/project actions;
- `internal/provider` — normalized provider interfaces;
- `internal/activity` — shared on-demand streams, bounded replay, and fan-out;
- `internal/metrics` — current snapshot caching and selected-workload metric streams;
- `internal/workloadcache` — replaceable workload-inventory cache boundary and in-memory adapter;
- `internal/store` — atomic JSON state and AES-GCM encrypted blobs;
- `internal/server` — HTTP API, SSE, authentication, and embedded UI.

Remote-agent packages remain in the repository for later development. Their UI,
API routes, executables, and release artifacts are disabled in `0.1.x`.

## Provider interface

A provider exposes inventory, namespaces, current metrics, live activity, and
selected-workload metric streams. Kubernetes and Docker implementations normalize
their output into shared workload, activity, and metric records. Direct Docker
providers additionally implement a small optional controller interface for
container restart/delete and Compose-project restart.

## Activity fan-out

One upstream stream is shared for identical requests:

```text
provider stream
     │
bounded in-memory replay
     ├── browser A
     ├── browser B
     └── browser C
```

The upstream closes after the final subscriber leaves. Runwake does not persist
logs. A slow viewer receives an explicit dropped-record marker instead of blocking
the provider.

## Metrics

Overview requests use a short in-memory snapshot cache with concurrent-request
coalescing. Selected-workload streams share one provider stream and keep a bounded
browser history. No metric samples are written to disk.

## Workload inventory

Successful discovery results are cached per connection. The UI reads this cache
when it opens and refreshes only connections without a snapshot or connections
the user explicitly selected. A partial refresh replaces inventory for its target
connections and leaves every other connection untouched.

`workloadcache.Cache` separates storage from discovery. `0.1.x` uses the in-memory
adapter, so snapshots survive page navigation and browser reloads but not a server
restart. A later Redis or SQLite adapter can use the same interface. Snapshot
timestamps are retained so background refresh policy can be added without changing
the API shape.

## Kubernetes flow

1. Resolve the kubeconfig and selected context.
2. Load static credentials and TLS configuration from the selected user and cluster.
3. Call the Kubernetes HTTP API directly without invoking `kubectl`.
4. List permitted workloads and resolve selected workloads to Pods.
5. Open Pod/container log streams and optional event watches.
6. Read `metrics.k8s.io` when available.

## Docker flow

The Docker client negotiates the Engine API, inspects containers, streams logs and
events, and reads current stats. Inspect metadata also supplies Compose services,
networks, ports, volumes, and bind mounts for the topology view. Runtime action
routes load the saved connection again, require direct Docker `manage` access,
then invoke the narrow controller interface and invalidate inventory and metric
snapshots after success.

## Desktop delivery

The desktop shell starts the same server on an ephemeral loopback address and
navigates the native WebView to it. Browser, container, hosted, and desktop modes
therefore share the same HTTP and SSE behavior.
