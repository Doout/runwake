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
  "$ROOT/webembed/src/app/12-workload-support.js" \
  "$ROOT/webembed/src/app/20-topology.js" \
  "$ROOT/webembed/src/app/30-connections-settings.js" \
  "$ROOT/webembed/src/app/40-activity-shell.js" \
  "$ROOT/webembed/src/app/41-log-scope.js" \
  "$ROOT/webembed/src/app/42-activity-streams.js" \
  "$ROOT/webembed/src/app/43-log-rendering.js" \
  "$ROOT/webembed/src/app/44-log-formatters.js" \
  "$ROOT/webembed/src/app/50-connection-editor.js" \
  "$ROOT/webembed/src/app/51-connection-imports.js" \
  "$ROOT/webembed/src/app/52-connection-submission.js" \
  "$ROOT/webembed/src/app/53-agent-deployment.js" \
  "$ROOT/webembed/src/app/60-personal-workflows.js" \
  "$ROOT/webembed/src/app/61-investigations.js" \
  "$ROOT/webembed/src/app/70-runtime-dialogs.js" \
  "$ROOT/webembed/src/app/71-connection-actions.js" \
  "$ROOT/webembed/src/app/72-personal-actions.js" \
  "$ROOT/webembed/src/app/73-workload-actions.js" \
  "$ROOT/webembed/src/app/74-runtime-actions.js" \
  "$ROOT/webembed/src/app/75-topology-actions.js" \
  "$ROOT/webembed/src/app/76-activity-actions.js" \
  "$ROOT/webembed/src/app/78-global-events.js" \
  "$ROOT/webembed/src/app/79-bootstrap.js"
do
  sed -n '1,$p' "$source_file" >> "$APP_TEMP"
done

for source_file in \
  "$ROOT/webembed/src/styles/00-foundation-workloads.css" \
  "$ROOT/webembed/src/styles/10-connections-settings.css" \
  "$ROOT/webembed/src/styles/20-metrics-topology.css" \
  "$ROOT/webembed/src/styles/30-activity-base.css" \
  "$ROOT/webembed/src/styles/31-modal-connection-editor.css" \
  "$ROOT/webembed/src/styles/32-personal-workflows.css" \
  "$ROOT/webembed/src/styles/34-connections-settings.css" \
  "$ROOT/webembed/src/styles/35-activity-workbench.css" \
  "$ROOT/webembed/src/styles/39-responsive-layout.css"
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
