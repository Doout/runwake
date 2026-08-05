# Embedded frontend source

The dependency-free frontend is organized as ordered build inputs by operator domain. `make web-build` concatenates these inputs into the two assets embedded by Go:

- `app/00-core.js`: shared state, API, routing, shell, and authentication
- `app/10-workloads.js` and `app/12-workload-support.js`: workload inventory, filters, virtualization, shared metric formatting, and controls
- `app/20-topology.js`: topology presentation and interaction helpers
- `app/30-connections-settings.js`: connection registry and settings
- `app/40-activity-shell.js` through `app/44-log-formatters.js`: activity layout, scope selection, live streams, rendering, inspection, parsing, and formatting
- `app/50-connection-editor.js` through `app/53-agent-deployment.js`: connection forms, cloud imports, validation/submission, and agent deployment
- `app/60-personal-workflows.js` and `app/61-investigations.js`: investigations, saved views, handoffs, diagnostics, and command palette
- `app/70-runtime-dialogs.js`: protected runtime and connection confirmation dialogs
- `app/71-connection-actions.js` through `app/76-activity-actions.js`: domain-owned action handlers registered with the shared dispatcher
- `app/78-global-events.js` and `app/79-bootstrap.js`: cross-domain keyboard/pointer delegation and application bootstrap

CSS inputs follow the same ordered layering under `styles/`: foundation and domain surfaces first, followed by one intentional final responsive-coordination layer. Modal/connection-editor, personal-workflow, connection/settings, and activity-workbench rules have independent owners. The generated files remain committed because they are embedded directly and require no runtime build step. `make check` fails if a generated asset differs from its source inputs.

Pure browser-local data logic remains independently testable in `webembed/dist/personal.js`; terminal sanitization remains in `webembed/dist/terminal-text.js`.
