#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
go test ./internal/store -run TestUpgradeCompatibility -count=1
echo "upgrade compatibility check passed"
