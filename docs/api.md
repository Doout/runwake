# HTTP API

All browser APIs use the `/api/v1` prefix and JSON unless noted.

When access-token protection is enabled, send the session cookie or:

```http
Authorization: Bearer <server-token>
```

## Public endpoints

### `GET /api/v1/health`

Returns process health, version, and server time.

### `POST /api/v1/auth/login`

```json
{"token":"server access token"}
```

Creates the browser session cookie.

### `POST /api/v1/auth/logout`

Expires the browser session cookie.

## Settings

### `GET /api/v1/meta`
### `GET /api/v1/settings`
### `PUT /api/v1/settings`

Settings include the initial log tail, metric sampling intervals, and legacy
SSH Kubernetes command policy.

## Connections

### `GET /api/v1/connections`
### `GET /api/v1/connections/{id}`
### `POST /api/v1/connections`
### `POST /api/v1/connections/test`
### `POST /api/v1/ssh/test`
### `GET /api/v1/ssh-profiles`
### `POST /api/v1/ssh-profiles`
### `POST /api/v1/ssh-profiles/{id}/test`
### `DELETE /api/v1/ssh-profiles/{id}`
### `POST /api/v1/connections/{id}/test`
### `DELETE /api/v1/connections/{id}`

Connection requests may select a reusable `ssh_profile_id` or include an `ssh` object with host, port, user, host-key policy, optional jump host, optional known-hosts path, and an optional private key. Private keys are encrypted at rest and their secret identifiers are redacted from responses. SSH uses non-interactive OpenSSH authentication through the supplied key, SSH agent, SSH config, or default keys.

Direct Kubernetes and Docker requests may also include an `http_proxy` object:

```json
{
  "http_proxy": {
    "url": "http://user:password@proxy.example.com:8080",
    "no_proxy": ["localhost", ".svc", "10.0.0.0/8"]
  }
}
```

Proxy URLs are encrypted and responses expose only a credential-free display URL. SSH and HTTP proxy settings are independent: when both are selected, the proxy must be reachable from the SSH host.

## Workloads

### `GET /api/v1/workloads`

Optional query:

```text
connection_id=<id>
```

Returns the current inventory. A provider error is reported per connection rather than inventing workload data.

### `GET /api/v1/workloads/cache`

Returns the last successful in-memory inventory without contacting a runtime.
The optional `connection_id` filter may be repeated. The response contains
`workloads` and an `observed_at` timestamp keyed by connection ID.

### `GET /api/v1/workloads/stream`

Refreshes inventory incrementally with Server-Sent Events. The optional
`connection_id` filter may be repeated. Successful connection results replace
that connection's cache entry after its stream completes.

### `GET /api/v1/namespaces`

Optional connection filter as above.

## Activity

### `GET /api/v1/activity/stream`

Server-Sent Events stream.

Required query:

```text
connection_id
kind
name
```

Optional query:

```text
namespace
tail_lines
previous=true|false
events=true|false
```

Events are emitted as:

```text
id: 42
event: activity
data: {"sequence":42,"timestamp":"...","type":"log",...}
```

## Metrics

### `GET /api/v1/metrics`

Returns the latest in-memory snapshot for every permitted workload. Optional query:

```text
connection_id=<id>
```

The response contains `metrics`, per-connection `errors`, and `observed_at`. Docker samples come from the Engine stats endpoint. Kubernetes samples require `metrics.k8s.io`.

### `GET /api/v1/metrics/stream`

Server-Sent Events stream for one selected workload. Required query:

```text
connection_id
kind
name
```

Optional query:

```text
namespace
interval_seconds
```

Docker accepts one-second or longer intervals. Kubernetes is clamped to fifteen seconds because its Metrics API is a sampled current-value API rather than a live stream. Events are emitted as:

```text
id: 42
event: metric
data: {"sequence":42,"timestamp":"...","cpu_cores":0.12,...}
```

Metric samples are not persisted by the server.

Remote-agent routes are disabled in `0.1.x` and return `404`.
