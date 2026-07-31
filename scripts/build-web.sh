#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
MODE=${1:-build}
APP_OUTPUT="$ROOT/webembed/dist/app.js"
STYLE_OUTPUT="$ROOT/webembed/dist/styles.css"
APP_TEMP=$(mktemp)
STYLE_TEMP=$(mktemp)
trap 'rm -f "$APP_TEMP" "$STYLE_TEMP"' EXIT HUP INT TERM

for source_file in \
  "$ROOT/webembed/src/app/00-core.js" \
  "$ROOT/webembed/src/app/10-workloads.js" \
  "$ROOT/webembed/src/app/20-topology.js" \
  "$ROOT/webembed/src/app/30-connections-settings.js" \
  "$ROOT/webembed/src/app/40-activity-metrics.js" \
  "$ROOT/webembed/src/app/50-connection-editor.js" \
  "$ROOT/webembed/src/app/60-personal-workflows.js" \
  "$ROOT/webembed/src/app/70-runtime-actions.js"
do
  sed -n '1,$p' "$source_file" >> "$APP_TEMP"
done

for source_file in \
  "$ROOT/webembed/src/styles/00-foundation-workloads.css" \
  "$ROOT/webembed/src/styles/10-connections-settings.css" \
  "$ROOT/webembed/src/styles/20-metrics-topology.css" \
  "$ROOT/webembed/src/styles/30-activity-controls.css" \
  "$ROOT/webembed/src/styles/40-personal-responsive.css"
do
  sed -n '1,$p' "$source_file" >> "$STYLE_TEMP"
done

if [ "$MODE" = "--check" ]; then
  cmp -s "$APP_TEMP" "$APP_OUTPUT" || { echo "webembed/dist/app.js is stale; run make web-build" >&2; exit 1; }
  cmp -s "$STYLE_TEMP" "$STYLE_OUTPUT" || { echo "webembed/dist/styles.css is stale; run make web-build" >&2; exit 1; }
  echo "embedded web assets match their source modules"
  exit 0
fi

if [ "$MODE" != "build" ]; then
  echo "usage: scripts/build-web.sh [build|--check]" >&2
  exit 2
fi

mv "$APP_TEMP" "$APP_OUTPUT"
mv "$STYLE_TEMP" "$STYLE_OUTPUT"
trap - EXIT HUP INT TERM
echo "embedded web assets rebuilt"
