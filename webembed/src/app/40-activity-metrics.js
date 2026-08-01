
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
            <button class="btn small icon-button" data-action="previous-log-match" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled>↑</button>
            <button class="btn small icon-button" data-action="next-log-match" aria-label="Next match" title="Next match (Enter)" disabled>↓</button>
            <button class="btn small icon-button" data-action="log-jump-back" aria-label="Back to previous log position" title="Back to previous log position (Alt+Left)" disabled>←</button>
            <button class="btn small icon-button" data-action="log-jump-forward" aria-label="Forward to next log position" title="Forward to next log position (Alt+Right)" disabled>→</button>
          </div>
          ${renderLogFormatMenu(logFormatterProfile(request).mode)}
          <label class="toggle log-follow"><input id="stream-follow" type="checkbox" checked> Follow</label>
          <button class="btn small" data-action="toggle-log-filters" aria-controls="log-filter-panel" aria-expanded="false">Filters <span id="log-filter-count" class="log-filter-badge" hidden></span></button>
          <button class="btn small" data-action="toggle-log-inspector" aria-controls="log-inspector" aria-expanded="false">Inspector</button>
          <button class="btn small" data-action="toggle-log-formatter" aria-expanded="false">Format rule</button>
          <button class="btn small icon-button" data-action="toggle-log-shortcuts" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</button>
        </div>
        <div id="log-filter-panel" class="log-tool-panel log-filter-popover" aria-label="Log filters" hidden>
          <div class="log-tool-panel-heading"><div><strong>Filter logs</strong><small>Narrow this live buffer without changing it.</small></div><button class="btn ghost small" data-action="clear-log-filters" disabled>Reset</button></div>
          <div class="log-filter-grid">
            <div class="log-filter-primary">
              <label>Level<select id="log-level-filter"><option value="">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option><option value="debug">Debug / trace</option><option value="system">Runtime events</option></select></label>
              <label>Source<select id="log-source-filter"><option value="">All sources</option></select></label>
            </div>
            <div class="log-filter-builder">
              <div id="log-filter-row-path" class="log-filter-condition" hidden>
                <label>HTTP path<input id="log-http-path-filter" class="field mono" placeholder="/v1/auth"></label>
                <button class="btn ghost icon-button" data-action="remove-log-filter" data-filter="path" aria-label="Remove HTTP path filter" title="Remove filter">×</button>
              </div>
              <div id="log-filter-row-method" class="log-filter-condition" hidden>
                <label>Method<select id="log-http-method-filter"><option value="">Any method</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option><option>OPTIONS</option><option>HEAD</option></select></label>
                <button class="btn ghost icon-button" data-action="remove-log-filter" data-filter="method" aria-label="Remove method filter" title="Remove filter">×</button>
              </div>
              <div id="log-filter-row-status" class="log-filter-condition" hidden>
                <label>Status<select id="log-http-status-filter"><option value="">Any status</option><option value="2xx">2xx</option><option value="3xx">3xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option></select></label>
                <button class="btn ghost icon-button" data-action="remove-log-filter" data-filter="status" aria-label="Remove status filter" title="Remove filter">×</button>
              </div>
              <div id="log-filter-row-regex" class="log-filter-condition" hidden>
                <label>Find mode<select id="log-find-mode"><option value="text">Plain text</option><option value="regex">Regular expression</option></select></label>
                <button class="btn ghost icon-button" data-action="remove-log-filter" data-filter="regex" aria-label="Remove find mode filter" title="Remove filter">×</button>
              </div>
              <div id="log-filter-row-context" class="log-filter-condition context" hidden>
                <label>Before<input id="log-context-before" class="field" type="number" min="0" max="100" value="0"></label>
                <label>After<input id="log-context-after" class="field" type="number" min="0" max="100" value="0"></label>
                <button class="btn ghost icon-button" data-action="remove-log-filter" data-filter="context" aria-label="Remove match context filter" title="Remove filter">×</button>
              </div>
              <div class="log-filter-add-wrap">
                <button class="log-filter-add-button" data-action="toggle-log-filter-picker" aria-controls="log-filter-picker" aria-expanded="false"><span aria-hidden="true">+</span> Add filter</button>
                <div id="log-filter-picker" class="log-filter-picker" hidden>
                  <button data-action="add-log-filter" data-filter="path"><span>HTTP path</span><small>Match part of a request path</small></button>
                  <button data-action="add-log-filter" data-filter="method"><span>Method</span><small>GET, POST, PUT, and more</small></button>
                  <button data-action="add-log-filter" data-filter="status"><span>Status</span><small>Filter by HTTP status class</small></button>
                  <button data-action="add-log-filter" data-filter="regex"><span>Regular expression</span><small>Interpret the search query as regex</small></button>
                  <button data-action="add-log-filter" data-filter="context"><span>Match context</span><small>Show lines before and after matches</small></button>
                </div>
              </div>
            </div>
            <details class="log-filter-stream">
              <summary><span><strong>Stream</strong><small>Previous logs · ${html(state.settings?.default_tail_lines ?? 200)} lines</small></span><span class="log-filter-stream-action">Change <span aria-hidden="true">›</span></span></summary>
              <div class="log-filter-stream-body">
                <label class="toggle"><input id="stream-previous" type="checkbox" checked> Previous logs</label>
                <label>Initial tail<input id="stream-tail" class="field" type="number" min="0" max="100000" value="${html(state.settings?.default_tail_lines ?? 200)}"></label>
                <div class="log-stream-actions"><button class="btn small" data-action="reconnect-stream">Reconnect</button><button class="btn small danger" data-action="clear-stream">Clear buffer</button></div>
              </div>
            </details>
          </div>
          <div id="log-filter-error" class="log-inline-error" hidden></div>
        </div>
        </div>
        <div id="log-formatter-panel" class="log-tool-panel" hidden>
          <div class="log-tool-panel-heading"><div><strong>Custom formatter</strong><small>Use named regular-expression captures in the output template.</small></div><button class="btn ghost small" data-action="reset-log-formatter">Reset</button></div>
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
              <div class="log-inspector-heading"><div><strong>Matches</strong><small id="log-results-summary">Add a query or filter</small></div><button class="btn ghost small" data-action="toggle-log-inspector">Close</button></div>
              <div id="log-results" class="log-results"><div class="log-inspector-empty">Search or apply filters to build a jump list.</div></div>
            </section>
            <section id="log-record-inspector" class="log-record-inspector">
              <div class="log-inspector-heading"><div><strong>Record</strong><small>Select a line to inspect or reformat.</small></div>${investigationsAvailable() ? `<button class="btn ghost small" data-action="pin-selected-record" disabled>Pin</button>` : ""}</div>
              <div id="log-record-detail" class="log-record-detail"><div class="log-inspector-empty">Select a log line.</div></div>
            </section>
          </aside>
        </div>
      </section>`;
    shell(`<section class="page activity-page ${view === "activity" ? "activity-page-live" : ""}">
      <header class="page-header activity-header">
        <div><button class="btn ghost small activity-back" data-action="back-workloads">← Workloads</button><h1 id="activity-title" class="page-title activity-title">${html(title)}</h1><div id="activity-meta" class="activity-meta">${activityMetaHTML(request, connection, workload)}</div></div>
        <div class="header-actions"><button class="btn" data-action="save-activity-view">Save view</button>${investigationsAvailable() ? activeInvestigation() ? `<button class="btn" data-nav="/investigations">${html(activeInvestigation().name)} · ${activeInvestigation().evidence.length}</button>` : `<button class="btn" data-action="new-investigation">Start investigation</button>` : ""}${view === "metrics" && investigationsAvailable() ? `<button class="btn primary" data-action="pin-latest-metric">Pin latest sample</button>` : ""}</div>
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
      <button class="view-tab ${view === "activity" ? "active" : ""}" data-action="show-activity-view" data-request="${encodedRequest}">Logs</button>
      ${request.targets?.length > 1 ? "" : `<button class="view-tab ${view === "metrics" ? "active" : ""}" data-action="show-metrics-view" data-request="${encodedRequest}">Metrics</button>`}
      ${request.targets?.length > 1 ? "" : topologyRequest ? `<button class="view-tab ${view === "topology" ? "active" : ""}" data-action="show-topology-view" data-topology-request="${topologyRequest}">Topology</button>` : ""}
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

  function logFormatterProfile(request) {
    const key = activityWorkloadKey(request);
    let profile = state.logFormatterByWorkload.get(key);
    if (!profile) {
      profile = { mode: "auto", pattern: "", template: "$message", overrides: new Map() };
      state.logFormatterByWorkload.set(key, profile);
    }
    return profile;
  }

  function activityWorkloadKey(request) {
    return [request.connection_id, request.namespace, request.kind, request.name].join("|");
  }

  function supportsLogScope(request, connection) {
    if (connection?.kind === "docker") return false;
    return !["container", "composeproject", "compose project"].includes(String(request.kind || "").trim().toLowerCase());
  }

  function logTargetProfile(request, workload) {
    const key = activityWorkloadKey(request);
    let profile = state.logTargetsByWorkload.get(key);
    if (!profile) {
      profile = { pods: new Set(), containers: new Set(), selectedPod: "", selectedContainer: "" };
      state.logTargetsByWorkload.set(key, profile);
    }
    if (String(request.kind || "").toLowerCase() === "pod" && request.name) profile.pods.add(request.name);
    for (const container of workload?.containers || []) if (container) profile.containers.add(container);
    if (request.pod) profile.pods.add(request.pod);
    if (request.container) profile.containers.add(request.container);
    profile.selectedPod = request.pod || "";
    profile.selectedContainer = request.container || "";
    return profile;
  }

  function renderLogScope(profile) {
    return `<div class="log-scope-bar">
      <div class="log-scope-intro">
        <span class="log-scope-signal" aria-hidden="true"></span>
        <div><strong>Stream scope</strong><small id="log-scope-summary">${html(logScopeSummary(profile))}</small></div>
      </div>
      <div class="log-scope-controls">
        ${renderLogTargetMenu("pod", "Pod", profile.pods, profile.selectedPod, "All pods")}
        ${renderLogTargetMenu("container", "Container", profile.containers, profile.selectedContainer, "All containers")}
        <button class="btn ghost small" data-action="reset-log-scope" ${profile.selectedPod || profile.selectedContainer ? "" : "hidden"}>Reset</button>
      </div>
    </div>`;
  }

  function renderLogTargetMenu(target, label, values, selected, allLabel) {
    const menuID = `log-${target}-menu`;
    const optionsID = `${menuID}-options`;
    const optionCount = values.size + 1;
    return `<div class="log-menu-field" data-log-target="${target}">
      <span class="log-menu-caption">${html(label)}</span>
      <input id="stream-${target}" type="hidden" value="${html(selected)}">
      <button type="button" class="log-menu-trigger" data-action="toggle-log-menu" aria-label="${html(label)}: ${html(selected || allLabel)}" aria-haspopup="dialog" aria-controls="${menuID}" aria-expanded="false">
        <span data-log-menu-label>${html(selected || allLabel)}</span><span class="log-menu-chevron" aria-hidden="true"></span>
      </button>
      <div id="${menuID}" class="log-menu" role="dialog" aria-label="Choose ${html(label.toLowerCase())}" hidden>
        ${renderLogMenuSearch(`Search ${label.toLowerCase()}…`, optionsID)}
        <div class="log-menu-results-meta" data-log-menu-summary>${optionCount} options</div>
        <div id="${optionsID}" role="listbox" aria-label="${html(label)} options" data-log-menu-options>${logTargetOptions(values, selected, allLabel, target)}</div>
        ${renderLogMenuEmpty()}
      </div>
    </div>`;
  }

  function renderLogFormatMenu(selected) {
    const options = logFormatOptions();
    const menuID = "log-format-menu";
    const optionsID = `${menuID}-options`;
    return `<div class="log-menu-field log-formatter-control" data-log-format-menu>
      <span class="log-menu-caption">Format</span>
      <input id="log-formatter" type="hidden" value="${html(selected)}">
      <button type="button" class="log-menu-trigger" data-action="toggle-log-menu" aria-label="Format: ${html(logFormatLabel(selected))}" aria-haspopup="dialog" aria-controls="${menuID}" aria-expanded="false">
        <span data-log-menu-label>${html(logFormatLabel(selected))}</span><span class="log-menu-chevron" aria-hidden="true"></span>
      </button>
      <div id="${menuID}" class="log-menu log-format-menu" role="dialog" aria-label="Choose log format" hidden>
        ${renderLogMenuSearch("Search formats…", optionsID)}
        <div class="log-menu-results-meta" data-log-menu-summary>${options.length} options</div>
        <div id="${optionsID}" role="listbox" aria-label="Log format options" data-log-menu-options>
          ${options.map(option => `<button type="button" class="log-menu-option ${option.value === selected ? "selected" : ""}" role="option" aria-selected="${option.value === selected}" data-action="select-log-format" data-value="${option.value}" data-search="${html(`${option.label} ${option.value}`.toLowerCase())}"><span>${html(option.label)}</span><span class="log-menu-check" aria-hidden="true">✓</span></button>`).join("")}
        </div>
        ${renderLogMenuEmpty()}
      </div>
    </div>`;
  }

  function renderLogMenuSearch(placeholder, optionsID) {
    return `<label class="log-menu-search">
      <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m12.6 12.6 4 4"></path></svg>
      <input type="search" role="combobox" aria-autocomplete="list" aria-controls="${optionsID}" aria-expanded="true" autocomplete="off" placeholder="${html(placeholder)}" aria-label="${html(placeholder)}" data-log-menu-search>
      <button type="button" class="log-menu-search-clear" data-action="clear-log-menu-search" aria-label="Clear search" hidden>×</button>
    </label>`;
  }

  function renderLogMenuEmpty() {
    return `<div class="log-menu-empty" data-log-menu-empty hidden>
      <span class="log-menu-empty-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5"></circle><path d="m12.6 12.6 4 4"></path></svg></span>
      <strong>No results</strong>
      <span>Try another search.</span>
    </div>`;
  }

  function logFormatOptions() {
    return [
      { value: "auto", label: "Auto" },
      { value: "raw", label: "Raw" },
      { value: "json", label: "JSON" },
      { value: "logfmt", label: "Key/value" },
      { value: "stack", label: "Stack trace" },
      { value: "custom", label: "Custom rule" },
    ];
  }

  function logFormatLabel(value) {
    return logFormatOptions().find(option => option.value === value)?.label || "Auto";
  }

  function logTargetOptions(values, selected, allLabel, target) {
    const items = [["", allLabel], ...[...values].sort((a, b) => a.localeCompare(b)).map(value => [value, value])];
    return items.map(([value, label]) => `<button type="button" class="log-menu-option ${value === selected ? "selected" : ""}" role="option" aria-selected="${value === selected}" data-action="select-log-target" data-target="${target}" data-value="${html(value)}" data-search="${html(String(label).toLowerCase())}"><span>${html(label)}</span><span class="log-menu-check" aria-hidden="true">✓</span></button>`).join("");
  }

  function filterLogMenuOptions(field, query) {
    if (!field) return [];
    const needle = String(query || "").trim().toLowerCase();
    const visible = [];
    field.querySelectorAll(".log-menu-option").forEach(option => {
      const matches = !needle || String(option.dataset.search || option.textContent || "").toLowerCase().includes(needle);
      option.hidden = !matches;
      if (matches) visible.push(option);
    });
    const empty = field.querySelector("[data-log-menu-empty]");
    if (empty) empty.hidden = visible.length > 0;
    const summary = field.querySelector("[data-log-menu-summary]");
    if (summary) {
      const total = field.querySelectorAll(".log-menu-option").length;
      summary.textContent = needle
        ? `${visible.length} result${visible.length === 1 ? "" : "s"}`
        : `${total} option${total === 1 ? "" : "s"}`;
    }
    const clear = field.querySelector(".log-menu-search-clear");
    if (clear) clear.hidden = !needle;
    return visible;
  }

  function focusLogMenuSearch(field, initialValue = "") {
    const search = field?.querySelector("[data-log-menu-search]");
    if (!search) {
      const options = [...(field?.querySelectorAll(".log-menu-option") || [])].filter(option => !option.hidden);
      const needle = String(initialValue || "").toLowerCase();
      const match = needle
        ? options.find(option => String(option.dataset.search || option.textContent || "").trim().toLowerCase().startsWith(needle))
        : options.find(option => option.classList.contains("selected"));
      requestAnimationFrame(() => (match || options[0])?.focus());
      return;
    }
    search.value = initialValue;
    filterLogMenuOptions(field, initialValue);
    requestAnimationFrame(() => {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    });
  }

  function closeLogMenus(restoreFocus = false) {
    document.querySelectorAll(".log-menu-field").forEach(field => {
      const menu = field.querySelector(".log-menu");
      const trigger = field.querySelector(".log-menu-trigger");
      if (!menu || menu.hidden) return;
      menu.hidden = true;
      field.classList.remove("opens-up");
      field.classList.remove("aligns-right");
      trigger?.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger?.focus();
    });
  }

  function toggleLogMenu(field, forceOpen, focusSearch = false) {
    if (!field) return;
    const menu = field.querySelector(".log-menu");
    const trigger = field.querySelector(".log-menu-trigger");
    if (!menu || !trigger) return;
    const open = forceOpen ?? menu.hidden;
    closeLogMenus();
    if (!open) return;
    const bounds = field.getBoundingClientRect();
    const roomBelow = window.innerHeight - bounds.bottom;
    const requiredRoom = field.dataset.multiple === "true" ? Math.min(440, window.innerHeight * 0.7) : 240;
    field.classList.toggle("opens-up", roomBelow < requiredRoom && bounds.top > roomBelow);
    resetWorkloadFilterDraft(field);
    menu.hidden = false;
    const menuBounds = menu.getBoundingClientRect();
    field.classList.toggle("aligns-right", menuBounds.right > window.innerWidth - 12 && bounds.right - menuBounds.width >= 12);
    trigger.setAttribute("aria-expanded", "true");
    if (focusSearch) focusLogMenuSearch(field);
  }

  function updateLogFormatMenu(value) {
    const field = document.querySelector("[data-log-format-menu]");
    if (!field) return;
    const input = field.querySelector("#log-formatter");
    const label = field.querySelector("[data-log-menu-label]");
    const trigger = field.querySelector(".log-menu-trigger");
    if (input) input.value = value;
    if (label) label.textContent = logFormatLabel(value);
    if (trigger) trigger.setAttribute("aria-label", `Format: ${logFormatLabel(value)}`);
    field.querySelectorAll(".log-menu-option").forEach(option => {
      const selected = option.dataset.value === value;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    });
  }

  function selectLogFormat(value) {
    const formatter = document.getElementById("log-formatter");
    if (!formatter || !logFormatOptions().some(option => option.value === value)) return;
    formatter.value = value;
    updateLogFormatMenu(value);
    closeLogMenus(true);
    formatter.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function logScopeSummary(profile) {
    const focus = [profile.selectedPod || "All pods", profile.selectedContainer || "all containers"].join(" · ");
    const discovered = [];
    if (profile.pods.size) discovered.push(`${profile.pods.size} pod${profile.pods.size === 1 ? "" : "s"}`);
    if (profile.containers.size) discovered.push(`${profile.containers.size} container${profile.containers.size === 1 ? "" : "s"}`);
    return `${focus}${discovered.length ? ` · ${discovered.join(" / ")} seen` : ""}`;
  }

  function updateLogTargetOptions(record, suppliedProfile) {
    const stream = state.stream;
    const profile = suppliedProfile || stream?.targetProfile;
    if (!profile) return;
    if (record?.pod) profile.pods.add(record.pod);
    if (record?.container) profile.containers.add(record.container);
    const pod = document.getElementById("stream-pod");
    const container = document.getElementById("stream-container");
    const update = (input, values, selected, allLabel, target) => {
      if (!input) return;
      const signature = [...values].sort().join("\n");
      const field = input.closest(".log-menu-field");
      if (!field) return;
      const unchanged = input.dataset.targets === signature && input.value === selected;
      input.dataset.targets = signature;
      input.value = selected;
      field.querySelector("[data-log-menu-label]").textContent = selected || allLabel;
      if (unchanged) return;
      const trigger = field.querySelector(".log-menu-trigger");
      if (trigger) trigger.setAttribute("aria-label", `${target === "pod" ? "Pod" : "Container"}: ${selected || allLabel}`);
      const options = field.querySelector("[data-log-menu-options]");
      if (options) options.innerHTML = logTargetOptions(values, selected, allLabel, target);
      const search = field.querySelector("[data-log-menu-search]");
      if (search?.value) filterLogMenuOptions(field, search.value);
    };
    update(pod, profile.pods, profile.selectedPod, "All pods", "pod");
    update(container, profile.containers, profile.selectedContainer, "All containers", "container");
    const summary = document.getElementById("log-scope-summary");
    if (summary) summary.textContent = logScopeSummary(profile);
    const reset = document.querySelector('[data-action="reset-log-scope"]');
    if (reset) reset.hidden = !profile.selectedPod && !profile.selectedContainer;
  }

  function recordMatchesScope(record, pod, container) {
    if (pod && record.pod && record.pod !== pod) return false;
    if (container && record.container && record.container !== container) return false;
    return true;
  }

  function applyLogScope(request, selectedPod, selectedContainer) {
    const stream = state.stream;
    const profile = logTargetProfile(request);
    const pod = selectedPod ?? document.getElementById("stream-pod")?.value ?? "";
    const container = selectedContainer ?? document.getElementById("stream-container")?.value ?? "";
    if (pod) profile.pods.add(pod);
    if (container) profile.containers.add(container);
    if (request.pod === pod && request.container === container) return;
    const retained = (stream?.records || []).filter(record => recordMatchesScope(record, pod, container));
    profile.selectedPod = pod;
    profile.selectedContainer = container;
    request.pod = pod;
    request.container = container;
    const route = routeInfo();
    route.params.set("pod", pod);
    route.params.set("container", container);
    if (!pod) route.params.delete("pod");
    if (!container) route.params.delete("container");
    history.replaceState(null, "", `#/activity?${route.params.toString()}`);
    startActivityStream(request, retained);
    updateLogTargetOptions(null, profile);
    setStreamStatus(`Opening ${pod || "all pods"} · ${container || "all containers"}…`, "info");
  }

  function startActivityStream(request, retainedRecords = [], options = {}) {
    stopActivityStream();
    const events = document.getElementById("stream-events")?.checked === true;
    const previous = document.getElementById("stream-previous")?.checked !== false;
    const configuredTail = Math.max(0, Number(document.getElementById("stream-tail")?.value || state.settings?.default_tail_lines || 200));
    const tail = options.liveOnly ? -1 : configuredTail;
    const targets = request.targets?.length > 1 ? request.targets : [{ connection_id: request.connection_id, kind: request.kind, namespace: request.namespace, name: request.name, pod: request.pod, container: request.container }];
    const targetProfile = logTargetProfile(request);
    const retained = retainedRecords.slice(-3000);
    state.stream = {
      source: null,
      eventSources: new Map(),
      reconnectTimers: new Map(),
      records: retained,
      seen: new Set(retained.flatMap(activityRecordKeys)),
      sources: new Set(),
      request,
      targets,
      targetProfile,
      connected: false,
      arrivalSequence: retained.length,
      lastSequence: new Map(),
      renderFrame: 0,
      renderedCount: 0,
      matchedCount: 0,
      lastNeedle: "",
      fullRender: true,
      filterSignature: "",
      matchIndexes: [],
      visibleIndexes: [],
      activeMatch: -1,
      selectedKey: "",
      jumpHistory: [],
      jumpIndex: -1,
      positionFrame: 0,
      positionFromUser: false,
      renderedVisibleMax: -1,
      expandedEntries: new Set(),
      profile: logFormatterProfile(request),
    };
    for (const record of retained) {
      const origin = displayLogOrigin(record);
      if (origin) state.stream.sources.add(origin);
    }
    updateLogSourceOptions();
    updateLogTargetOptions(null, targetProfile);
    if (retained.length) scheduleActivityRender(true);
    if (Number.isFinite(options.scrollTop)) requestAnimationFrame(() => {
      const container = document.getElementById("stream");
      const follow = document.getElementById("stream-follow");
      if (container && follow && !options.follow) {
        follow.checked = false;
        container.scrollTop = options.scrollTop;
      }
    });
    setStreamStatus(targets.length > 1 ? `Opening ${targets.length} live streams…` : "Opening live stream…", "info");
    targets.forEach((target, index) => openActivitySource(state.stream, target, index, { events, previous, tail }));
  }

  function activityTargetKey(target, index) {
    return `${index}:${target.connection_id}|${target.namespace || ""}|${target.kind}|${target.name}`;
  }

  function openActivitySource(stream, target, index, options, attempt = 0) {
    if (state.stream !== stream) return;
    const key = activityTargetKey(target, index);
    const query = new URLSearchParams({ ...target, events: String(options.events), previous: String(attempt ? false : options.previous), tail_lines: String(attempt ? -1 : options.tail) });
    const source = new EventSource(`/api/v1/activity/stream?${query.toString()}`);
    const status = { source, target, attempt, state: "connecting", ended: false };
    stream.eventSources.set(key, status);
    if (!stream.source) stream.source = source;
    personal.addDiagnostic(state.personal, { type: attempt ? "stream_reconnect" : "stream_open", route: location.hash, connectionID: target.connection_id, source: target.name, attempt });
    source.addEventListener("open", () => {
      if (state.stream !== stream || stream.eventSources.get(key)?.source !== source) return;
      status.state = "connected";
      status.attempt = 0;
      stream.connected = [...stream.eventSources.values()].some(item => item.state === "connected");
      const connected = [...stream.eventSources.values()].filter(item => item.state === "connected").length;
      setStreamStatus(stream.targets.length > 1 ? `Live · ${connected}/${stream.targets.length} sources` : stream.records.length ? "Live" : "Live · waiting for logs", connected === stream.targets.length ? "info" : "warning");
    });
    source.addEventListener("activity", event => {
      if (state.stream !== stream || stream.eventSources.get(key)?.source !== source) return;
      let record;
      try { record = JSON.parse(event.data); } catch { return; }
      record.workload = target.name;
      record.connection_id = target.connection_id;
      record.namespace = record.namespace || target.namespace || "";
      record._sourceKey = key;
      record._arrival = ++stream.arrivalSequence;
      const sequence = Number(record.sequence);
      const previousSequence = stream.lastSequence.get(key);
      if (Number.isFinite(sequence)) {
        if (Number.isFinite(previousSequence) && sequence > previousSequence + 1) {
          const missing = sequence - previousSequence - 1;
          const notice = { timestamp: record.timestamp, type: "system", level: "warning", source: "runwake-stream", workload: target.name, connection_id: target.connection_id, message: `${missing} record${missing === 1 ? "" : "s"} missing from ${target.name} between sequence ${previousSequence} and ${sequence}`, _sourceKey: key, _arrival: ++stream.arrivalSequence };
          notice._runwakeKey = activityRecordDedupeKey(notice);
          notice._coalescedKeys = [notice._runwakeKey];
          notice._lineCount = 1;
          stream.records.push(notice);
          stream.seen.add(notice._runwakeKey);
          personal.addDiagnostic(state.personal, { type: "stream_gap", route: location.hash, connectionID: target.connection_id, source: target.name, message: notice.message });
        }
        if (!Number.isFinite(previousSequence) || sequence > previousSequence) stream.lastSequence.set(key, sequence);
      }
      const dedupeKey = activityRecordDedupeKey(record);
      if (stream.seen.has(dedupeKey)) return;
      record._runwakeKey = dedupeKey;
      record._coalescedKeys = [dedupeKey];
      record._lineCount = Math.max(1, String(record.message || "").split("\n").length);
      stream.seen.add(dedupeKey);
      const coalesced = stream.targets.length === 1 && coalesceActivityRecord(stream, record);
      if (!coalesced) stream.records.push(record);
      if (stream.targets.length > 1) stream.records.sort(compareMergedRecords);
      trimActivityBuffer(stream);
      setStreamStatus(stream.targets.length > 1 ? `Live · ${[...stream.eventSources.values()].filter(item => item.state === "connected").length}/${stream.targets.length} sources · latest ${formatTime(record.timestamp)}` : `Live · latest ${formatTime(record.timestamp)}`, "info");
      updateLogSourceOptions(record);
      updateLogTargetOptions(record);
      scheduleActivityRender(stream.targets.length > 1 || coalesced);
    });
    source.addEventListener("activity-end", () => {
      if (state.stream !== stream || stream.eventSources.get(key)?.source !== source) return;
      status.ended = true;
      status.state = "ended";
      source.close();
      const active = [...stream.eventSources.values()].filter(item => item.state === "connected").length;
      setStreamStatus(active ? `Live · ${active}/${stream.targets.length} sources` : "Stream ended · showing buffered records", active ? "warning" : "info");
    });
    source.addEventListener("error", async () => {
      if (state.stream !== stream || stream.eventSources.get(key)?.source !== source || status.ended) return;
      source.close();
      try {
        const authResponse = await fetch("/api/v1/meta", { credentials: "same-origin", cache: "no-store" });
        if (authResponse.status === 401) {
          status.state = "authentication-required";
          state.authenticated = false;
          renderLogin();
          return;
        }
      } catch { /* A network failure still uses bounded retry below. */ }
      if (state.stream !== stream || status.ended) return;
      status.state = "reconnecting";
      status.attempt += 1;
      stream.connected = [...stream.eventSources.values()].some(item => item.state === "connected");
      const delay = personal.reconnectDelay(status.attempt);
      personal.addDiagnostic(state.personal, { type: "stream_error", route: location.hash, connectionID: target.connection_id, source: target.name, attempt: status.attempt, delayMs: delay, message: "Activity stream interrupted" });
      setStreamStatus(stream.targets.length > 1 ? `${target.name} interrupted · retrying in ${Math.ceil(delay / 1000)}s` : `Stream interrupted · retrying in ${Math.ceil(delay / 1000)}s`, "warning");
      const timer = setTimeout(() => openActivitySource(stream, target, index, options, status.attempt), delay);
      stream.reconnectTimers.set(key, timer);
    });
  }

  function compareMergedRecords(a, b) {
    const time = new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
    return time || Number(a._arrival || 0) - Number(b._arrival || 0);
  }

  function trimActivityBuffer(stream) {
    if (stream.records.length <= 3000) return;
    const removed = stream.records.splice(0, 500);
    const removedKeys = new Set();
    removed.forEach(item => {
      for (const key of activityRecordKeys(item)) {
        removedKeys.add(key);
        stream.seen.delete(key);
      }
      stream.profile.overrides.delete(activityRecordKey(item, 0));
      stream.expandedEntries.delete(activityRecordKey(item, 0));
    });
    stream.jumpHistory.forEach(anchor => { anchor.indexHint = Math.max(0, anchor.indexHint - removed.length); });
    if (removedKeys.has(stream.selectedKey)) stream.selectedKey = "";
    stream.fullRender = true;
  }

  function stopActivityStream() {
    if (state.stream?.renderFrame) cancelAnimationFrame(state.stream.renderFrame);
    if (state.stream?.positionFrame) cancelAnimationFrame(state.stream.positionFrame);
    state.stream?.eventSources?.forEach(item => item.source?.close());
    state.stream?.reconnectTimers?.forEach(timer => clearTimeout(timer));
    if (state.stream?.source && !state.stream?.eventSources) state.stream.source.close();
    state.stream = null;
  }

  function startMetricStream(request) {
    stopMetricStream();
    const interval = Math.max(1, Number(state.settings?.selected_metrics_interval_seconds || 2));
    const query = new URLSearchParams({ ...request, interval_seconds: String(interval) });
    const source = new EventSource(`/api/v1/metrics/stream?${query.toString()}`);
    state.metricStream = { source, samples: [], request, connected: false };
    setMetricStatus("Opening metrics stream…", "info");
    source.addEventListener("open", () => {
      if (!state.metricStream || state.metricStream.source !== source) return;
      state.metricStream.connected = true;
      setMetricStatus("Metrics stream connected", "info", true);
    });
    source.addEventListener("metric", event => {
      if (!state.metricStream || state.metricStream.source !== source) return;
      let sample;
      try { sample = JSON.parse(event.data); } catch { return; }
      if (sample.error) {
        source.close();
        state.metricStream.connected = false;
        setMetricStatus(sample.error, "warning");
        return;
      }
      state.metricStream.samples.push(sample);
      const cutoff = Date.now() - 10 * 60 * 1000;
      state.metricStream.samples = state.metricStream.samples.filter(item => new Date(item.timestamp).getTime() >= cutoff).slice(-600);
      renderMetricSamples();
    });
    source.addEventListener("error", () => {
      if (!state.metricStream || state.metricStream.source !== source) return;
      state.metricStream.connected = false;
      if (!state.metricStream.samples.length) setMetricStatus("Metrics stream unavailable. Kubernetes requires metrics.k8s.io; Docker requires access to the Engine stats endpoint.", "warning");
    });
  }

  function stopMetricStream() {
    if (state.metricStream?.source) state.metricStream.source.close();
    state.metricStream = null;
  }

  function setMetricStatus(message, kind = "info", hide = false) {
    const node = document.getElementById("metric-status");
    if (!node) return;
    node.className = `notice ${kind} stream-status`;
    node.textContent = message;
    node.classList.toggle("is-hidden", hide);
  }

  function renderMetricSamples() {
    const samples = state.metricStream?.samples || [];
    if (!samples.length) return;
    const latest = samples[samples.length - 1];
    const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
    set("metric-cpu", formatCPU(latest));
    set("metric-memory", formatMemory(latest));
    set("metric-network-rx", latest.network_receive_bytes ? formatBytes(latest.network_receive_bytes) : "—");
    set("metric-pids", latest.pids ? String(latest.pids) : "—");
    const interval = Math.max(1, Number(state.settings?.selected_metrics_interval_seconds || 2));
    const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(latest.timestamp).getTime()) / 1000));
    const stale = ageSeconds > Math.max(8, interval * 3);
    set("metric-source", `${latest.source || "metrics"} · ${stale ? `${ageSeconds}s old` : "fresh"} · ${interval}s cadence · ${samples.length} samples`);
    setMetricStatus(stale ? `Metric samples are stale · last update ${ageSeconds}s ago` : "Metrics stream connected", stale ? "warning" : "info", !stale);
    const cpuPercent = latest.cpu_percent !== undefined && latest.cpu_percent !== null;
    set("metric-cpu-unit", cpuPercent ? "Percent of one or more CPUs" : "Millicores");
    const memoryPercent = latest.memory_limit_bytes ? Math.min(999, Number(latest.memory_bytes || 0) / Number(latest.memory_limit_bytes) * 100) : null;
    set("metric-memory-unit", memoryPercent === null ? "Working set" : `${memoryPercent.toFixed(memoryPercent >= 10 ? 0 : 1)}% of ${formatBytes(latest.memory_limit_bytes)} limit`);
    const cpuValues = samples.map(item => cpuPercent ? Number(item.cpu_percent || 0) : Number(item.cpu_cores || 0) * 1000);
    const memoryValues = samples.map(item => Number(item.memory_bytes || 0) / (1024 * 1024));
    const cpuChart = document.getElementById("metric-cpu-chart");
    const memoryChart = document.getElementById("metric-memory-chart");
    if (cpuChart) cpuChart.innerHTML = metricChart(cpuValues, cpuPercent ? "%" : "m", samples);
    if (memoryChart) memoryChart.innerHTML = metricChart(memoryValues, "MiB", samples);
    bindSynchronizedMetricMarkers();
    renderContainerMetrics(latest);
  }

  function metricChart(values, unit, samples = []) {
    const clean = values.filter(Number.isFinite);
    if (!clean.length) return `<div class="stream-state">No samples.</div>`;
    const width = 620, height = 150, padX = 12, padY = 16;
    const max = Math.max(...clean, 0.0001);
    const min = Math.min(...clean, 0);
    const range = Math.max(max - min, max * 0.1, 0.0001);
    const points = clean.map((value, index) => {
      const x = clean.length === 1 ? width / 2 : padX + index / (clean.length - 1) * (width - padX * 2);
      const y = height - padY - (value - min) / range * (height - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const latest = clean[clean.length - 1];
    const number = value => value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
    const markers = clean.map((value, index) => {
      const x = clean.length === 1 ? width / 2 : padX + index / (clean.length - 1) * (width - padX * 2);
      const y = height - padY - (value - min) / range * (height - padY * 2);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" tabindex="0" data-sample-index="${index}"><title>${number(value)} ${unit} · ${formatTime(samples[index]?.timestamp || "", true)}</title></circle>`;
    }).join("");
    const cadence = Math.max(1, Number(state.settings?.selected_metrics_interval_seconds || 2)) * 1000;
    const gaps = samples.slice(1).filter((sample, index) => new Date(sample.timestamp).getTime() - new Date(samples[index].timestamp).getTime() > cadence * 2.5).length;
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Last ten minutes, current ${number(latest)} ${unit}, minimum ${number(min)} ${unit}, maximum ${number(max)} ${unit}"><line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" class="chart-axis"></line><polyline points="${points}" class="chart-line"></polyline><g class="chart-markers">${markers}</g></svg><div class="chart-caption"><span>${clean.length} samples · ${gaps ? `${gaps} sampling gap${gaps === 1 ? "" : "s"}` : "continuous"}</span><span>${number(min)} min · ${number(latest)} current · ${number(max)} max ${unit}</span></div>`;
  }

  function bindSynchronizedMetricMarkers() {
    const charts = document.querySelectorAll(".metric-chart");
    const highlight = index => document.querySelectorAll("[data-sample-index]").forEach(marker => marker.classList.toggle("linked", marker.dataset.sampleIndex === index));
    charts.forEach(chart => {
      chart.addEventListener("mouseover", event => { if (event.target.dataset?.sampleIndex) highlight(event.target.dataset.sampleIndex); });
      chart.addEventListener("focusin", event => { if (event.target.dataset?.sampleIndex) highlight(event.target.dataset.sampleIndex); });
      chart.addEventListener("mouseout", event => { if (event.target.dataset?.sampleIndex) highlight(""); });
      chart.addEventListener("focusout", event => { if (event.target.dataset?.sampleIndex) highlight(""); });
    });
  }

  function renderContainerMetrics(metric) {
    const target = document.getElementById("metric-container-table");
    if (!target) return;
    const items = metric.containers || [];
    if (!items.length) {
      target.innerHTML = `<div class="stream-state">No container-level samples.</div>`;
      return;
    }
    target.innerHTML = `<table class="data-table metric-table"><thead><tr><th>Container</th><th>CPU</th><th>Memory</th><th>Network</th></tr></thead><tbody>${items.map(item => `<tr><td><div class="cell-title">${html(item.container)}</div><div class="cell-subtitle">${html(item.pod || metric.name)}</div></td><td>${html(formatCPU(item))}</td><td>${html(formatMemory(item))}</td><td>${item.network_receive_bytes || item.network_transmit_bytes ? `${html(formatBytes(item.network_receive_bytes))} in · ${html(formatBytes(item.network_transmit_bytes))} out` : "—"}</td></tr>`).join("")}</tbody></table>`;
  }

  function setStreamStatus(message, kind = "info", hide = false) {
    const node = document.getElementById("stream-status");
    if (!node) return;
    node.className = `log-status ${kind}`;
    node.textContent = message;
    node.classList.toggle("is-hidden", hide);
  }

  function scheduleActivityRender(fullRender = false) {
    const stream = state.stream;
    if (!stream) return;
    if (fullRender) stream.fullRender = true;
    if (stream.renderFrame) return;
    stream.renderFrame = requestAnimationFrame(() => {
      if (state.stream !== stream) return;
      stream.renderFrame = 0;
      renderActivityRecords();
    });
  }

  function renderActivityRecords() {
    const container = document.getElementById("stream");
    if (!container || !state.stream) return;
    const stream = state.stream;
    const filter = currentLogFilter();
    const signature = JSON.stringify([filter.needle, filter.mode, filter.level, filter.source, filter.httpPath, filter.httpMethod, filter.httpStatus, filter.before, filter.after, stream.profile.mode, stream.profile.pattern, stream.profile.template]);
    const active = logFilterActive(filter);
    const filterChanged = stream.filterSignature !== signature;
    const rebuild = stream.fullRender || filterChanged || stream.renderedCount > stream.records.length;
    const previousMatchCount = stream.matchIndexes.length;
    let matchIndexes = [];
    if (active && !filter.error) {
      if (rebuild) {
        stream.records.forEach((record, index) => {
          if (recordMatchesLogFilter(record, filter)) matchIndexes.push(index);
        });
      } else {
        matchIndexes = stream.matchIndexes.slice();
        for (let index = stream.renderedCount; index < stream.records.length; index += 1) {
          if (recordMatchesLogFilter(stream.records[index], filter)) matchIndexes.push(index);
        }
      }
    }
    const visibleIndexes = active
      ? expandLogContext(matchIndexes, stream.records.length, filter.before, filter.after)
      : stream.records.map((_, index) => index);
    const previousTop = container.scrollTop;

    if (rebuild) {
      if (!visibleIndexes.length) {
        container.innerHTML = `<div class="stream-state">${stream.records.length ? filter.error || "No records match the active filters." : "Waiting for records…"}</div>`;
      } else {
        const fragment = document.createDocumentFragment();
        const matched = new Set(matchIndexes);
        for (const index of visibleIndexes) fragment.append(activityRow(stream.records[index], index, matched.has(index)));
        container.replaceChildren(fragment);
      }
      stream.matchedCount = matchIndexes.length;
      stream.renderedVisibleMax = visibleIndexes.at(-1) ?? -1;
      if (!document.getElementById("stream-follow")?.checked) container.scrollTop = previousTop;
    } else if (stream.records.length > stream.renderedCount) {
      const fragment = document.createDocumentFragment();
      if (active) {
        const matched = new Set(matchIndexes);
        for (const index of visibleIndexes) {
          if (index > stream.renderedVisibleMax) fragment.append(activityRow(stream.records[index], index, matched.has(index)));
        }
      } else {
        for (let index = stream.renderedCount; index < stream.records.length; index += 1) {
          fragment.append(activityRow(stream.records[index], index, false));
        }
      }
      if (fragment.childNodes.length) {
        container.querySelector(".stream-state")?.remove();
        container.append(fragment);
      }
      stream.renderedVisibleMax = visibleIndexes.at(-1) ?? stream.renderedVisibleMax;
    } else if (!stream.matchedCount) {
      container.innerHTML = `<div class="stream-state">${stream.records.length ? "No records match this filter." : "Waiting for records…"}</div>`;
    }

    stream.matchIndexes = matchIndexes;
    stream.visibleIndexes = visibleIndexes;
    if (stream.activeMatch >= matchIndexes.length) stream.activeMatch = matchIndexes.length ? matchIndexes.length - 1 : -1;
    stream.renderedCount = stream.records.length;
    stream.lastNeedle = filter.needle;
    stream.filterSignature = signature;
    stream.matchedCount = matchIndexes.length;
    stream.fullRender = false;
    renderLogFilterState(filter);
    updateLogResultsSummary(filter);
    if (rebuild || previousMatchCount !== matchIndexes.length) {
      renderLogResults(rebuild);
      renderLogMatchMarkers();
    }
    if (rebuild) refreshSelectedLogInspector();
    updateLogNavigationButtons();
    if (document.getElementById("stream-follow")?.checked) scrollLogToLatest();
    scheduleLogPositionUpdate();
  }

  function refreshSelectedLogInspector() {
    const target = document.getElementById("log-record-detail");
    const stream = state.stream;
    if (!target || !stream || document.getElementById("log-inspector")?.hidden) return;
    const selected = selectedLogRecord();
    if (!selected) {
      stream.selectedKey = "";
      target.innerHTML = `<div class="log-inspector-empty">Select a log line.</div>`;
      return;
    }
    renderLogRecordInspector(selected.index);
    renderLogFormatterPreview();
  }

  function currentLogFilter() {
    const needle = String(document.getElementById("stream-search")?.value || "").trim();
    const mode = document.getElementById("log-find-mode")?.value || "text";
    const filter = {
      needle,
      mode,
      level: document.getElementById("log-level-filter")?.value || "",
      source: document.getElementById("log-source-filter")?.value || "",
      httpPath: String(document.getElementById("log-http-path-filter")?.value || "").trim(),
      httpMethod: document.getElementById("log-http-method-filter")?.value || "",
      httpStatus: document.getElementById("log-http-status-filter")?.value || "",
      before: Math.max(0, Math.min(100, Number(document.getElementById("log-context-before")?.value || 0))),
      after: Math.max(0, Math.min(100, Number(document.getElementById("log-context-after")?.value || 0))),
      regex: null,
      error: "",
    };
    if (needle && mode === "regex") {
      try {
        const safetyError = regexSafetyError(needle);
        if (safetyError) throw new Error(safetyError);
        filter.regex = new RegExp(needle, "i");
      } catch (error) {
        filter.error = error.message;
      }
    }
    return filter;
  }

  function logFilterActive(filter) {
    return Boolean(filter.needle || filter.level || filter.source || filter.httpPath || filter.httpMethod || filter.httpStatus);
  }

  function regexSafetyError(pattern) {
    if (pattern.length > 240) return "Regular expressions are limited to 240 characters.";
    if (/\\[1-9]/.test(pattern)) return "Backreferences are not supported.";
    if (/\(\?<([=!])/.test(pattern)) return "Lookbehind is not supported.";
    if (/(\.\*){2,}|(\.\+){2,}/.test(pattern)) return "Repeated wildcard groups are not supported.";
    if (/\([^)]*\|[^)]*\)\s*(?:[*+{])/.test(pattern)) return "Repeated alternation groups are not supported.";
    if (/\((?:\?:|\?<\w+>)?[^)]*(?:[*+?}]|\{\d+(?:,\d*)?\})[^)]*\)\s*(?:[*+?{])/.test(pattern)) {
      return "Nested repetition is not supported.";
    }
    return "";
  }

  function recordMatchesLogFilter(record, filter) {
    const structured = structuredLogForRecord(record);
    const enrichedFields = { ...(record.fields || {}), ...(structured?.fields || {}) };
    const classification = activityClass({ ...record, level: structured?.level || record.level, fields: enrichedFields });
    if (filter.level === "error" && classification !== "error") return false;
    if (filter.level === "warning" && classification !== "warning") return false;
    if (filter.level === "system" && !["system", "event"].includes(classification)) return false;
    if (filter.level === "info" && (classification !== "log" || !/\binfo\b/i.test(`${structured?.level || ""} ${record.level || ""} ${record.type || ""}`))) return false;
    if (filter.level === "debug" && !/\b(debug|trace)\b/i.test(`${structured?.level || ""} ${record.level || ""} ${record.type || ""}`)) return false;
    const origin = displayLogOrigin(record);
    if (filter.source && origin !== filter.source) return false;
    const httpPath = String(enrichedFields.http_path || "");
    const httpMethod = String(enrichedFields.http_method || "").toUpperCase();
    const httpStatus = String(enrichedFields.http_status_class || (enrichedFields.http_status ? `${String(enrichedFields.http_status)[0]}xx` : ""));
    if (filter.httpPath && !httpPath.toLowerCase().includes(filter.httpPath.toLowerCase())) return false;
    if (filter.httpMethod && httpMethod !== filter.httpMethod) return false;
    if (filter.httpStatus && httpStatus !== filter.httpStatus) return false;
    if (!filter.needle) return true;
    const haystack = [terminalLogText(record.message), record.type, record.level, origin, JSON.stringify(enrichedFields)].join(" ").slice(0, 65536);
    return filter.regex ? filter.regex.test(haystack) : haystack.toLowerCase().includes(filter.needle.toLowerCase());
  }

  function expandLogContext(matches, total, before, after) {
    const indexes = new Set();
    for (const index of matches) {
      const start = Math.max(0, index - before);
      const end = Math.min(total - 1, index + after);
      for (let cursor = start; cursor <= end; cursor += 1) indexes.add(cursor);
    }
    return [...indexes].sort((a, b) => a - b);
  }

  function renderLogFilterState(filter) {
    const error = document.getElementById("log-filter-error");
    if (error) {
      error.hidden = !filter.error;
      error.textContent = filter.error;
    }
    const stream = state.stream;
    const active = logFilterActive(filter);
    const count = document.getElementById("log-match-count");
    if (count) count.textContent = filter.error ? "Invalid query" : active ? `${stream.matchIndexes.length.toLocaleString()} match${stream.matchIndexes.length === 1 ? "" : "es"}` : "No query";
    const activeFilterCount = [filter.needle, filter.level, filter.source, filter.httpPath, filter.httpMethod, filter.httpStatus, active && filter.before > 0, active && filter.after > 0].filter(Boolean).length;
    const badge = document.getElementById("log-filter-count");
    const button = document.querySelector('[data-action="toggle-log-filters"]');
    if (badge) {
      badge.hidden = activeFilterCount === 0;
      badge.textContent = String(activeFilterCount);
    }
    button?.classList.toggle("has-active-filters", activeFilterCount > 0);
    button?.setAttribute("aria-label", activeFilterCount ? `Filters, ${activeFilterCount} active` : "Filters");
    const reset = document.querySelector('[data-action="clear-log-filters"]');
    if (reset) reset.disabled = activeFilterCount === 0;
    document.getElementById("log-inspector")?.classList.toggle("matches-idle", !active);
    const buffer = document.getElementById("log-buffer-count");
    if (buffer) {
      const shown = stream.visibleIndexes.length;
      const buffered = logBufferSummary(stream.records);
      buffer.textContent = `${buffered} buffered${shown !== stream.records.length ? ` · ${logBufferSummary(stream.records, stream.visibleIndexes)} shown` : ""}`;
    }
  }

  function activityRecordKey(record, index) {
    return record._runwakeKey || (record.sequence ? `s:${record.sequence}` : `${index}:${record.timestamp || ""}:${record.message || ""}`);
  }

  function activityRecordDedupeKey(record) {
    // Sequence numbers identify one upstream stream only. A reconnect may
    // restart that stream and assign new sequences to the same tailed logs.
    const content = [record.connection_id, record.workload, record.timestamp, record.type, record.level, record.source, record.pod, record.container, record.message];
    return content.some(value => value !== undefined && value !== null && value !== "")
      ? `c:${JSON.stringify(content)}`
      : `s:${record.sequence || ""}`;
  }

  function activityRecordKeys(record) {
    return record._coalescedKeys?.length ? record._coalescedKeys : [activityRecordDedupeKey(record)];
  }

  function displayLogOrigin(record) {
    const requestName = String(state.stream?.request?.name || "");
    const parts = state.stream?.targets?.length > 1 ? [record.workload, record.source] : [record.source];
    if (record.pod && record.pod !== requestName) parts.push(record.pod);
    if (record.container && record.container !== requestName && record.container !== record.pod) parts.push(record.container);
    return parts.filter(Boolean).join(" · ");
  }

  function coalesceActivityRecord(stream, record) {
    const previous = stream.records.at(-1);
    if (!previous || record.source !== "kubernetes-log" || previous.source !== record.source) return false;
    if (record.type !== "log" || previous.type !== "log") return false;
    if (record.timestamp !== previous.timestamp || record.pod !== previous.pod || record.container !== previous.container) return false;
    if (parseStructuredLog(record.message)) return false;
    if (Number(previous._lineCount || 1) >= 400 || String(previous.message || "").length + String(record.message || "").length > 512 * 1024) return false;
    previous.message = `${previous.message || ""}\n${record.message || ""}`;
    previous._lineCount = Number(previous._lineCount || 1) + Number(record._lineCount || 1);
    previous._coalescedKeys = [...activityRecordKeys(previous), ...activityRecordKeys(record)];
    return true;
  }

  function logBufferSummary(records, indexes) {
    const selected = indexes ? indexes.map(index => records[index]).filter(Boolean) : records;
    const entries = selected.length;
    const lines = selected.reduce((total, record) => total + Number(record._lineCount || Math.max(1, String(record.message || "").split("\n").length)), 0);
    const entryLabel = `${entries.toLocaleString()} ${entries === 1 ? "entry" : "entries"}`;
    return lines === entries ? entryLabel : `${entryLabel} · ${lines.toLocaleString()} lines`;
  }

  function activityRow(record, index, isMatch) {
    const row = document.createElement("div");
    const display = formatLogRecord(record, index);
    const structured = display.structured;
    const effectiveLevel = structured?.level || record.level;
    const level = activityClass({ ...record, level: effectiveLevel, fields: { ...(record.fields || {}), ...(structured?.fields || {}) } });
    const key = activityRecordKey(record, index);
    const selected = key === state.stream?.selectedKey;
    const longEntry = Number(record._lineCount || 1) > 8 || String(record.message || "").length > 700;
    const expanded = state.stream?.expandedEntries.has(key);
    row.className = `stream-row ${level}${isMatch ? " match" : ""}${selected ? " selected" : ""}${longEntry ? " long-entry" : ""}${longEntry && !expanded ? " collapsed-entry" : ""}`;
    row.dataset.action = "select-log-record";
    row.dataset.index = String(index);
    row.dataset.key = key;
    row.tabIndex = 0;
    row.setAttribute("role", "group");
    const time = document.createElement("div");
    time.className = "stream-time";
    const timestamp = structured?.timestamp || record.timestamp;
    time.textContent = formatTime(timestamp);
    time.title = formatTime(timestamp, true);
    const type = document.createElement("div");
    type.className = "stream-type";
    type.textContent = structured?.level || record.type || "record";
    const message = document.createElement("div");
    message.className = "stream-message";
    if (structured) {
      const summary = document.createElement("span");
      summary.className = "structured-summary";
      summary.textContent = structured.summary;
      message.append(summary);
      if (structured.highlights.length) {
        const highlights = document.createElement("span");
        highlights.className = "log-highlights";
        for (const item of structured.highlights) {
          const chip = document.createElement("span");
          chip.className = "log-highlight";
          chip.textContent = `${item.label} ${item.value}`;
          const status = item.label === "status" ? Number(item.value) : 0;
          if (status >= 500) chip.classList.add("status-error");
          else if (status >= 400) chip.classList.add("status-warning");
          highlights.append(chip);
        }
        message.append(highlights);
      }
    } else {
      const raw = document.createElement("span");
      raw.className = "raw-log-text";
      raw.textContent = display.text;
      message.append(raw);
    }
    row.setAttribute("aria-label", `Log record. Press Enter to inspect. ${formatTime(timestamp)} ${String(structured?.level || record.level || record.type || "record")} ${structured?.summary || display.text || record.message || ""}`.replace(/\s+/g, " ").slice(0, 240));
    const metadata = document.createElement("div");
    metadata.className = "stream-record-meta";
    const origin = displayLogOrigin(record);
    if (origin) {
      const source = document.createElement("span");
      source.className = "stream-source";
      source.textContent = origin;
      metadata.append(source);
    }
    if (longEntry) {
      const toggle = document.createElement("button");
      toggle.className = "log-entry-toggle";
      toggle.dataset.action = "toggle-log-entry";
      toggle.dataset.index = String(index);
      toggle.textContent = expanded ? "Collapse entry" : Number(record._lineCount || 1) > 1 ? `Show full ${record._lineCount}-line entry` : "Show full entry";
      metadata.append(toggle);
    }
    const fields = structured ? structuredFieldDetails(record.fields, structured.fields) : record.fields;
    if (fields && Object.keys(fields).length) {
      const details = document.createElement("details");
      details.className = "stream-fields";
      const summary = document.createElement("summary");
      summary.textContent = "Fields";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(fields, null, 2);
      details.append(summary, pre);
      metadata.append(details);
    }
    if (metadata.childNodes.length) message.append(metadata);
    row.append(time, type, message);
    return row;
  }

  function structuredFieldDetails(recordFields, structuredFields) {
    const fields = { ...(recordFields || {}), ...(structuredFields || {}) };
    for (const key of ["timestamp", "time", "ts", "level", "severity", "message", "msg", "component", "event", "action"]) delete fields[key];
    return fields;
  }

  function formatLogRecord(record, index) {
    const stream = state.stream;
    const profile = stream?.profile || { mode: "auto", overrides: new Map() };
    const key = activityRecordKey(record, index);
    const mode = profile.overrides?.get(key) || profile.mode || "auto";
    const raw = String(record.message || "");
    if (mode === "raw") return { text: raw, structured: null };
    const rendered = terminalLogText(raw);
    if (mode === "stack") return { text: formatStackTrace(rendered), structured: null };
    if (mode === "custom") {
      const custom = applyCustomLogFormatter(rendered, profile);
      return custom ? { text: custom.text, structured: custom.structured } : { text: rendered, structured: null };
    }
    if (mode === "json") {
      try {
        const fields = JSON.parse(rendered);
        if (fields && typeof fields === "object" && !Array.isArray(fields)) return { text: rendered, structured: structuredLog(fields) };
      } catch {
        return { text: rendered, structured: null };
      }
    }
    if (mode === "logfmt") {
      const fields = parseLogfmtFields(rendered);
      return Object.keys(fields).length ? { text: rendered, structured: structuredLog(fields) } : { text: rendered, structured: null };
    }
    return { text: rendered, structured: structuredLogForRecord({ ...record, message: rendered }) };
  }

  function formatStackTrace(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/(?<!^)\s+(?=(?:at\s+[\w.$<]|Caused by:|Suppressed:|goroutine\s+\d+|File\s+"[^"]+",\s+line\s+\d+|Traceback\s+\())/g, "\n")
      .replace(/\s+(\.{3}\s+\d+\s+more)\b/g, "\n$1");
  }

  function parseLogfmtFields(value) {
    const fields = {};
    const pattern = /(?:^|\s)([A-Za-z_][\w.-]*)=(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+))/g;
    let match;
    while ((match = pattern.exec(String(value || ""))) !== null) fields[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    return fields;
  }

  function applyCustomLogFormatter(value, profile) {
    if (!profile.pattern) return null;
    try {
      const safetyError = regexSafetyError(profile.pattern);
      if (safetyError) throw new Error(safetyError);
      if (profile.compiledSource !== profile.pattern) {
        profile.compiled = new RegExp(profile.pattern);
        profile.compiledSource = profile.pattern;
      }
      const match = profile.compiled.exec(String(value).slice(0, 65536));
      if (!match) return null;
      const fields = { ...(match.groups || {}) };
      match.slice(1).forEach((item, index) => { if (fields[index + 1] === undefined) fields[index + 1] = item; });
      const template = profile.template || "$message";
      const text = template.replace(/\$([A-Za-z_][\w]*|\d+)/g, (_, key) => key === "message" ? String(fields.message ?? value) : String(fields[key] ?? ""));
      return { text, structured: { fields, level: fields.level || "", timestamp: fields.timestamp || fields.time || "", summary: text, highlights: [] } };
    } catch (error) {
      profile.formatError = error.message;
      return null;
    }
  }

  function updateLogSourceOptions(record) {
    const select = document.getElementById("log-source-filter");
    const stream = state.stream;
    if (!select || !stream) return;
    if (record) {
      const origin = displayLogOrigin(record);
      if (origin) stream.sources.add(origin);
    }
    const current = select.value;
    const sources = [...stream.sources].sort();
    const signature = sources.join("\n");
    if (select.dataset.sources === signature) return;
    select.dataset.sources = signature;
    select.innerHTML = `<option value="">All sources</option>${sources.map(value => `<option value="${html(value)}">${html(value)}</option>`).join("")}`;
    const pending = stream.pendingSourceFilter;
    if (pending && sources.includes(pending)) {
      select.value = pending;
      stream.pendingSourceFilter = "";
      scheduleActivityRender(true);
    } else if (sources.includes(current)) select.value = current;
  }

  function renderLogResults(force = false) {
    const stream = state.stream;
    const target = document.getElementById("log-results");
    const summary = document.getElementById("log-results-summary");
    if (!stream || !target || !summary || document.getElementById("log-inspector")?.hidden) return;
    const filter = currentLogFilter();
    const active = logFilterActive(filter);
    if (!active) {
      summary.textContent = "Add a query or filter";
      target.innerHTML = `<div class="log-inspector-empty">Search or apply filters to build a jump list.</div>`;
      delete target.dataset.resultSignature;
      delete target.dataset.renderedResults;
      return;
    }
    if (filter.error) {
      summary.textContent = "Query needs attention";
      target.innerHTML = `<div class="log-inspector-empty">${html(filter.error)}</div>`;
      delete target.dataset.resultSignature;
      delete target.dataset.renderedResults;
      return;
    }
    updateLogResultsSummary(filter);
    if (!stream.matchIndexes.length) {
      target.innerHTML = `<div class="log-inspector-empty">No matches in the current buffer.</div>`;
      delete target.dataset.resultSignature;
      delete target.dataset.renderedResults;
      return;
    }
    const limit = 250;
    const indexes = stream.matchIndexes.slice(0, limit);
    const signature = stream.filterSignature;
    const rendered = Number(target.dataset.renderedResults || 0);
    const rebuild = force || target.dataset.resultSignature !== signature || rendered > indexes.length;
    const focusedIndex = target.contains(document.activeElement) ? document.activeElement?.dataset?.index : "";
    if (rebuild) {
      target.innerHTML = indexes.map((index, matchIndex) => logResultMarkup(index, matchIndex)).join("");
    } else if (indexes.length > rendered) {
      target.insertAdjacentHTML("beforeend", indexes.slice(rendered).map((index, offset) => logResultMarkup(index, rendered + offset)).join(""));
    }
    target.querySelectorAll(".log-result.active").forEach(item => item.classList.remove("active"));
    if (stream.activeMatch >= 0) target.querySelector(`.log-result[data-index="${stream.matchIndexes[stream.activeMatch]}"]`)?.classList.add("active");
    let notice = target.querySelector(".log-result-limit");
    if (stream.matchIndexes.length > limit) {
      if (!notice) {
        notice = document.createElement("div");
        notice.className = "log-result-limit";
        target.append(notice);
      }
      notice.textContent = `Showing the first ${limit.toLocaleString()} matches. Refine the query to narrow the list.`;
    } else {
      notice?.remove();
    }
    target.dataset.resultSignature = signature;
    target.dataset.renderedResults = String(indexes.length);
    if (focusedIndex) target.querySelector(`.log-result[data-index="${focusedIndex}"]`)?.focus();
  }

  function logResultMarkup(index, matchIndex) {
    const stream = state.stream;
    const record = stream?.records[index];
    if (!record) return "";
    const structured = structuredLogForRecord(record);
    const label = structured?.summary || String(record.message || "").replace(/\s+/g, " ").trim() || "Empty record";
    const level = structured?.level || record.level || record.type || "record";
    return `<button class="log-result ${matchIndex === stream.activeMatch ? "active" : ""}" data-action="jump-log-match" data-index="${index}"><span><time>${html(formatTime(structured?.timestamp || record.timestamp))}</time><small>${html(String(level).toUpperCase())}</small></span><strong>${html(label)}</strong></button>`;
  }

  function updateLogResultsSummary(filter = currentLogFilter()) {
    const stream = state.stream;
    const summary = document.getElementById("log-results-summary");
    if (!stream || !summary) return;
    const active = logFilterActive(filter);
    if (!active) summary.textContent = "Add a query or filter";
    else if (filter.error) summary.textContent = "Query needs attention";
    else summary.textContent = `${stream.matchIndexes.length.toLocaleString()} in ${stream.records.length.toLocaleString()} buffered records`;
  }

  function renderLogMatchMarkers() {
    const target = document.getElementById("log-match-markers");
    const stream = state.stream;
    if (!target || !stream) return;
    if (!stream.matchIndexes.length || stream.records.length < 2) {
      target.replaceChildren();
      return;
    }
    const indexes = stream.matchIndexes.length > 300
      ? stream.matchIndexes.filter((_, index) => index % Math.ceil(stream.matchIndexes.length / 300) === 0)
      : stream.matchIndexes;
    const fragment = document.createDocumentFragment();
    for (const index of indexes) {
      const marker = document.createElement("i");
      marker.style.top = `${index / (stream.records.length - 1) * 100}%`;
      fragment.append(marker);
    }
    target.replaceChildren(fragment);
  }

  function scheduleLogPositionUpdate(userScroll = false) {
    const stream = state.stream;
    if (!stream) return;
    if (userScroll) stream.positionFromUser = true;
    if (stream.positionFrame) return;
    stream.positionFrame = requestAnimationFrame(() => {
      if (state.stream !== stream) return;
      stream.positionFrame = 0;
      const fromUser = stream.positionFromUser;
      stream.positionFromUser = false;
      updateLogPosition(fromUser);
    });
  }

  function updateLogPosition(userScroll = false) {
    const container = document.getElementById("stream");
    const output = document.getElementById("log-position");
    const thumb = document.getElementById("log-position-thumb");
    const stream = state.stream;
    if (!container || !output || !thumb || !stream) return;
    const range = Math.max(0, container.scrollHeight - container.clientHeight);
    const viewportRatio = range ? Math.max(0, Math.min(1, container.scrollTop / range)) : stream.records.length ? 1 : 0;
    const visiblePosition = Math.round(viewportRatio * Math.max(0, stream.visibleIndexes.length - 1));
    const bufferIndex = stream.visibleIndexes[visiblePosition] ?? (stream.records.length ? stream.records.length - 1 : 0);
    const bufferRatio = stream.records.length > 1 ? bufferIndex / (stream.records.length - 1) : stream.records.length ? 1 : 0;
    const percent = Math.round(bufferRatio * 100);
    output.value = `${percent}%`;
    output.textContent = output.value;
    const railHeight = thumb.parentElement?.clientHeight || 0;
    const thumbTravel = Math.max(0, railHeight - (thumb.offsetHeight || 20));
    thumb.style.top = `${Math.round(bufferRatio * thumbTravel)}px`;
    if (userScroll) {
      const follow = document.getElementById("stream-follow");
      const distanceFromBottom = Math.max(0, range - container.scrollTop);
      if (follow && distanceFromBottom <= 16 && !follow.checked) {
        follow.checked = true;
        container.scrollTop = container.scrollHeight;
        setStreamStatus("Live · following latest", "info");
      } else if (follow?.checked && distanceFromBottom > 36) {
        follow.checked = false;
        setStreamStatus("Paused · live logs still buffering", "warning");
      }
    }
  }

  function scrollLogToLatest() {
    const container = document.getElementById("stream");
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    scheduleLogPositionUpdate();
  }

  function navigateLogMatch(step) {
    const stream = state.stream;
    if (!stream?.matchIndexes.length) return;
    const next = stream.activeMatch < 0
      ? (step < 0 ? stream.matchIndexes.length - 1 : 0)
      : (stream.activeMatch + step + stream.matchIndexes.length) % stream.matchIndexes.length;
    stream.activeMatch = next;
    jumpToLogIndex(stream.matchIndexes[next]);
  }

  function jumpToLogIndex(index, remember = true) {
    const container = document.getElementById("stream");
    const row = container?.querySelector(`.stream-row[data-index="${index}"]`);
    const stream = state.stream;
    if (!container || !row || !stream) return;
    if (remember) {
      recordLogJump(Number(index));
      return;
    }
    scrollToLogIndex(Number(index));
  }

  function scrollToLogIndex(index) {
    const container = document.getElementById("stream");
    const row = container?.querySelector(`.stream-row[data-index="${index}"]`);
    const stream = state.stream;
    if (!container || !row || !stream) return false;
    const follow = document.getElementById("stream-follow");
    if (follow?.checked) follow.checked = false;
    const targetTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, row.offsetTop - container.clientHeight / 2 + row.offsetHeight / 2));
    container.scrollTop = targetTop;
    stream.activeMatch = stream.matchIndexes.indexOf(Number(index));
    selectLogRecord(Number(index));
    renderLogResults();
    updateLogNavigationButtons();
    scheduleLogPositionUpdate();
    setStreamStatus("Paused at selected record · live records continue buffering", "info");
    return true;
  }

  function currentLogAnchor() {
    const container = document.getElementById("stream");
    const stream = state.stream;
    if (!container || !stream) return null;
    const center = container.scrollTop + container.clientHeight / 2;
    let closest = null;
    let distance = Number.POSITIVE_INFINITY;
    container.querySelectorAll(".stream-row").forEach(row => {
      const candidate = Math.abs(row.offsetTop + row.offsetHeight / 2 - center);
      if (candidate < distance) {
        distance = candidate;
        closest = row;
      }
    });
    if (!closest) return null;
    const index = Number(closest.dataset.index);
    return { key: closest.dataset.key, indexHint: index };
  }

  function recordLogJump(index) {
    const stream = state.stream;
    const record = stream?.records[index];
    if (!stream || !record) return;
    const current = currentLogAnchor();
    const target = { key: activityRecordKey(record, index), indexHint: index };
    stream.jumpHistory = stream.jumpHistory.slice(0, stream.jumpIndex + 1);
    const latest = stream.jumpHistory.at(-1);
    if (current && latest?.key !== current.key) stream.jumpHistory.push(current);
    if (stream.jumpHistory.at(-1)?.key !== target.key) stream.jumpHistory.push(target);
    stream.jumpIndex = stream.jumpHistory.length - 1;
    scrollToLogIndex(index);
  }

  function moveLogJump(direction) {
    const stream = state.stream;
    if (!stream) return;
    const next = stream.jumpIndex + direction;
    if (next < 0 || next >= stream.jumpHistory.length) return;
    const anchor = stream.jumpHistory[next];
    let index = stream.records.findIndex((record, candidate) => activityRecordKey(record, candidate) === anchor.key);
    if (index < 0) index = Math.max(0, Math.min(stream.records.length - 1, Number(anchor.indexHint || 0)));
    if (!document.querySelector(`.stream-row[data-index="${index}"]`)) {
      toast("That log position is outside the current filter.", "error");
      return;
    }
    stream.jumpIndex = next;
    scrollToLogIndex(index);
  }

  function updateLogNavigationButtons() {
    const stream = state.stream;
    const setDisabled = (action, disabled) => {
      const button = document.querySelector(`[data-action="${action}"]`);
      if (button) button.disabled = disabled;
    };
    setDisabled("previous-log-match", !stream?.matchIndexes.length);
    setDisabled("next-log-match", !stream?.matchIndexes.length);
    setDisabled("log-jump-back", !stream || stream.jumpIndex <= 0);
    setDisabled("log-jump-forward", !stream || stream.jumpIndex < 0 || stream.jumpIndex >= stream.jumpHistory.length - 1);
  }

  function selectLogRecord(index) {
    const stream = state.stream;
    if (!stream || !stream.records[index]) return;
    stream.selectedKey = activityRecordKey(stream.records[index], index);
    document.querySelectorAll(".stream-row.selected").forEach(row => {
      row.classList.remove("selected");
    });
    const selected = document.querySelector(`.stream-row[data-index="${index}"]`);
    selected?.classList.add("selected");
    const pin = document.querySelector('[data-action="pin-selected-record"]');
    if (pin) pin.disabled = false;
    if (document.getElementById("log-inspector")?.hidden === false) {
      setLogInspector(true);
    }
  }

  function selectedLogRecord() {
    const stream = state.stream;
    if (!stream?.selectedKey) return null;
    const index = stream.records.findIndex((record, candidate) => activityRecordKey(record, candidate) === stream.selectedKey);
    return index >= 0 ? { index, record: stream.records[index] } : null;
  }

  function renderLogRecordInspector(index) {
    const target = document.getElementById("log-record-detail");
    const stream = state.stream;
    const record = stream?.records[index];
    if (!target || !record) return;
    const key = activityRecordKey(record, index);
    const selectedFormat = stream.profile.overrides.get(key) || "inherit";
    const origin = displayLogOrigin(record);
    const correlations = personal.correlationIDs(record);
    const handoffs = availableHandoffs(record);
    const focusActions = record.pod ? `<div class="log-record-focus">
      <span>Focus the live stream</span>
      <button class="log-focus-choice" data-action="focus-log-pod" data-pod="${html(record.pod)}">Only this pod</button>
      ${record.container ? `<button class="log-focus-choice" data-action="focus-log-source" data-pod="${html(record.pod)}" data-container="${html(record.container)}">Only this source</button>` : ""}
    </div>` : "";
    target.innerHTML = `
      <div class="log-record-meta"><span>${html(formatTime(record.timestamp, true))}</span><span>${html(origin || record.type || "record")}</span></div>
      ${correlations.length ? `<div class="log-correlation"><span>Correlation</span>${correlations.map(item => `<code>${html(item.key)}=${html(item.value)}</code>`).join("")}</div>` : ""}
      ${handoffs.length ? `<div class="log-handoff-actions"><span>Open in</span>${handoffs.map(item => `<button class="btn ghost small" data-action="open-handoff" data-id="${html(item.id)}" data-index="${index}">${html(item.name)}</button>`).join("")}</div>` : ""}
      ${focusActions}
      <div class="log-record-actions">
        <span>Render this record as</span>
        ${["inherit", "raw", "json", "logfmt", "stack"].map(mode => `<button class="log-format-choice ${selectedFormat === mode ? "active" : ""}" data-action="format-log-record" data-format="${mode}" data-index="${index}">${mode === "inherit" ? "Default" : mode === "logfmt" ? "Key/value" : mode === "stack" ? "Stack trace" : mode.toUpperCase()}</button>`).join("")}
      </div>
      <div class="log-record-raw-heading"><span>Raw record</span><button class="btn ghost small" data-action="copy-log-record" data-index="${index}">Copy</button></div>
      <pre class="log-record-raw"></pre>`;
    target.querySelector(".log-record-raw").textContent = String(record.message || "");
  }

  function formatSelectedLogRecord(index, mode) {
    const stream = state.stream;
    const record = stream?.records[index];
    if (!stream || !record) return;
    const key = activityRecordKey(record, index);
    if (mode === "inherit") stream.profile.overrides.delete(key);
    else stream.profile.overrides.set(key, mode);
    scheduleActivityRender(true);
    requestAnimationFrame(() => {
      selectLogRecord(index);
      jumpToLogIndex(index, false);
    });
  }

  async function copyLogRecord(index) {
    const record = state.stream?.records[index];
    if (!record) return;
    await navigator.clipboard.writeText(String(record.message || ""));
    toast("Record copied");
  }

  function toggleLogEntry(index) {
    const stream = state.stream;
    const record = stream?.records[index];
    if (!stream || !record) return;
    const key = activityRecordKey(record, index);
    if (stream.expandedEntries.has(key)) stream.expandedEntries.delete(key);
    else stream.expandedEntries.add(key);
    scheduleActivityRender(true);
  }

  function renderLogFormatterPreview() {
    const target = document.getElementById("log-formatter-preview");
    const stream = state.stream;
    if (!target || !stream) return;
    const selected = selectedLogRecord();
    if (!selected) {
      target.textContent = "Select a record to preview this rule.";
      return;
    }
    stream.profile.formatError = "";
    const result = applyCustomLogFormatter(String(selected.record.message || ""), stream.profile);
    target.classList.toggle("error", Boolean(stream.profile.formatError));
    target.textContent = stream.profile.formatError || result?.text || "The selected record does not match this pattern.";
  }

  function setLogToolPanel(name, force) {
    const map = {
      filters: ["log-filter-panel", "toggle-log-filters"],
      formatter: ["log-formatter-panel", "toggle-log-formatter"],
      shortcuts: ["log-shortcut-panel", "toggle-log-shortcuts"],
    };
    for (const [otherName, [otherPanelID, otherAction]] of Object.entries(map)) {
      if (otherName === name) continue;
      const otherPanel = document.getElementById(otherPanelID);
      if (otherPanel) otherPanel.hidden = true;
      document.querySelector(`[data-action="${otherAction}"]`)?.setAttribute("aria-expanded", "false");
    }
    const [panelID, action] = map[name];
    const panel = document.getElementById(panelID);
    const button = document.querySelector(`[data-action="${action}"]`);
    if (!panel) return;
    const open = force ?? panel.hidden;
    panel.hidden = !open;
    button?.setAttribute("aria-expanded", String(open));
  }

  function toggleLogFilterPicker(force) {
    const picker = document.getElementById("log-filter-picker");
    const button = document.querySelector('[data-action="toggle-log-filter-picker"]');
    if (!picker) return;
    const open = force ?? picker.hidden;
    picker.hidden = !open;
    button?.setAttribute("aria-expanded", String(open));
  }

  function showLogFilter(filter) {
    const row = document.getElementById(`log-filter-row-${filter}`);
    if (!row) return;
    row.hidden = false;
    toggleLogFilterPicker(false);
    requestAnimationFrame(() => row.querySelector("input, select")?.focus());
  }

  function removeLogFilter(filter) {
    const config = {
      path: [["log-http-path-filter", ""]],
      method: [["log-http-method-filter", ""]],
      status: [["log-http-status-filter", ""]],
      regex: [["log-find-mode", "text"]],
      context: [["log-context-before", "0"], ["log-context-after", "0"]],
    };
    for (const [id, value] of config[filter] || []) {
      const input = document.getElementById(id);
      if (input) input.value = value;
    }
    const row = document.getElementById(`log-filter-row-${filter}`);
    if (row) row.hidden = true;
    scheduleActivityRender(true);
  }

  function setLogInspector(force) {
    const workbench = document.querySelector(".log-workbench");
    const inspector = document.getElementById("log-inspector");
    const button = document.querySelector('.log-commandbar [data-action="toggle-log-inspector"]');
    if (!workbench || !inspector) return;
    const open = force ?? inspector.hidden;
    const restoreFocus = !open && inspector.contains(document.activeElement);
    inspector.hidden = !open;
    workbench.classList.toggle("inspector-collapsed", !open);
    button?.classList.toggle("active", open);
    button?.setAttribute("aria-expanded", String(open));
    if (open) {
      renderLogResults();
      refreshSelectedLogInspector();
      requestAnimationFrame(() => scheduleLogPositionUpdate());
    } else if (restoreFocus) {
      requestAnimationFrame(() => button?.focus());
    }
  }

  function clearLogFilters() {
    const values = {
      "stream-search": "",
      "log-level-filter": "",
      "log-source-filter": "",
      "log-http-path-filter": "",
      "log-http-method-filter": "",
      "log-http-status-filter": "",
      "log-find-mode": "text",
      "log-context-before": "0",
      "log-context-after": "0",
    };
    for (const [id, value] of Object.entries(values)) {
      const input = document.getElementById(id);
      if (input) input.value = value;
    }
    for (const row of document.querySelectorAll(".log-filter-condition")) row.hidden = true;
    toggleLogFilterPicker(false);
    if (state.stream) state.stream.activeMatch = -1;
    scheduleActivityRender(true);
  }

  function resetLogFormatter() {
    const stream = state.stream;
    if (!stream) return;
    stream.profile.mode = "auto";
    stream.profile.pattern = "";
    stream.profile.template = "";
    stream.profile.compiled = null;
    stream.profile.compiledSource = "";
    stream.profile.formatError = "";
    stream.profile.overrides.clear();
    const mode = document.getElementById("log-formatter");
    const pattern = document.getElementById("log-custom-pattern");
    const template = document.getElementById("log-custom-template");
    if (mode) mode.value = "auto";
    updateLogFormatMenu("auto");
    if (pattern) pattern.value = "";
    if (template) template.value = "";
    renderLogFormatterPreview();
    scheduleActivityRender(true);
  }

  function structuredLogForRecord(record) {
    if (!record) return null;
    const message = String(record.message || "");
    if (record._runwakeStructuredMessage === message && record._runwakeStructuredFields === record.fields) {
      return record._runwakeStructured || null;
    }
    let parsed = parseStructuredLog(message);
    const supplied = record.fields || {};
    const suppliedIsEnriched = looksLikeHTTPFields(supplied);
    if (suppliedIsEnriched) {
      parsed = structuredLog({ ...supplied, ...(parsed?.fields || {}) });
    }
    record._runwakeStructuredMessage = message;
    record._runwakeStructuredFields = record.fields;
    record._runwakeStructured = parsed;
    return parsed;
  }

  function parseStructuredLog(message) {
    const value = String(message || "").trim();
    if (!value) return null;
    const accessLog = parseHTTPAccessLog(value);
    if (accessLog) return structuredLog(accessLog);
    if (value.startsWith("{") && value.endsWith("}")) {
      try {
        const fields = JSON.parse(value);
        if (fields && typeof fields === "object" && !Array.isArray(fields)) return structuredLog(fields);
      } catch {
        // A malformed JSON-looking line is still useful as ordinary text.
      }
    }

    const fields = {};
    const pairPattern = /(?:^|\s)([A-Za-z_][\w.-]*)=(?:"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+))/g;
    let match;
    while ((match = pairPattern.exec(value)) !== null) {
      fields[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
    }
    const recognized = ["timestamp", "time", "level", "severity", "message", "msg", "event", "component", "status"];
    if (Object.keys(fields).length >= 2 && recognized.some(key => fields[key] !== undefined)) return structuredLog(fields);

    const bracketed = value.match(/^(\d{4}-\d{2}-\d{2}[T ][^\s]+)\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s+\[([^\]\r\n]+)\]\s*([\s\S]*)$/i);
    if (bracketed) {
      return structuredLog({
        timestamp: bracketed[1],
        level: bracketed[2],
        component: bracketed[3],
        message: bracketed[4].replace(/^(?::|-)\s*/, ""),
      });
    }
    const common = value.match(/^(\d{4}-\d{2}-\d{2}[T ][^\s]+)\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s+([\s\S]+)$/i);
    if (common) {
      return structuredLog({
        timestamp: common[1],
        level: common[2],
        message: common[3],
      });
    }
    return null;
  }

  function parseHTTPAccessLog(value) {
    if (!value.includes(" HTTP/") || !value.includes('"')) return null;
    const colon = value.indexOf(":");
    if (colon > 0 && colon <= 8) {
      const level = canonicalLogLevel(value.slice(0, colon));
      const rest = value.slice(colon + 1).trim();
      const separator = rest.indexOf(' - "');
      if (level && separator > 0) {
        const client = rest.slice(0, separator).trim();
        const requestAndStatus = rest.slice(separator + 4);
        const closingQuote = requestAndStatus.indexOf('"');
        if (closingQuote > 0) {
          return httpAccessFields(client, requestAndStatus.slice(0, closingQuote), requestAndStatus.slice(closingQuote + 1), level, "uvicorn_access");
        }
      }
    }
    const openQuote = value.indexOf('"');
    const closeQuote = openQuote >= 0 ? value.indexOf('"', openQuote + 1) : -1;
    if (openQuote < 1 || closeQuote < 0) return null;
    const client = value.slice(0, openQuote).trim().split(/\s+/, 1)[0];
    return httpAccessFields(client, value.slice(openQuote + 1, closeQuote), value.slice(closeQuote + 1), "", "common_access");
  }

  function httpAccessFields(client, requestLine, statusText, level, format) {
    const request = String(requestLine || "").trim().split(/\s+/);
    const status = String(statusText || "").trim().split(/\s+/);
    if (request.length !== 3 || !/^HTTP\/\d(?:\.\d)?$/i.test(request[2]) || !/^[1-5]\d\d$/.test(status[0] || "")) return null;
    const method = request[0].toUpperCase();
    const target = request[1];
    const queryIndex = target.indexOf("?");
    const path = queryIndex >= 0 ? target.slice(0, queryIndex) : target;
    const fields = {
      logger: "http",
      log_kind: "http_access",
      log_format: format,
      level,
      message: `${method} ${path}`,
      http_method: method,
      http_target: target,
      http_path: path,
      http_protocol: request[2].toUpperCase(),
      http_status: Number(status[0]),
      http_status_class: `${status[0][0]}xx`,
      client,
    };
    if (queryIndex >= 0) fields.http_query = target.slice(queryIndex + 1);
    const endpoint = splitClientEndpoint(client);
    fields.client_address = endpoint.address;
    if (endpoint.port) fields.client_port = endpoint.port;
    if (status.length > 1) fields.http_status_text = status.slice(1).join(" ");
    return fields;
  }

  function splitClientEndpoint(client) {
    const bracketed = String(client).match(/^\[([^\]]+)\]:(\d+)$/);
    if (bracketed) return { address: bracketed[1], port: bracketed[2] };
    const value = String(client);
    const colon = value.lastIndexOf(":");
    if (colon > 0 && !value.slice(0, colon).includes(":")) return { address: value.slice(0, colon), port: value.slice(colon + 1) };
    return { address: value, port: "" };
  }

  function canonicalLogLevel(value) {
    const level = String(value || "").trim().toUpperCase();
    if (level === "WARNING") return "WARN";
    if (level === "CRITICAL") return "FATAL";
    return ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"].includes(level) ? level : "";
  }

  function structuredLog(fields) {
    fields = normalizeHTTPFields(fields);
    const rawLevel = String(fields.level ?? fields.severity ?? "").replace(/\u001b\[[0-9;]*m/g, "");
    const levelMatch = rawLevel.match(/\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b/i);
    const level = levelMatch ? levelMatch[1].toUpperCase().replace("WARNING", "WARN") : "";
    const timestamp = fields.timestamp ?? fields.time ?? fields.ts ?? "";
    const event = fields.event ?? fields.action ?? "";
    const description = fields.message ?? fields.msg ?? "";
    const summary = String(event && description ? `${event} · ${description}` : event || description || fields.component || "Structured log");
    const highlightKeys = [
      ["component", "component"],
      ["status", "status"],
      ["http_status", "status"],
      ["http_method", "method"],
      ["http_path", "path"],
      ["duration_ms", "duration"],
      ["provider", "provider"],
      ["model", "model"],
      ["model_infered", "model"],
      ["model_inferred", "model"],
      ["method", "method"],
      ["transaction_id", "transaction"],
    ];
    const seen = new Set();
    const highlights = [];
    for (const [key, label] of highlightKeys) {
      const item = fields[key];
      if (item === undefined || item === null || item === "" || item === "N/A" || seen.has(label)) continue;
      seen.add(label);
      highlights.push({ label, value: key === "duration_ms" ? `${item}ms` : String(item) });
      if (highlights.length === 5) break;
    }
    return { fields, level, timestamp, summary, highlights };
  }

  function looksLikeHTTPFields(fields) {
    const method = fields?.http_method ?? fields?.method ?? fields?.request_method;
    const target = fields?.http_target ?? fields?.http_path ?? fields?.path ?? fields?.url ?? fields?.request_uri;
    const status = fields?.http_status ?? fields?.status_code ?? fields?.response_status ?? fields?.status;
    return fields?.log_kind === "http_access" || Boolean(method && (target || status));
  }

  function normalizeHTTPFields(source) {
    if (!source || typeof source !== "object" || !looksLikeHTTPFields(source)) return source;
    const fields = { ...source };
    const method = String(fields.http_method ?? fields.method ?? fields.request_method ?? "").toUpperCase();
    const target = String(fields.http_target ?? fields.http_path ?? fields.path ?? fields.url ?? fields.request_uri ?? "");
    const statusMatch = String(fields.http_status ?? fields.status_code ?? fields.response_status ?? fields.status ?? "").match(/\b([1-5]\d\d)\b/);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    let path = String(fields.http_path || "");
    if (!path && target) {
      if (/^https?:\/\//i.test(target)) {
        try { path = new URL(target).pathname; } catch { path = target.split(/[?#]/, 1)[0]; }
      } else {
        path = target.split(/[?#]/, 1)[0];
      }
    }
    fields.logger ??= "http";
    fields.log_kind ??= "http_access";
    if (method) fields.http_method = method;
    if (target) fields.http_target = target;
    if (path) fields.http_path = path;
    if (status) {
      fields.http_status = status;
      fields.http_status_class = `${String(status)[0]}xx`;
    }
    if (!fields.message && method && path) fields.message = `${method} ${path}`;
    return fields;
  }

  function activityClass(record) {
    const value = `${record.level || ""} ${record.type || ""}`.toLowerCase();
    const status = Number(record.fields?.http_status || 0);
    if (status >= 500) return "error";
    if (status >= 400) return "warning";
    if (/error|fatal/.test(value)) return "error";
    if (/warn|termination|restart|unhealthy/.test(value)) return "warning";
    if (/system|event|runtime/.test(value)) return "system";
    return "log";
  }

  function isRuntimeEventRecord(record) {
    return String(record?.type || "").toLowerCase() === "event"
      || /(?:^|-)event$/.test(String(record?.source || "").toLowerCase());
  }
