# Embedded frontend source

The dependency-free frontend is organized as ordered build inputs by operator domain. `make web-build` concatenates these inputs into the two assets embedded by Go:

- `app/00-core.js`: shared state, API, routing, shell, and authentication
- `app/10-workloads.js`: workload inventory, filters, saved-view entry points, and investigation route
- `app/20-topology.js`: topology and workload-level metric presentation
- `app/30-connections-settings.js`: connection registry and settings
- `app/40-activity-metrics.js`: live logs, merged streams, parsing/filtering, and metric streams
- `app/50-connection-editor.js`: connection creation, testing, and credential-input flows
- `app/60-personal-workflows.js`: investigations, saved activity views, handoffs, and command palette
- `app/70-runtime-actions.js`: modals, runtime actions, event dispatch, and bootstrap

CSS inputs follow the same ordered layering under `styles/`. The generated files remain committed because they are embedded directly and require no runtime build step. `make check` fails if a generated asset differs from its source inputs.

Pure browser-local data logic remains independently testable in `webembed/dist/personal.js`; terminal sanitization remains in `webembed/dist/terminal-text.js`.
