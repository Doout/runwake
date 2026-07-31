# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Runwake primarily serves SRE and platform operators who need to inspect live Docker and Kubernetes workloads while troubleshooting or monitoring runtime behavior.

Local developers are an important secondary audience. They should be able to use the same product to understand workloads on their own machines and in development environments without adopting a separate workflow.

## Product Purpose

Runwake is a lightweight operations viewer for Docker and Kubernetes workloads. It brings live logs, exact runtime events, and current CPU and memory usage into one interface so operators and developers can quickly understand what is happening now. Connections are read-only by default; direct Docker connections can explicitly opt into a narrow set of runtime actions.

Success means giving users useful operational visibility with little setup while preserving a deliberately narrow, trustworthy scope.

## Positioning

Runwake provides immediate operational visibility without requiring users to deploy or maintain a full observability stack.

Its position depends on a focused mechanism: it discovers directly connected workloads, opens detailed streams on demand, and presents current runtime facts without becoming a log platform, time-series store, or automated diagnosis system.

## Operating Context

- Users inspect Docker containers and Kubernetes workloads from a browser or the same web interface inside a thin desktop shell.
- Runwake can run locally, as a hosted single binary, or in a container.
- Kubernetes connections use kubeconfig semantics. Docker connections use the Engine API.
- Users move from workload inventory and current metrics into on-demand logs, lifecycle events, and selected-workload metrics.
- Shared deployments rely on an administrative access token and external HTTPS termination.

## Capabilities and Constraints

- Discovers Docker containers and Kubernetes Deployments, StatefulSets, DaemonSets, Jobs, and standalone Pods.
- Maps Docker Compose projects across services, containers, networks, ports, volumes, and bind-mounted Docker host paths.
- Shows current CPU and memory usage, with additional Docker runtime metrics where available.
- Streams current and previous logs, exact lifecycle events, and selected-workload metrics on demand.
- Supports direct connections. Remote agents are planned for a later release.
- Docker connections are read-only by default and can explicitly allow container restart, force-delete, and Compose-project restart.
- Kubernetes connections remain read-only. Runwake does not edit or scale workloads, or provide arbitrary Docker lifecycle and configuration controls.
- Does not persist logs or metric history. Browser-side selected-workload history is bounded and temporary.
- Does not provide durable search, traces, alerts, generated incident diagnoses, multi-user identity, per-user authorization, or multi-tenancy in the current MVP.
- Kubernetes metrics depend on a `metrics.k8s.io` provider, but inventory, logs, and events continue when metrics are unavailable.
- Direct Kubernetes exec credential helpers must exist in the environment where Runwake runs and are governed by an explicit execution policy.
- A Docker socket remains a privileged host capability. Runwake's access mode is an application-level gate, not a reduction in the Docker endpoint's privileges.
- Brand voice, a formal accessibility target, and finer audience segmentation remain open decisions while the product is early.

## Brand Commitments

- The product name is Runwake.
- Product claims must remain precise about what Runwake observes, stores, secures, and does not do.
- No additional voice or identity commitments have been established yet.

## Evidence on Hand

- Product scope and setup: `README.md`
- Implemented and deliberately excluded MVP capabilities: `docs/MVP_STATUS.md`
- System model and delivery architecture: `docs/architecture.md`
- Security boundaries and operational warnings: `docs/security.md`
- Direct connection behavior: `docs/authentication.md`
- Remote-agent roadmap: `docs/agents.md`
- Verification status and limitations: `docs/verification.md`
- Existing product interface screenshots: `screenshots/`
- No testimonials, customer logos, case studies, usage benchmarks, or other external proof are currently present and future work must not fabricate them.

## Product Principles

1. Show runtime facts clearly without guessing at causes.
2. Make useful visibility fast to start and light to operate.
3. Keep detailed data on demand, bounded, and non-persistent by default.
4. Default to read-only access, require explicit opt-in for runtime changes, and communicate infrastructure trust boundaries honestly.
5. Serve SRE workflows first while keeping local development straightforward.
