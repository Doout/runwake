---
version: 1
slug: "webembed-dist-app-js"
primary_target: "webembed/dist/app.js"
related_targets: ["webembed/dist/styles.css"]
---

Scope: Workloads activity/log workbench, Connections, Settings, and their responsive states. Mode: Operate.

Audience and job: SREs and platform operators need to establish runtime access, tune a few safe defaults, then inspect high-volume live logs without losing place or context.

Primary tasks: scan connection health, route, and access mode; add/test access; opt a Docker connection into narrowly scoped runtime actions; restart or delete a Docker container with protected confirmation; restart a Compose project; change common settings without reading infrastructure internals; search and filter an active bounded log buffer; inspect structured or malformed records; expand lines around a match; jump among matches and return to the prior position.

Constraints: live and browser-memory only; no log persistence or durable indexing; no diagnosis claims; default every connection to view-only and expose Docker mutation controls only for explicit manage access; use Runwake's custom trigger-and-overlay component for every new or modified user-facing dropdown; keyboard and pointer parity; stable controls during refresh and state changes; same UI in web and desktop.

Direction: Fixed Operator Instrument Panel. Registry rows replace connection card galleries. Settings follows frequency in three tiers. Logs use a fixed command strip, dominant evidence canvas, position rail, and reversible result navigator.

Memorable moment: a match result opens its exact log line with requested before/after context, the position rail marks where it sits in the current buffer, and Back returns to the operator's prior viewport.

Unresolved: whether formatter definitions eventually persist per connection or remain browser-session state; current implementation keeps them in browser memory.
