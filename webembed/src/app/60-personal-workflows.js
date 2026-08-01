
  function currentInvestigationScope() {
    const route = routeInfo();
    if (route.path === "/activity" && state.stream?.request) return { ...state.stream.request, route: location.hash };
    return { route: location.hash, filters: { ...state.filters }, name: state.filters.search || "Runwake investigation" };
  }

  function startInvestigation(name, scope = currentInvestigationScope()) {
    if (!investigationsAvailable()) return null;
    const session = personal.createSession(state.personal, scope, name || scope.name || "Investigation");
    savePersonalState(`${session.name} started`);
    return session;
  }

  function showNewInvestigationModal() {
    if (!investigationsAvailable()) return;
    const suggested = state.stream?.request?.name ? `${state.stream.request.name} investigation` : "New investigation";
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Start investigation</h2><p class="modal-copy">Pinned evidence stays in this browser until you export or delete it.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><label>Name<input id="new-investigation-name" class="field" value="${html(suggested)}" maxlength="160" autofocus></label></div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-new-investigation">Start</button></div>`);
  }

  function pinEvidence(kind, payload) {
    if (!investigationsAvailable()) return null;
    if (!activeInvestigation()) startInvestigation(payload?.workload ? `${payload.workload} investigation` : "Investigation");
    const evidence = personal.addEvidence(state.personal, kind, payload);
    savePersonalState(`${kind === "metric" ? "Metric sample" : "Record"} pinned`);
    return evidence;
  }

  function pinSelectedRecord() {
    if (!investigationsAvailable()) return;
    const selected = selectedLogRecord();
    if (!selected) return toast("Select a record first.", "error");
    const record = selected.record;
    pinEvidence(isRuntimeEventRecord(record) ? "event" : "log", {
      timestamp: record.timestamp,
      type: record.type,
      level: record.level,
      message: record.message,
      source: record.source,
      workload: record.workload || state.stream?.request?.name,
      pod: record.pod,
      container: record.container,
      fields: record.fields,
    });
  }

  function pinLatestMetric() {
    if (!investigationsAvailable()) return;
    const sample = state.metricStream?.samples?.at(-1);
    if (!sample) return toast("No metric sample is available yet.", "error");
    pinEvidence("metric", sample);
  }

  function exportInvestigation(sessionID) {
    if (!investigationsAvailable()) return;
    const session = state.personal.sessions.find(item => item.id === sessionID);
    if (!session) return toast("Investigation not found.", "error");
    const preview = personal.exportBundle(session, []);
    const count = Object.values(preview.counts).reduce((total, value) => total + value, 0);
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Export evidence</h2><p class="modal-copy">Review the automatic redaction result before saving this bundle.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><div class="redaction-summary"><strong>${count} redaction${count === 1 ? "" : "s"} applied</strong><span>${Object.entries(preview.counts).map(([name, value]) => `${html(name)} ${value}`).join(" · ") || "No credential-shaped values detected"}</span></div><label>Additional redaction patterns<textarea id="export-redaction-patterns" class="field mono" rows="5" placeholder="One regular expression per line"></textarea><span class="hint">Patterns are applied case-insensitively to the exported copy only.</span></label><details class="export-preview"><summary>Preview metadata</summary><pre>${html(JSON.stringify({ name: preview.value.investigation.name, evidence: preview.value.investigation.evidence.length, createdAt: preview.value.investigation.createdAt }, null, 2))}</pre></details></div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-export-investigation" data-id="${html(session.id)}">Save JSON</button></div>`, "wide");
  }

  function confirmExportInvestigation(sessionID) {
    if (!investigationsAvailable()) return;
    const session = state.personal.sessions.find(item => item.id === sessionID);
    if (!session) return;
    const patterns = String(document.getElementById("export-redaction-patterns")?.value || "").split("\n").map(value => value.trim()).filter(Boolean);
    try {
      const exported = personal.exportBundle(session, patterns);
      const filename = `runwake-${session.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "investigation"}.json`;
      personal.downloadJSON(filename, exported.value);
      closeModal();
      toast(`Evidence exported · ${Object.values(exported.counts).reduce((sum, value) => sum + value, 0)} redactions`);
    } catch (error) {
      toast(`Export failed: ${error.message}`, "error");
    }
  }

  function showSavedViewsModal() {
    const views = state.personal.views || [];
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Saved views</h2><p class="modal-copy">Filters and scope only; log content is never included.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><div class="saved-view-list">${views.length ? views.map(view => `<div><span><strong>${html(view.name)}</strong><small>${html(view.kind)} · ${html(relativeTime(view.updatedAt))}</small></span><button class="btn ghost small" data-action="apply-saved-view" data-id="${html(view.id)}">Open</button><button class="btn ghost small" data-action="rename-saved-view" data-id="${html(view.id)}">Rename</button><button class="btn ghost small danger" data-action="delete-saved-view" data-id="${html(view.id)}">Delete</button></div>`).join("") : `<div class="investigation-empty">No saved views yet.</div>`}</div></div>${views.length ? `<div class="modal-footer"><button class="btn danger" data-action="reset-saved-views">Delete all saved views</button></div>` : ""}`);
  }

  function showSaveWorkloadViewModal() {
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Save workload view</h2><p class="modal-copy">Stores the current search and filters in this browser.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><label>Name<input id="saved-view-name" class="field" value="${html(state.filters.search || "Workload view")}" maxlength="120" autofocus></label></div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-save-workload-view">Save</button></div>`);
  }

  function saveCurrentWorkloadView() {
    const name = document.getElementById("saved-view-name")?.value.trim();
    if (!name) return toast("Enter a view name.", "error");
    personal.saveView(state.personal, "workloads", name, { filters: { search: state.filters.search, connection: filterValues(state.filters.connection), namespace: filterValues(state.filters.namespace), status: state.filters.status }, browseMode: state.workloadBrowseMode });
    savePersonalState(`${name} saved`);
    closeModal();
    if (state.route?.path === "/workloads") drawWorkloads();
  }

  function showSaveActivityViewModal() {
    const name = state.stream?.request?.targets?.length > 1 ? `${state.stream.request.targets.length} workload logs` : `${state.stream?.request?.name || "Activity"} logs`;
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Save activity view</h2><p class="modal-copy">Stores scope, filters, and formatter preferences. Buffered log content is excluded.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><label>Name<input id="saved-view-name" class="field" value="${html(name)}" maxlength="120" autofocus></label></div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-save-activity-view">Save</button></div>`);
  }

  function saveCurrentActivityView() {
    const name = document.getElementById("saved-view-name")?.value.trim();
    if (!name || !state.stream) return toast("Enter a view name.", "error");
    const filter = currentLogFilter();
    const profile = state.stream.profile;
    personal.saveView(state.personal, "activity", name, { route: location.hash.replace(/^#/, ""), filter: { needle: filter.needle, mode: filter.mode, level: filter.level, source: filter.source, httpPath: filter.httpPath, httpMethod: filter.httpMethod, httpStatus: filter.httpStatus, before: filter.before, after: filter.after }, formatter: { mode: profile.mode, pattern: profile.pattern, template: profile.template } });
    savePersonalState(`${name} saved`);
    closeModal();
  }

  function applyPendingActivityView() {
    const view = state.pendingActivityView;
    if (!view || !state.stream) return;
    state.pendingActivityView = null;
    const values = { "stream-search": view.state?.filter?.needle, "log-find-mode": view.state?.filter?.mode, "log-level-filter": view.state?.filter?.level, "log-source-filter": view.state?.filter?.source, "log-http-path-filter": view.state?.filter?.httpPath, "log-http-method-filter": view.state?.filter?.httpMethod, "log-http-status-filter": view.state?.filter?.httpStatus, "log-context-before": view.state?.filter?.before, "log-context-after": view.state?.filter?.after };
    for (const [id, value] of Object.entries(values)) {
      const input = document.getElementById(id);
      if (!input || value === undefined) continue;
      if (input.options && ![...input.options].some(option => option.value === String(value))) {
        if (id === "log-source-filter") state.stream.pendingSourceFilter = String(value);
        continue;
      }
      input.value = String(value ?? "");
    }
    Object.assign(state.stream.profile, view.state?.formatter || {});
    scheduleActivityRender(true);
  }

  function applySavedView(viewID) {
    const view = state.personal.views.find(item => item.id === viewID);
    if (!view) return toast("Saved view not found.", "error");
    if (view.kind === "workloads") {
      state.filters = { search: String(view.state?.filters?.search || ""), connection: filterValues(view.state?.filters?.connection), namespace: filterValues(view.state?.filters?.namespace), status: String(view.state?.filters?.status || "") };
      state.workloadBrowseMode = view.state?.browseMode || "auto";
      closeModal();
      if (state.route?.path === "/workloads") {
        syncWorkloadFilterControls();
        updateWorkloadView(true);
      } else navigate("/workloads");
    } else if (view.kind === "activity" && view.state?.route) {
      state.pendingActivityView = view;
      closeModal();
      navigate(view.state.route);
    }
  }

  function showRenameSavedViewModal(viewID) {
    const view = state.personal.views.find(item => item.id === viewID);
    if (!view) return;
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Rename saved view</h2></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><label>Name<input id="saved-view-name" class="field" value="${html(view.name)}" maxlength="120" autofocus></label></div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-rename-saved-view" data-id="${html(view.id)}">Rename</button></div>`);
  }

  function deleteSavedView(viewID) {
    personal.removeView(state.personal, viewID);
    savePersonalState("Saved view deleted");
    showSavedViewsModal();
  }

  function openSelectedLogs() {
    const targets = state.workloads.filter(item => state.selectedWorkloads.has(metricKey(item))).slice(0, 12).map(item => ({ connection_id: item.connection_id, kind: item.kind, namespace: item.namespace || "", name: item.name }));
    if (targets.length < 2) return toast("Select at least two workloads.", "error");
    navigate(`/activity?${new URLSearchParams({ targets: JSON.stringify(targets) }).toString()}`);
  }

  function showHandoffModal() {
    const context = currentHandoffContext();
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Observability handoffs</h2><p class="modal-copy">Open the current scope in tools that already store and query telemetry.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><div class="handoff-list">${state.personal.handoffs.map(item => `<label><span><strong>${html(item.name)}</strong><small>Use placeholders such as {namespace}, {workload}, {trace_id}, {start}, and {end}.</small></span><input class="field mono" data-handoff-template="${html(item.id)}" value="${html(item.template)}" placeholder="https://example.com/explore?workload={workload}"><output data-handoff-error="${html(item.id)}"></output></label>`).join("")}</div><div class="handoff-context"><strong>Current context</strong><code>${html(JSON.stringify(context))}</code></div></div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="save-handoffs">Save</button></div>`, "wide");
  }

  function currentHandoffContext(record) {
    const request = state.stream?.request || state.metricStream?.request || {};
    const ids = personal.correlationIDs(record || selectedLogRecord()?.record || {});
    return { connection: request.connection_id || "", namespace: request.namespace || "", workload: record?.workload || request.name || "", kind: request.kind || "", pod: record?.pod || request.pod || "", container: record?.container || request.container || "", trace_id: ids[0]?.value || "", start: activeInvestigation()?.createdAt || "", end: new Date().toISOString() };
  }

  function availableHandoffs(record) {
    const context = currentHandoffContext(record);
    return (state.personal.handoffs || []).filter(item => item.enabled && item.template).map(item => {
      try { return { ...item, url: personal.resolveHandoff(item.template, context) }; }
      catch { return null; }
    }).filter(Boolean);
  }

  function previewHandoff(handoffID, recordIndex) {
    const record = Number.isFinite(recordIndex) ? state.stream?.records?.[recordIndex] : selectedLogRecord()?.record;
    const item = availableHandoffs(record).find(candidate => candidate.id === handoffID);
    if (!item) return toast("That handoff is not configured for this context.", "error");
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Open ${html(item.name)}</h2><p class="modal-copy">Review the generated destination before leaving Runwake.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div><div class="modal-body"><div class="handoff-preview"><span>Destination</span><code>${html(item.url)}</code></div></div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-open-handoff" data-url="${html(item.url)}">Open in new tab</button></div>`);
  }

  function openHandoff(url) {
    let destination;
    try { destination = new URL(url); } catch { return toast("The handoff URL is invalid.", "error"); }
    if (!/^https?:$/.test(destination.protocol)) return toast("Only HTTP and HTTPS handoffs can be opened.", "error");
    window.open(destination.href, "_blank", "noopener,noreferrer");
    closeModal();
  }

  function saveHandoffs() {
    let invalid = false;
    document.querySelectorAll("[data-handoff-template]").forEach(input => {
      const item = state.personal.handoffs.find(candidate => candidate.id === input.dataset.handoffTemplate);
      if (!item) return;
      const validation = input.value ? personal.validateHandoff(input.value) : { ok: true };
      const output = document.querySelector(`[data-handoff-error="${input.dataset.handoffTemplate}"]`);
      if (output) output.textContent = validation.ok ? "" : validation.error;
      input.setAttribute("aria-invalid", String(!validation.ok));
      if (!validation.ok) invalid = true;
      else {
        item.template = input.value.trim();
        item.enabled = Boolean(item.template);
      }
    });
    if (invalid) return;
    savePersonalState("Handoffs saved");
    closeModal();
  }

  function personalCommands() {
    const investigationCommands = investigationsAvailable() ? [
      { id: "investigations", label: "Open investigations", detail: "Navigation", run: () => navigate("/investigations") },
      { id: "new-investigation", label: "Start investigation", detail: "Local workflow", run: showNewInvestigationModal },
    ] : [];
    const base = [
      { id: "workloads", label: "Open workloads", detail: "Navigation", run: () => navigate("/workloads") },
      ...investigationCommands,
      { id: "connections", label: "Open connections", detail: "Navigation", run: () => navigate("/connections") },
      { id: "settings", label: "Open settings", detail: "Navigation", run: () => navigate("/settings") },
      { id: "handoffs", label: "Configure observability handoffs", detail: "Local workflow", run: showHandoffModal },
      { id: "diagnostics", label: "Export redacted diagnostics", detail: "Reliability", run: exportDiagnostics },
    ];
    const views = (state.personal.views || []).map(view => ({ id: `view:${view.id}`, label: `Open ${view.name}`, detail: `Saved ${view.kind} view`, run: () => applySavedView(view.id) }));
    const recents = (state.personal.recents || []).map(item => ({ id: `recent:${item.key}`, label: `Recent: ${item.label}`, detail: item.detail || "Recent target", run: () => navigate(item.route) }));
    const workloads = state.workloads.slice(0, 200).map(item => ({ id: `workload:${metricKey(item)}`, label: item.name, detail: `${item.connection} · ${item.namespace || item.kind}`, run: () => navigate(`/activity?${new URLSearchParams({ connection_id: item.connection_id, kind: item.kind, namespace: item.namespace || "", name: item.name }).toString()}`) }));
    return [...base, ...views, ...recents, ...workloads];
  }

  function showCommandPalette() {
    const commands = personalCommands();
    showModal(`<div class="command-palette"><label class="sr-only" for="command-search">Find a command or workload</label><input id="command-search" class="command-search" type="search" placeholder="Open a workload or run a command…" autocomplete="off" autofocus><div id="command-results" class="command-results">${commandMarkup(commands)}</div><footer><span><kbd>↑↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></footer></div>`, "command-palette-modal");
    const input = document.getElementById("command-search");
    const render = () => {
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      const filtered = commands.filter(command => words.every(word => `${command.label} ${command.detail}`.toLowerCase().includes(word))).slice(0, 40);
      document.getElementById("command-results").innerHTML = commandMarkup(filtered);
      document.querySelector("[data-command-id]")?.classList.add("active");
    };
    input?.addEventListener("input", render);
    input?.addEventListener("keydown", event => {
      const items = [...document.querySelectorAll("[data-command-id]")];
      const current = Math.max(0, items.findIndex(item => item.classList.contains("active")));
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        items[current]?.classList.remove("active");
        items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.classList.add("active");
      } else if (event.key === "Enter") {
        event.preventDefault();
        document.querySelector("[data-command-id].active")?.click();
      }
    });
  }

  function commandMarkup(commands) {
    return commands.length ? commands.map(command => `<button type="button" data-action="execute-command" data-command-id="${html(command.id)}"><strong>${html(command.label)}</strong><small>${html(command.detail)}</small></button>`).join("") : `<div class="command-empty">No matching command or workload.</div>`;
  }

  function executeCommand(commandID) {
    const command = personalCommands().find(item => item.id === commandID);
    if (!command) return;
    closeModal();
    command.run();
  }

  function exportDiagnostics() {
    personal.addDiagnostic(state.personal, { type: "diagnostics_export", route: location.hash, version: state.meta?.version || "", online: navigator.onLine });
    const connection = state.connections.find(item => item.id === (state.stream?.request?.connection_id || state.metricStream?.request?.connection_id));
    const bundle = personal.diagnosticsBundle(state.personal, { route: location.hash, version: state.meta?.version || "", connectionKind: connection?.kind || "", connectionID: connection?.id || "", online: navigator.onLine });
    personal.downloadJSON(`runwake-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, bundle);
    savePersonalState("Diagnostics exported");
  }

  function showModal(content, className = "") {
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="backdrop"><section class="modal ${className}" role="dialog" aria-modal="true">${content}</section></div>`;
  }
  function closeModal() { modalRoot.innerHTML = ""; }
