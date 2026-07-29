# Verification

Runwake `0.1.0` uses the following release checks:

```sh
make check
make vuln
make race
make smoke
make release VERSION=0.1.0
```

These validate Go formatting, unit and integration tests for both modules, the
race detector, `go vet`, GolangCI-Lint, JavaScript syntax, compilation, startup,
the health API, cross-platform archives, and checksums.

The release pipeline also verifies that:

- the embedded UI reports version `0.1.0`;
- remote-agent HTTP routes return `404`;
- release archives contain the Runwake server, README, and license;
- no generated binaries, runtime data, credentials, or local tool state are tracked.

Live Docker and Kubernetes integration still depends on external runtimes.
Native desktop signing, notarization, and installer validation are separate release
tasks and are not claimed by `0.1.0`.
