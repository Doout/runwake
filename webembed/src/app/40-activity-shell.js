
  function normalizedActivityMeta(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s*\/\s*/g, "/")
      .replace(/\s+/g, " ");
  }

  function activityMetaLink(label, request, namespace = "", search = "", ariaLabel = "") {
    return `<button type="button" class="activity-meta-link" data-action="filter-workloads-from-activity" data-connection="${html(request.connection_id)}" data-namespace="${html(namespace)}" data-search="${html(search)}" aria-label="${html(ariaLabel)}">${html(label)}</button>`;
  }

  function activityMetaHTML(request, connection, workload) {
    if (request.targets?.length > 1) {
      const connections = new Set(request.targets.map(item => item.connection_id));
      const namespaces = new Set(request.targets.map(item => item.namespace).filter(Boolean));
      return `<span>${request.targets.length} workloads</span><span>${connections.size} connection${connections.size === 1 ? "" : "s"}</span>${namespaces.size ? `<span>${namespaces.size} namespace${namespaces.size === 1 ? "" : "s"}</span>` : ""}<span class="status good">Merged live stream</span>`;
    }
    const stateText = workload?.state || "State unavailable";
    const ready = workload?.desired ? `${Number(workload.ready || 0)}/${workload.desired} ready` : "";
    const connectionName = connection?.name || request.connection_id;
    const showReady = ready && normalizedActivityMeta(ready) !== normalizedActivityMeta(stateText);
    return [
      activityMetaLink(connectionName, request, "", "", `Show workloads from ${connectionName}`),
      request.namespace
        ? activityMetaLink(request.namespace, request, request.namespace, "", `Show workloads in ${request.namespace}`)
        : "",
      activityMetaLink(request.kind, request, request.namespace, request.kind, `Show ${request.kind} workloads`),
      `<span class="status ${workload ? statusBucket(workload) : "other"}">${html(stateText)}</span>`,
      showReady ? `<span>${html(ready)}</span>` : "",
      workload?.restarts ? `<span>${workload.restarts} restarts</span>` : "",
    ].join("");
  }

  function activityTargets(params) {
    return navigation.activityTargets(params);
  }

  function activityQuery(request, extra = {}) {
    return navigation.activityQuery(request, extra);
  }

  function renderActivity(params) {
    const renderID = ++state.activityRenderID;
    const targets = activityTargets(params);
    const request = {
      connection_id: targets[0]?.connection_id || params.get("connection_id") || "",
      kind: targets[0]?.kind || params.get("kind") || "",
      namespace: targets[0]?.namespace || params.get("namespace") || "",
      name: targets[0]?.name || params.get("name") || "",
      pod: params.get("pod") || "",
      container: params.get("container") || "",
      topology_project: params.get("topology_project") || "",
      targets,
    };
    const view = targets.length > 1 ? "activity" : params.get("view") === "metrics" ? "metrics" : "activity";
    if (!request.connection_id || !request.kind || !request.name) {
      navigate("/workloads");
      return;
    }
    const workload = state.workloads.find(item => matchesWorkloadRequest(item, request));
    const connection = state.connections.find(item => item.id === request.connection_id);
    const title = targets.length > 1 ? `${targets.length} workloads` : workload?.name || request.name;
    personal.addRecent(state.personal, { key: `activity:${JSON.stringify(targets)}`, label: title, detail: targets.length > 1 ? "Merged live logs" : `${connection?.name || request.connection_id} · ${request.namespace || request.kind}`, route: location.hash.replace(/^#/, "") });
    savePersonalState();
    const scopeEnabled = targets.length < 2 && supportsLogScope(request, connection);
    const targetProfile = logTargetProfile(request, workload);
    const content = view === "metrics" ? `
      <div id="metric-status" class="notice info stream-status">Opening metrics stream…</div>
      <dl class="metric-strip">
        <div><dt>CPU</dt><dd id="metric-cpu">—</dd></div>
        <div><dt>Memory</dt><dd id="metric-memory">—</dd></div>
        <div><dt>Network received</dt><dd id="metric-network-rx">—</dd></div>
        <div><dt>Processes</dt><dd id="metric-pids">—</dd></div>
      </dl>
      <div class="metric-plots">
        <section class="metric-plot"><div class="section-head"><h2 class="section-title">CPU</h2><span id="metric-cpu-unit" class="hint"></span></div><div id="metric-cpu-chart" class="metric-chart"><div class="stream-state">Waiting for samples…</div></div></section>
        <section class="metric-plot"><div class="section-head"><h2 class="section-title">Memory</h2><span id="metric-memory-unit" class="hint">Working set</span></div><div id="metric-memory-chart" class="metric-chart"><div class="stream-state">Waiting for samples…</div></div></section>
      </div>
      <section class="metric-containers"><div class="section-head"><h2 class="section-title">Containers</h2><span id="metric-source" class="hint"></span></div><div id="metric-container-table" class="table-wrap"><div class="stream-state">Waiting for samples…</div></div></section>` : `
      <section class="log-workbench inspector-collapsed" aria-label="Log workbench">
        ${scopeEnabled ? renderLogScope(targetProfile) : ""}
        <div class="log-command-layer">
        <div class="log-commandbar">
          <div class="log-find">
            <span class="log-find-icon" aria-hidden="true">⌕</span>
            <input id="stream-search" class="field" type="search" autocomplete="off" placeholder="Find in live buffer">
            <span id="log-match-count" class="log-match-count">No query</span>
          </div>
          <div class="log-match-navigation" aria-label="Match navigation">
            <button type="button" class="btn small icon-button" data-action="previous-log-match" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled>↑</button>
            <button type="button" class="btn small icon-button" data-action="next-log-match" aria-label="Next match" title="Next match (Enter)" disabled>↓</button>
            <button type="button" class="btn small icon-button" data-action="log-jump-back" aria-label="Back to previous log position" title="Back to previous log position (Alt+Left)" disabled>←</button>
            <button type="button" class="btn small icon-button" data-action="log-jump-forward" aria-label="Forward to next log position" title="Forward to next log position (Alt+Right)" disabled>→</button>
          </div>
          ${renderLogFormatMenu(logFormatterProfile(request).mode)}
          <label class="toggle log-follow"><input id="stream-follow" type="checkbox" checked> Follow</label>
          <button type="button" class="btn small" data-action="toggle-log-filters" aria-controls="log-filter-panel" aria-expanded="false">Filters <span id="log-filter-count" class="log-filter-badge" hidden></span></button>
          <button type="button" class="btn small" data-action="toggle-log-inspector" aria-controls="log-inspector" aria-expanded="false">Inspector</button>
          <button type="button" class="btn small" data-action="toggle-log-formatter" aria-expanded="false">Format rule</button>
          <button type="button" class="btn small icon-button" data-action="toggle-log-shortcuts" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</button>
        </div>
        <div id="log-filter-panel" class="log-tool-panel log-filter-popover" aria-label="Log filters" hidden>
          <div class="log-tool-panel-heading"><div><strong>Filter logs</strong><small>Narrow this live buffer without changing it.</small></div><button type="button" class="btn ghost small" data-action="clear-log-filters" disabled>Reset</button></div>
          <div class="log-filter-grid">
            <div class="log-filter-primary">
              <label>Level<select id="log-level-filter"><option value="">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option><option value="debug">Debug / trace</option><option value="system">Runtime events</option></select></label>
              <label>Source<select id="log-source-filter"><option value="">All sources</option></select></label>
            </div>
            <div class="log-filter-builder">
              <div id="log-filter-row-path" class="log-filter-condition" hidden>
                <label>HTTP path<input id="log-http-path-filter" class="field mono" placeholder="/v1/auth"></label>
                <button type="button" class="btn ghost icon-button" data-action="remove-log-filter" data-filter="path" aria-label="Remove HTTP path filter" title="Remove filter">×</button>
              </div>
              <div id="log-filter-row-method" class="log-filter-condition" hidden>
                <label>Method<select id="log-http-method-filter"><option value="">Any method</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>OPTIONS</option><option>HEAD</option></select></label>
                <button type="button" class="btn ghost icon-button" data-action="remove-log-filter" data-filter="method" aria-label="Remove method filter" title="Remove filter">×</button>
              </div>
              <div id="log-filter-row-status" class="log-filter-condition" hidden>
                <label>Status<select id="log-http-status-filter"><option value="">Any status</option><option value="2xx">2xx</option><option value="3xx">3xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option></select></label>
                <button type="button" class="btn ghost icon-button" data-action="remove-log-filter" data-filter="status" aria-label="Remove status filter" title="Remove filter">×</button>
              </div>
              <div id="log-filter-row-regex" class="log-filter-condition" hidden>
                <label>Find mode<select id="log-find-mode"><option value="text">Plain text</option><option value="regex">Regular expression</option></select></label>
                <button type="button" class="btn ghost icon-button" data-action="remove-log-filter" data-filter="regex" aria-label="Remove find mode filter" title="Remove filter">×</button>
              </div>
              <div id="log-filter-row-context" class="log-filter-condition context" hidden>
                <label>Before<input id="log-context-before" class="field" type="number" min="0" max="100" value="0"></label>
                <label>After<input id="log-context-after" class="field" type="number" min="0" max="100" value="0"></label>
                <button type="button" class="btn ghost icon-button" data-action="remove-log-filter" data-filter="context" aria-label="Remove match context filter" title="Remove filter">×</button>
              </div>
              <div class="log-filter-add-wrap">
                <button type="button" class="log-filter-add-button" data-action="toggle-log-filter-picker" aria-controls="log-filter-picker" aria-expanded="false"><span aria-hidden="true">+</span> Add filter</button>
                <div id="log-filter-picker" class="log-filter-picker" hidden>
                  <button type="button" data-action="add-log-filter" data-filter="path"><span>HTTP path</span><small>Match part of a request path</small></button>
                  <button type="button" data-action="add-log-filter" data-filter="method"><span>Method</span><small>GET, POST, PUT, and more</small></button>
                  <button type="button" data-action="add-log-filter" data-filter="status"><span>Status</span><small>Filter by HTTP status class</small></button>
                  <button type="button" data-action="add-log-filter" data-filter="regex"><span>Regular expression</span><small>Interpret the search query as regex</small></button>
                  <button type="button" data-action="add-log-filter" data-filter="context"><span>Match context</span><small>Show lines before and after matches</small></button>
                </div>
              </div>
            </div>
            <details class="log-filter-stream">
              <summary><span><strong>Stream</strong><small>Previous logs · ${html(state.settings?.default_tail_lines ?? 200)} lines</small></span><span class="log-filter-stream-action">Change <span aria-hidden="true">›</span></span></summary>
              <div class="log-filter-stream-body">
                <label class="toggle"><input id="stream-previous" type="checkbox" checked> Previous logs</label>
                <label>Initial tail<input id="stream-tail" class="field" type="number" min="0" max="100000" value="${html(state.settings?.default_tail_lines ?? 200)}"></label>
                <div class="log-stream-actions"><button type="button" class="btn small" data-action="reconnect-stream">Reconnect</button><button type="button" class="btn small danger" data-action="clear-stream">Clear buffer</button></div>
              </div>
            </details>
          </div>
          <div id="log-filter-error" class="log-inline-error" hidden></div>
        </div>
        </div>
        <div id="log-formatter-panel" class="log-tool-panel" hidden>
          <div class="log-tool-panel-heading"><div><strong>Custom formatter</strong><small>Use named regular-expression captures in the output template.</small></div><button type="button" class="btn ghost small" data-action="reset-log-formatter">Reset</button></div>
          <div class="log-formatter-grid">
            <label>Pattern<input id="log-custom-pattern" class="field mono" placeholder="^(?&lt;time&gt;\\S+) (?&lt;level&gt;\\w+) (?&lt;message&gt;.*)$"></label>
            <label>Output template<input id="log-custom-template" class="field mono" placeholder="$level · $message"></label>
          </div>
          <div id="log-formatter-preview" class="log-formatter-preview">Select a record to preview this rule.</div>
        </div>
        <div id="log-shortcut-panel" class="log-shortcut-panel" hidden>
          <span><kbd>⌘/Ctrl F</kbd> Find</span><span><kbd>Enter</kbd> Next</span><span><kbd>Shift Enter</kbd> Previous</span><span><kbd>Alt ←</kbd> Back</span><span><kbd>/</kbd> Find</span><span><kbd>Esc</kbd> Clear</span><span><kbd>End</kbd> Latest</span>
        </div>
        <div class="log-stage-grid">
          <div class="log-evidence">
            <div class="log-stream-state"><div class="log-stream-primary"><span id="stream-status" class="log-status" role="status" aria-live="polite" aria-atomic="true">Opening live stream…</span><label class="log-events-toggle" title="Include runtime events"><input id="stream-events" type="checkbox"> Events</label></div><div class="log-stream-meta"><span id="log-buffer-count">0 records</span><output id="log-position" class="log-position">0%</output></div></div>
            <div class="log-canvas">
              <div id="stream" class="stream" tabindex="0" aria-label="Live log records"><div class="stream-state">Waiting for records…</div></div>
              <div id="log-position-rail" class="log-position-rail" aria-hidden="true"><span id="log-position-thumb"></span><div id="log-match-markers"></div></div>
            </div>
          </div>
          <aside id="log-inspector" class="log-inspector matches-idle" aria-label="Log navigation and record details" hidden>
            <section class="log-results-section">
              <div class="log-inspector-heading"><div><strong>Matches</strong><small id="log-results-summary">Add a query or filter</small></div><button type="button" class="btn ghost small" data-action="toggle-log-inspector">Close</button></div>
              <div id="log-results" class="log-results"><div class="log-inspector-empty">Search or apply filters to build a jump list.</div></div>
            </section>
            <section id="log-record-inspector" class="log-record-inspector">
              <div class="log-inspector-heading"><div><strong>Record</strong><small>Select a line to inspect or reformat.</small></div>${investigationsAvailable() ? `<button type="button" class="btn ghost small" data-action="pin-selected-record" disabled>Pin</button>` : ""}</div>
              <div id="log-record-detail" class="log-record-detail"><div class="log-inspector-empty">Select a log line.</div></div>
            </section>
          </aside>
        </div>
      </section>`;
    shell(`<section class="page activity-page ${view === "activity" ? "activity-page-live" : ""}">
      <header class="page-header activity-header">
        <div><button type="button" class="btn ghost small activity-back" data-action="back-workloads">← Workloads</button><h1 id="activity-title" class="page-title activity-title">${html(title)}</h1><div id="activity-meta" class="activity-meta">${activityMetaHTML(request, connection, workload)}</div></div>
        <div class="header-actions"><button type="button" class="btn" data-action="save-activity-view">Save view</button>${investigationsAvailable() ? activeInvestigation() ? `<button type="button" class="btn" data-nav="/investigations">${html(activeInvestigation().name)} · ${activeInvestigation().evidence.length}</button>` : `<button type="button" class="btn" data-action="new-investigation">Start investigation</button>` : ""}${view === "metrics" && investigationsAvailable() ? `<button type="button" class="btn primary" data-action="pin-latest-metric">Pin latest sample</button>` : ""}</div>
      </header>
      ${workloadViewTabs(request, view, workload)}
      ${content}
    </section>`, "workloads");
    if (view === "metrics") {
      startMetricStream(request);
    } else {
      bindActivityControls(request);
      startActivityStream(request);
      applyPendingActivityView();
    }
    hydrateActivityContext(request, renderID);
  }

  async function hydrateActivityContext(request, renderID) {
    const pending = [];
    if (!state.settings) pending.push(loadSettings());
    if (!state.connections.length) pending.push(loadConnections());
    if (!state.workloads.length) pending.push(loadWorkloads());
    if (!pending.length) return;
    try {
      await Promise.all(pending);
    } catch (error) {
      if (!(error instanceof AuthenticationRequired)) toast(`Workload details: ${error.message}`, "error");
      return;
    }
    if (renderID !== state.activityRenderID || state.route?.path !== "/activity") return;
    const workload = state.workloads.find(item => matchesWorkloadRequest(item, request));
    const connection = state.connections.find(item => item.id === request.connection_id);
    const title = document.getElementById("activity-title");
    const meta = document.getElementById("activity-meta");
    const tabs = document.getElementById("workload-view-tabs");
    if (title) title.textContent = request.targets?.length > 1 ? `${request.targets.length} workloads` : workload?.name || request.name;
    if (meta) meta.innerHTML = activityMetaHTML(request, connection, workload);
    if (tabs) tabs.outerHTML = workloadViewTabs(request, paramsView(), workload);
    updateLogTargetOptions(null, logTargetProfile(request, workload));
  }

  function paramsView() {
    return routeInfo().params.get("view") === "metrics" ? "metrics" : "activity";
  }

  function workloadViewTabs(request, view, workload) {
    const encodedRequest = encodeURIComponent(JSON.stringify(request));
    const project = request.topology_project || composeProjectName(workload);
    const topologyRequest = project && String(request.kind || "").toLowerCase() === "container"
      ? encodeURIComponent(JSON.stringify({ connection_id: request.connection_id, project, focus: workload?.name || request.name }))
      : "";
    return `<nav id="workload-view-tabs" class="view-tabs" aria-label="Workload view">
      <button type="button" class="view-tab ${view === "activity" ? "active" : ""}" data-action="show-activity-view" data-request="${encodedRequest}">Logs</button>
      ${request.targets?.length > 1 ? "" : `<button type="button" class="view-tab ${view === "metrics" ? "active" : ""}" data-action="show-metrics-view" data-request="${encodedRequest}">Metrics</button>`}
      ${request.targets?.length > 1 ? "" : topologyRequest ? `<button type="button" class="view-tab ${view === "topology" ? "active" : ""}" data-action="show-topology-view" data-topology-request="${topologyRequest}">Topology</button>` : ""}
    </nav>`;
  }

  function bindActivityControls(request) {
    document.getElementById("stream-events")?.addEventListener("change", event => {
      const level = document.getElementById("log-level-filter");
      if (!event.target.checked && level?.value === "system") level.value = "";
      const retained = (state.stream?.records || []).filter(record => event.target.checked || !isRuntimeEventRecord(record));
      startActivityStream(request, retained, { liveOnly: true });
    });
    document.getElementById("stream-previous")?.addEventListener("change", () => startActivityStream(request));
    document.getElementById("stream-tail")?.addEventListener("change", () => startActivityStream(request));
    const profile = logFormatterProfile(request);
    const formatter = document.getElementById("log-formatter");
    const pattern = document.getElementById("log-custom-pattern");
    const template = document.getElementById("log-custom-template");
    if (formatter) formatter.value = profile.mode;
    updateLogFormatMenu(profile.mode);
    if (pattern) pattern.value = profile.pattern;
    if (template) template.value = profile.template;
    document.getElementById("stream-search")?.addEventListener("input", () => scheduleActivityRender(true));
    for (const id of ["log-level-filter", "log-source-filter", "log-http-path-filter", "log-http-method-filter", "log-http-status-filter", "log-find-mode", "log-context-before", "log-context-after"]) {
      document.getElementById(id)?.addEventListener("input", () => scheduleActivityRender(true));
      document.getElementById(id)?.addEventListener("change", () => scheduleActivityRender(true));
    }
    document.getElementById("log-level-filter")?.addEventListener("change", event => {
      const events = document.getElementById("stream-events");
      if (event.target.value === "system" && events && !events.checked) {
        events.checked = true;
        events.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    document.querySelectorAll("[data-log-menu-search]").forEach(input => {
      input.addEventListener("input", event => filterLogMenuOptions(event.target.closest(".log-menu-field"), event.target.value));
    });
    formatter?.addEventListener("change", event => {
      profile.mode = event.target.value;
      updateLogFormatMenu(profile.mode);
      if (profile.mode === "custom") setLogToolPanel("formatter", true);
      scheduleActivityRender(true);
    });
    const updateCustomFormatter = () => {
      profile.pattern = pattern?.value || "";
      profile.template = template?.value || "";
      profile.mode = "custom";
      if (formatter) formatter.value = "custom";
      updateLogFormatMenu("custom");
      scheduleActivityRender(true);
      renderLogFormatterPreview();
    };
    pattern?.addEventListener("input", debounce(updateCustomFormatter, 120));
    template?.addEventListener("input", debounce(updateCustomFormatter, 120));
    document.getElementById("stream-follow")?.addEventListener("change", event => {
      if (event.target.checked) {
        scrollLogToLatest();
        setStreamStatus("Live · following latest", "info");
      } else {
        setStreamStatus("Paused · live logs still buffering", "warning");
      }
    });
    const stream = document.getElementById("stream");
    stream?.addEventListener("scroll", () => scheduleLogPositionUpdate(true), { passive: true });
  }

  function matchesWorkloadRequest(item, request) {
    return String(item.connection_id || "") === String(request.connection_id || "")
      && String(item.kind || "").trim().toLowerCase() === String(request.kind || "").trim().toLowerCase()
      && String(item.namespace || "") === String(request.namespace || "")
      && String(item.name || "") === String(request.name || "");
  }
