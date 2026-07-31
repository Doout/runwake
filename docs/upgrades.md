# Upgrades and recovery

Runwake stores server state as small JSON files in its data directory and personal workflow data in browser-local storage. Releases must preserve both formats across upgrades.

## Before upgrading

1. Stop Runwake.
2. Copy the configured data directory to a safe location. The default desktop location is printed at startup.
3. Export any investigation that must be portable. Browser-local investigations do not move automatically between browser profiles or machines.
4. Download the release checksum and verify the artifact before replacing the binary or desktop application.

Runwake writes server JSON files atomically. New fields are additive and missing settings fall back to current defaults. The personal workflow store carries its own schema version and rejects unsupported imports instead of guessing.

## Desktop release trust

The release workflow always produces a checksum. When Apple signing secrets are configured, it also signs, notarizes, verifies, and staples the macOS application before packaging it. Unsigned development builds remain possible and are called out in workflow output.

## Rollback

Stop Runwake, restore the data-directory backup, and reinstall the previous release. Investigation exports remain portable JSON and can be imported after rollback. Never copy a live data directory while Runwake is writing to it.

## Maintainer verification

Run `scripts/check-upgrade.sh` before a release. It opens representative older state with the current binary and verifies that existing connections and settings survive unchanged. Release builds additionally verify embedded versions and published SHA-256 checksums.
