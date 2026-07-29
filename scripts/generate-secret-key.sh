#!/usr/bin/env sh
set -eu
if command -v openssl >/dev/null 2>&1; then
  openssl rand -base64 32
elif command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import base64, secrets
print(base64.b64encode(secrets.token_bytes(32)).decode())
PY
else
  echo "openssl or python3 is required" >&2
  exit 1
fi
