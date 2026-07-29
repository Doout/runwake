# Security model

Runwake crosses infrastructure trust boundaries. This document states what the MVP does and does not protect.

## Server access

Set `RUNWAKE_AUTH_TOKEN` for any shared or remotely reachable server. The browser exchanges it for an HttpOnly, SameSite=Strict cookie. API clients may use a bearer token.

Runwake does not terminate TLS. Use a trusted reverse proxy or private network.

## Credential encryption

Kubeconfigs, Kubernetes environment overrides, Docker TLS material, SSH private keys, and HTTP proxy credentials are encrypted with AES-256-GCM.

The master key is either:

- a base64-encoded 32-byte value in `RUNWAKE_SECRET_KEY`; or
- a generated key file in the Runwake data directory.

File permissions are restricted when the operating system supports them. Host filesystem and volume security still matter.

## Kubeconfig execution

Kubeconfig exec plugins execute local programs. Runwake inspects the selected user and applies a deny/allowlist/allow policy before Kubernetes operations. Shared installations should use an allowlist and narrowly controlled helper binaries.

## Docker permissions

A Docker socket is a privileged host capability. Read-only intent in the application does not make possession of the socket harmless. Do not expose an unauthenticated Docker TCP endpoint. Prefer TLS, SSH, or a narrowly scoped socket proxy.

## Browser content

The server applies a restrictive Content Security Policy, denies framing, disables referrer leakage, and serves no third-party scripts or fonts.

## Log data

Logs may contain secrets, personal information, or customer data. Runwake sends them through memory and to connected viewers. It does not persist them by default, but transport security and viewer authorization remain required.

## Not implemented in the MVP

- multi-user accounts or per-user RBAC;
- external identity providers;
- audit history;
- secret-manager integrations;
- remote agents;
- signed updates;
- tamper-evident log storage.

Do not represent the MVP as a multi-tenant security boundary.
