#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
BIN=${RUNWAKE_BIN:-$ROOT/bin/runwake}
EXPECTED_VERSION=${RUNWAKE_VERSION:-0.1.0}
if [ ! -x "$BIN" ]; then
  make -C "$ROOT" build >/dev/null
fi
DATA=$(mktemp -d)
LOG=$(mktemp)
PORT=$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
)
cleanup() {
  if [ "${PID:-}" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$DATA" "$LOG"
}
trap cleanup EXIT INT TERM

"$BIN" serve --listen "127.0.0.1:$PORT" --data-dir "$DATA" >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PORT/api/v1/health" | grep -q '"status":"ok"'
META=$(curl -fsS "http://127.0.0.1:$PORT/api/v1/meta")
printf '%s' "$META" | grep -q '"name":"Runwake"'
printf '%s' "$META" | grep -q "\"version\":\"$EXPECTED_VERSION\""
printf '%s' "$META" | grep -q '"remote_agents":false'
curl -fsS "http://127.0.0.1:$PORT/api/v1/settings" | grep -q '"default_tail_lines"'
test "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/v1/agents/enroll")" = "404"
curl -fsS "http://127.0.0.1:$PORT/" | grep -q '<title>Runwake</title>'
curl -fsS "http://127.0.0.1:$PORT/app.js" -o "$DATA/app.js"
curl -fsS "http://127.0.0.1:$PORT/styles.css" -o "$DATA/styles.css"
grep -q 'renderWorkloads' "$DATA/app.js"
grep -q ':root' "$DATA/styles.css"
curl -fsS "http://127.0.0.1:$PORT/manifest.webmanifest" | grep -q '"name": "Runwake"'
echo "smoke test passed on 127.0.0.1:$PORT"
