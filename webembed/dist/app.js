/*
THESIS: Runwake is a fixed operator instrument panel; it refuses the equal-weight card dashboard.
OWN-WORLD: Cool near-black housings, steel dividers, signal blue controls, and sparse semantic lights.
STORY: Establish runtime access, tune safe defaults, then inspect live evidence without losing place.
FIRST VIEWPORT: A compact identity bar, fixed command strip, dominant evidence canvas, and narrow position/results rail.
FORM: Fixed instrumentation rack, fifth grounded Operate structure, staged around held evidence and reversible navigation; seed 8772f127.
*/
(() => {
  "use strict";

  const app = document.getElementById("app");
  const modalRoot = document.getElementById("modal-root");
  const toastRoot = document.getElementById("toast-root");

  const state = {
    meta: null,
    settings: null,
    settingsTab: "general",
    sshProfiles: [],
    sshProfilesLoaded: false,
    connections: [],
    workloads: [],
    workloadCachedConnections: new Set(),
    workloadPendingConnections: new Set(),
    workloadObservedAt: new Map(),
    workloadErrors: {},
    metrics: new Map(),
    metricErrors: {},
    workloadRenderID: 0,
    workloadRefreshing: false,
    workloadRefreshScope: [],
    workloadStream: null,
    workloadStreamTotal: 0,
    workloadStreamCompleted: 0,
    workloadDiscovered: 0,
    workloadRenderTimer: 0,
    workloadWindowFrame: 0,
    workloadWindowScrollTop: 0,
    workloadScrollIdleTimer: 0,
    workloadScrollActive: false,
    workloadViewPending: false,
    workloadPendingMenuFocus: "",
    workloadViewItems: [],
    workloadViewVersion: 0,
    workloadMetricsDeferred: false,
    workloadMetricsLoading: false,
    workloadMetricsLoaded: false,
    workloadBrowseMode: "auto",
    activityRenderID: 0,
    topologyRenderID: 0,
    topologyObserver: null,
    topologyDrawFrame: 0,
    topologyRefreshing: false,
    topologyZoom: 1,
    topologyZoomKey: "",
    route: null,
    filters: { search: "", connection: [], namespace: [], status: "" },
    connectionFilter: "all",
    stream: null,
    metricStream: null,
    logFormatterByWorkload: new Map(),
    logTargetsByWorkload: new Map(),
    authenticated: true,
  };

  const WORKLOAD_STREAM_RENDER_MS = 100;
  const WORKLOAD_ROW_HEIGHT = 69;
  const WORKLOAD_ROW_HEIGHT_NARROW = 84;
  const WORKLOAD_OVERSCAN = 8;
  const WORKLOAD_AUTO_METRICS_LIMIT = 2000;
  const WORKLOAD_OVERVIEW_THRESHOLD = 500;

  class AuthenticationRequired extends Error {}

  const html = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const terminalLogText = value => window.RunwakeTerminal?.render(value) ?? String(value ?? "");

  function filterValues(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return value ? [value] : [];
  }

  function filterIncludes(value, candidate) {
    const values = filterValues(value);
    return !values.length || values.includes(candidate);
  }

  function connectionQuery(value) {
    const params = new URLSearchParams();
    for (const id of filterValues(value)) params.append("connection_id", id);
    const query = params.toString();
    return query ? `?${query}` : "";
  }

  function formatTime(value, includeDate = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, includeDate
      ? { dateStyle: "medium", timeStyle: "medium" }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
  }

  function relativeTime(value) {
    if (!value) return "never";
    const then = new Date(value).getTime();
    if (!Number.isFinite(then)) return "unknown";
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    if (response.status === 401) {
      state.authenticated = false;
      renderLogin();
      throw new AuthenticationRequired("authentication required");
    }
    if (response.status === 204) return null;
    const type = response.headers.get("Content-Type") || "";
    const body = type.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const message = typeof body === "object" && body?.error ? body.error : String(body || response.statusText);
      throw new Error(message);
    }
    return body;
  }

  function toast(message, kind = "") {
    const node = document.createElement("div");
    node.className = `toast ${kind}`.trim();
    node.textContent = message;
    toastRoot.append(node);
    setTimeout(() => node.remove(), 4600);
  }

  function routeInfo() {
    const raw = location.hash.replace(/^#/, "") || "/workloads";
    const url = new URL(raw, "http://runwake.local");
    return { path: url.pathname, params: url.searchParams };
  }

  function navigate(path) {
    if (location.hash === `#${path}`) {
      renderRoute();
    } else {
      location.hash = path;
    }
  }

  function shell(content, active = "workloads") {
    const version = state.meta?.version ? `v${html(state.meta.version)}` : "";
    app.className = "shell";
    app.innerHTML = `
      <aside class="sidebar">
        <div class="brand"><img class="brand-mark" src="/icon.svg" alt=""><span>Runwake</span></div>
        <nav class="nav" aria-label="Primary">
          ${navButton("workloads", "▦", "Workloads", active)}
          ${navButton("connections", "↔", "Connections", active)}
          ${navButton("settings", "⚙", "Settings", active)}
        </nav>
        <div class="sidebar-foot">${version}</div>
      </aside>
      <main class="main">${content}</main>`;
  }

  function navButton(name, symbol, label, active) {
    return `<button type="button" class="nav-button ${name === active ? "active" : ""}" data-nav="/${name}">
      <span class="nav-icon" aria-hidden="true">${symbol}</span><span class="nav-label">${label}</span>
    </button>`;
  }

  async function loadMeta() {
    state.meta = await api("/api/v1/meta");
    state.authenticated = true;
  }

  function remoteAgentsAvailable() {
    return Boolean(state.meta?.features?.remote_agents);
  }
  async function loadSettings() {
    state.settings = await api("/api/v1/settings");
    return state.settings;
  }
  async function loadSSHProfiles() {
    const response = await api("/api/v1/ssh-profiles");
    state.sshProfiles = response.ssh_profiles || [];
    state.sshProfilesLoaded = true;
    return state.sshProfiles;
  }
  async function loadConnections() {
    const response = await api("/api/v1/connections");
    state.connections = response.connections || [];
    return state.connections;
  }
  async function loadWorkloads(connectionFilter = []) {
    const connectionIDs = filterValues(connectionFilter);
    const query = connectionQuery(connectionIDs);
    const response = await api(`/api/v1/workloads${query}`);
    const incoming = response.workloads || [];
    const errors = response.errors || {};
    if (!connectionIDs.length) {
      state.workloads = incoming;
      state.workloadErrors = errors;
      state.workloadCachedConnections = new Set(state.connections
        .map(connection => connection.id)
        .filter(id => !Object.hasOwn(errors, id)));
      return state.workloads;
    }
    state.workloadErrors = { ...state.workloadErrors };
    for (const id of connectionIDs) delete state.workloadErrors[id];
    Object.assign(state.workloadErrors, errors);
    const selected = new Set(connectionIDs);
    const failed = new Set(Object.keys(errors));
    for (const id of connectionIDs) {
      if (!failed.has(id)) state.workloadCachedConnections.add(id);
    }
    state.workloads = state.workloads
      .filter(item => !selected.has(item.connection_id) || failed.has(item.connection_id))
      .concat(incoming)
      .sort(compareWorkloads);
    return state.workloads;
  }
  async function loadCachedWorkloads(connectionFilter = []) {
    const connectionIDs = filterValues(connectionFilter);
    const query = connectionQuery(connectionIDs);
    const response = await api(`/api/v1/workloads/cache${query}`);
    const incoming = response.workloads || [];
    const observed = response.observed_at || {};
    if (!connectionIDs.length) {
      state.workloads = incoming;
      state.workloadObservedAt = new Map(Object.entries(observed));
      state.workloadCachedConnections = new Set(Object.keys(observed));
      return state.workloads;
    }
    const cached = new Set(Object.keys(observed));
    state.workloads = state.workloads
      .filter(item => !cached.has(item.connection_id))
      .concat(incoming)
      .sort(compareWorkloads);
    for (const [id, timestamp] of Object.entries(observed)) {
      state.workloadObservedAt.set(id, timestamp);
      state.workloadCachedConnections.add(id);
    }
    return state.workloads;
  }
  async function loadMetrics(connectionFilter = []) {
    const connectionIDs = filterValues(connectionFilter);
    const query = connectionQuery(connectionIDs);
    const response = await api(`/api/v1/metrics${query}`);
    const incoming = response.metrics || [];
    const errors = response.errors || {};
    if (!connectionIDs.length) {
      state.metrics = new Map(incoming.map(item => [metricKey(item), item]));
      state.metricErrors = errors;
      return state.metrics;
    }
    state.metricErrors = { ...state.metricErrors };
    for (const id of connectionIDs) delete state.metricErrors[id];
    Object.assign(state.metricErrors, errors);
    const selected = new Set(connectionIDs);
    const failed = new Set(Object.keys(errors));
    const merged = new Map([...state.metrics].filter(([, item]) => !selected.has(item.connection_id) || failed.has(item.connection_id)));
    for (const item of incoming) merged.set(metricKey(item), item);
    state.metrics = merged;
    return state.metrics;
  }

  function loadingPage(active, title = "Loading") {
    shell(`<section class="page"><div class="page-header"><div><h1 class="page-title">${html(title)}</h1></div></div><div class="loading">Loading…</div></section>`, active);
  }

  async function renderRoute() {
    closeTopologyContextMenu();
    stopActivityStream();
    stopMetricStream();
    stopWorkloadStream();
    stopTopologyLayout();
    const route = routeInfo();
    const previousPath = state.route?.path;
    state.route = route;
    if (previousPath && previousPath !== route.path) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    try {
      if (!state.meta) await loadMeta();
      if (route.path === "/connections") return renderConnections();
      if (route.path === "/settings") return renderSettings();
      if (route.path === "/activity") return renderActivity(route.params);
      if (route.path === "/topology") return renderTopology(route.params);
      return renderWorkloads();
    } catch (error) {
      if (error instanceof AuthenticationRequired) return;
      shell(`<section class="page"><div class="notice error">${html(error.message)}</div></section>`, "workloads");
    }
  }

  function renderLogin() {
    stopActivityStream();
    stopWorkloadStream();
    app.className = "login-screen";
    app.innerHTML = `<form class="login-card" id="login-form">
      <div class="brand"><img class="brand-mark" src="/icon.svg" alt=""><span>Runwake</span></div>
      <h1>Access token required</h1>
      <p>Enter the token configured on this Runwake server.</p>
      <label>Access token<input class="field" name="token" type="password" autocomplete="current-password" required autofocus></label>
      <div class="spacer-14"></div>
      <button class="btn primary full-width" type="submit">Continue</button>
    </form>`;
    document.getElementById("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button");
      button.disabled = true;
      try {
        await api("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ token: new FormData(event.currentTarget).get("token") }) });
        state.meta = null;
        state.authenticated = true;
        await renderRoute();
      } catch (error) {
        if (!(error instanceof AuthenticationRequired)) toast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
  }

  async function renderWorkloads() {
    const renderID = ++state.workloadRenderID;
    stopWorkloadStream();
    state.workloadRefreshing = false;
    state.workloadRefreshScope = [];
    state.workloadStreamTotal = 0;
    state.workloadStreamCompleted = 0;
    state.workloadDiscovered = 0;
    try {
      await loadConnections();
      const available = new Set(state.connections.map(connection => connection.id));
      state.workloads = state.workloads.filter(item => available.has(item.connection_id));
      for (const id of state.workloadCachedConnections) {
        if (!available.has(id)) state.workloadCachedConnections.delete(id);
      }
      for (const id of state.workloadPendingConnections) {
        if (!available.has(id)) state.workloadPendingConnections.delete(id);
      }
      for (const id of state.workloadObservedAt.keys()) {
        if (!available.has(id)) state.workloadObservedAt.delete(id);
      }
      const uncachedConnections = state.connections
        .map(connection => connection.id)
        .filter(id => !state.workloadCachedConnections.has(id));
      if (uncachedConnections.length) await loadCachedWorkloads(uncachedConnections);
    } catch (error) {
      if (error instanceof AuthenticationRequired) return;
      if (renderID !== state.workloadRenderID) return;
      state.workloadRefreshing = false;
      throw error;
    }
    if (renderID !== state.workloadRenderID) return;
    const missingConnections = state.connections
      .map(connection => connection.id)
      .filter(id => !state.workloadCachedConnections.has(id) || state.workloadPendingConnections.has(id));
    state.workloadRefreshing = missingConnections.length > 0;
    state.workloadRefreshScope = missingConnections;
    drawWorkloads();
    if (!state.connections.length) {
      state.workloadRefreshing = false;
      updateWorkloadView();
      return;
    }
    if (missingConnections.length) {
      startWorkloadStream(renderID, true, missingConnections);
    } else if (!state.metrics.size) {
      loadWorkloadMetrics(renderID);
    }
  }

  function refreshWorkloads(connectionFilter = []) {
    if (state.workloadRefreshing) return;
    const connectionIDs = filterValues(connectionFilter);
    const targetConnectionIDs = connectionIDs.length
      ? connectionIDs
      : state.connections.map(connection => connection.id);
    for (const id of targetConnectionIDs) state.workloadPendingConnections.add(id);
    const renderID = ++state.workloadRenderID;
    stopWorkloadStream();
    state.workloadRefreshing = true;
    state.workloadRefreshScope = connectionIDs;
    state.workloadStreamTotal = 0;
    state.workloadStreamCompleted = 0;
    state.workloadDiscovered = 0;
    if (connectionIDs.length) {
      state.workloadErrors = { ...state.workloadErrors };
      for (const id of connectionIDs) delete state.workloadErrors[id];
    } else {
      state.workloadErrors = {};
    }
    updateWorkloadView();
    if (!state.connections.length) {
      state.workloadRefreshing = false;
      state.workloadRefreshScope = [];
      updateWorkloadView();
      return;
    }
    startWorkloadStream(renderID, true, connectionIDs);
  }

  function drawWorkloads() {
    const filters = state.filters;
    const namespaces = [...new Set(state.workloads.map(item => item.namespace).filter(Boolean))].sort();
    const filtered = filteredWorkloads();
    state.workloadViewItems = filtered;
    state.workloadViewVersion += 1;
    state.workloadWindowScrollTop = 0;
    const body = `
      <section class="page workloads-page" aria-busy="${state.workloadRefreshing}">
        <header class="page-header">
          <div><h1 class="page-title">Workloads</h1></div>
          <div class="header-actions"><button id="refresh-workloads" class="btn" data-action="refresh-workloads" title="${html(workloadRefreshTitle())}" ${state.workloadRefreshing ? "disabled" : ""}>${html(workloadRefreshLabel())}</button><button class="btn primary" data-action="add-connection">Add connection</button></div>
        </header>
        <div id="workload-errors">${workloadErrorNotice()}</div>
        <div id="metrics-availability">${metricsAvailability()}</div>
        ${state.connections.length ? `
          <div id="workload-inventory-status">${workloadInventoryStatus()}</div>
          <div class="toolbar">
            <div class="search-wrap"><label class="sr-only" for="workload-search">Search workloads</label><input id="workload-search" class="field" type="search" placeholder="Search name, namespace, image…" value="${html(filters.search)}"></div>
            ${renderWorkloadFilterMenu("connection-filter", "connection", "Connection", [{ value: "", label: "All connections" }, ...state.connections.map(connection => ({ value: connection.id, label: connection.name }))], filters.connection, true)}
            ${renderWorkloadFilterMenu("namespace-filter", "namespace", "Namespace", [{ value: "", label: "All namespaces" }, ...namespaces.map(namespace => ({ value: namespace, label: namespace }))], filters.namespace, true)}
            ${renderWorkloadFilterMenu("status-filter", "status", "State", [{ value: "", label: "Any state" }, { value: "good", label: "Ready" }, { value: "warn", label: "Needs attention" }, { value: "bad", label: "Failed" }, { value: "other", label: "Other" }], filters.status)}
          </div>` : ""}
        <div id="workload-content">${workloadContent(filtered)}</div>
      </section>`;
    shell(body, "workloads");
    bindWorkloadControls();
  }

  function renderWorkloadFilterMenu(inputID, filter, label, options, selected, multiple = false) {
    const menuID = `${inputID}-menu`;
    const optionsID = `${menuID}-options`;
    const selectedValues = filterValues(selected);
    const selectedOptions = options.filter(option => selectedValues.includes(option.value));
    const selectedLabel = multiple && selectedOptions.length > 1
      ? `${selectedOptions.length} ${filter === "connection" ? "connections" : "namespaces"}`
      : selectedOptions[0]?.label || options[0]?.label || "";
    const fullLabel = selectedOptions.length ? selectedOptions.map(option => option.label).join(", ") : options[0]?.label || "";
    return `<div class="log-menu-field workload-filter-menu" data-workload-filter="${html(filter)}" data-options="${html(workloadFilterSignature(options))}" data-multiple="${multiple}">
      <input id="${html(inputID)}" type="hidden" value="${html(multiple ? JSON.stringify(selectedValues) : selectedValues[0] || "")}">
      <button type="button" class="log-menu-trigger" data-action="toggle-log-menu" aria-label="${html(label)}: ${html(fullLabel)}" title="${html(fullLabel)}" aria-haspopup="dialog" aria-controls="${menuID}" aria-expanded="false">
        <span data-log-menu-label>${html(selectedLabel)}</span><span class="log-menu-chevron" aria-hidden="true"></span>
      </button>
      <div id="${menuID}" class="log-menu" role="dialog" aria-label="Choose ${html(label.toLowerCase())}" hidden>
        ${renderLogMenuSearch(`Search ${label.toLowerCase()}…`, optionsID)}
        <div class="log-menu-results-meta" data-log-menu-summary>${options.length} options</div>
        <div id="${optionsID}" role="listbox" aria-label="${html(label)} options" aria-multiselectable="${multiple}" data-log-menu-options>${workloadFilterOptions(options, selectedValues, filter, multiple)}</div>
        ${renderLogMenuEmpty()}
        ${multiple ? `<div class="workload-multiselect-footer"><span data-workload-selection-count>${selectedValues.length ? `${selectedValues.length} selected` : "All"}</span><div><button type="button" class="workload-filter-clear" data-action="clear-workload-filter-draft">Clear</button><button type="button" class="workload-filter-apply" data-action="apply-workload-filter">Apply</button></div></div>` : ""}
      </div>
    </div>`;
  }

  function renderFixedChoiceMenu(inputID, name, label, options, selected) {
    const selectedOption = options.find(option => option.value === selected) || options[0];
    const menuID = `${inputID}-menu`;
    return `<div class="log-menu-field fixed-choice-menu" data-fixed-choice-menu data-choice-label="${html(label)}">
      <input id="${html(inputID)}" type="hidden" name="${html(name)}" value="${html(selectedOption.value)}">
      <button type="button" class="log-menu-trigger" data-action="toggle-log-menu" aria-label="${html(label)}: ${html(selectedOption.label)}" aria-haspopup="listbox" aria-controls="${html(menuID)}" aria-expanded="false">
        <span data-log-menu-label>${html(selectedOption.label)}</span><span class="log-menu-chevron" aria-hidden="true"></span>
      </button>
      <div id="${html(menuID)}" class="log-menu fixed-choice-popover" role="listbox" aria-label="${html(label)}" hidden>
        <div data-log-menu-options>
          ${options.map(option => `<button type="button" class="log-menu-option fixed-choice-option ${option.value === selectedOption.value ? "selected" : ""}" role="option" aria-selected="${option.value === selectedOption.value}" data-action="select-fixed-choice" data-value="${html(option.value)}" data-label="${html(option.label)}" data-search="${html(`${option.label} ${option.description}`.toLowerCase())}">
            <span class="fixed-choice-copy"><strong>${html(option.label)}</strong><small>${html(option.description)}</small></span><span class="log-menu-check" aria-hidden="true">✓</span>
          </button>`).join("")}
        </div>
      </div>
    </div>`;
  }

  function selectFixedChoice(option) {
    const field = option?.closest("[data-fixed-choice-menu]");
    const input = field?.querySelector("input[type=hidden]");
    const value = option?.dataset.value || "";
    const label = option?.dataset.label || "";
    if (!field || !input || !value || !label) return;
    input.value = value;
    field.querySelector("[data-log-menu-label]")?.replaceChildren(document.createTextNode(label));
    const trigger = field.querySelector(".log-menu-trigger");
    if (trigger) trigger.setAttribute("aria-label", `${field.dataset.choiceLabel}: ${label}`);
    for (const item of field.querySelectorAll(".log-menu-option")) {
      const selected = item === option;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
    }
    closeLogMenus(true);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function workloadFilterOptions(options, selected, filter, multiple = false) {
    const selectedValues = new Set(filterValues(selected));
    return options.map(option => {
      const isSelected = option.value ? selectedValues.has(option.value) : selectedValues.size === 0;
      return `<button type="button" class="log-menu-option ${isSelected ? "selected" : ""}" role="option" aria-selected="${isSelected}" data-action="${multiple ? "toggle-workload-filter-option" : "select-workload-filter"}" data-filter="${html(filter)}" data-value="${html(option.value)}" data-label="${html(option.label)}" data-search="${html(option.label.toLowerCase())}" title="${html(option.label)}"><span>${html(option.label)}</span><span class="log-menu-check" aria-hidden="true">✓</span></button>`;
    }).join("");
  }

  function workloadFilterSignature(options) {
    return JSON.stringify(options);
  }

  function startWorkloadStream(renderID, preserveExisting, connectionFilter = []) {
    const connectionIDs = filterValues(connectionFilter);
    const query = connectionQuery(connectionIDs);
    const source = new EventSource(`/api/v1/workloads/stream${query}`);
    const initialItems = new Map((preserveExisting ? state.workloads : []).map(item => [metricKey(item), item]));
    const targetConnections = new Set(connectionIDs.length ? connectionIDs : state.connections.map(connection => connection.id));
    const stream = {
      source,
      renderID,
      connectionIDs,
      targetConnections,
      complete: false,
      fallingBack: false,
      seen: new Set(),
      initialKeys: new Set(initialItems.keys()),
      items: initialItems,
    };
    state.workloadStream = stream;

    source.addEventListener("start", event => {
      if (state.workloadStream !== stream) return;
      const payload = JSON.parse(event.data);
      state.workloadStreamTotal = Number(payload.connections || 0);
      scheduleWorkloadView();
    });
    source.addEventListener("workload", event => {
      if (state.workloadStream !== stream) return;
      const workload = JSON.parse(event.data);
      const key = metricKey(workload);
      stream.seen.add(key);
      stream.items.set(key, workload);
      state.workloadDiscovered = stream.seen.size;
      scheduleWorkloadView();
    });
    source.addEventListener("connection-complete", event => {
      if (state.workloadStream !== stream) return;
      const payload = JSON.parse(event.data);
      state.workloadStreamCompleted += 1;
      if (payload.error) state.workloadErrors[payload.connection_id] = payload.error;
      else {
        delete state.workloadErrors[payload.connection_id];
        state.workloadCachedConnections.add(payload.connection_id);
        state.workloadObservedAt.set(payload.connection_id, new Date().toISOString());
      }
      state.workloadPendingConnections.delete(payload.connection_id);
      scheduleWorkloadView();
    });
    source.addEventListener("complete", event => {
      if (state.workloadStream !== stream) return;
      stream.complete = true;
      if (state.workloadRenderTimer) clearTimeout(state.workloadRenderTimer);
      state.workloadRenderTimer = 0;
      const payload = JSON.parse(event.data);
      const failures = new Set(Object.keys(payload.errors || {}));
      state.workloadErrors = { ...state.workloadErrors, ...(payload.errors || {}) };
      state.workloads = [...stream.items.entries()]
        .filter(([key, item]) => {
          if (!stream.targetConnections.has(item.connection_id)) return true;
          if (failures.has(item.connection_id)) return stream.initialKeys.has(key) || stream.seen.has(key);
          return stream.seen.has(key);
        })
        .map(([, item]) => item)
        .sort(compareWorkloads);
      state.workloadRefreshing = false;
      state.workloadRefreshScope = [];
      source.close();
      state.workloadStream = null;
      updateWorkloadView();
      loadWorkloadMetrics(renderID, connectionIDs);
    });
    source.addEventListener("error", () => {
      if (state.workloadStream !== stream || stream.complete || stream.fallingBack) return;
      stream.fallingBack = true;
      source.close();
      loadWorkloads(connectionIDs).then(() => {
        if (renderID !== state.workloadRenderID || state.route?.path !== "/workloads") return;
        state.workloadRefreshing = false;
        state.workloadRefreshScope = [];
        for (const id of stream.targetConnections) state.workloadPendingConnections.delete(id);
        state.workloadStream = null;
        updateWorkloadView();
        loadWorkloadMetrics(renderID, connectionIDs);
      }).catch(error => {
        if (error instanceof AuthenticationRequired) return;
        if (renderID !== state.workloadRenderID) return;
        state.workloadRefreshing = false;
        state.workloadRefreshScope = [];
        state.workloadStream = null;
        updateWorkloadView();
        toast(`Refresh failed: ${error.message}`, "error");
      });
    });
  }

  function stopWorkloadStream() {
    if (state.workloadStream?.source) state.workloadStream.source.close();
    state.workloadStream = null;
    if (state.workloadRenderTimer) clearTimeout(state.workloadRenderTimer);
    state.workloadRenderTimer = 0;
    if (state.workloadWindowFrame) cancelAnimationFrame(state.workloadWindowFrame);
    state.workloadWindowFrame = 0;
    if (state.workloadScrollIdleTimer) clearTimeout(state.workloadScrollIdleTimer);
    state.workloadScrollIdleTimer = 0;
    state.workloadScrollActive = false;
    state.workloadViewPending = false;
  }

  function scheduleWorkloadView() {
    if (state.workloadRenderTimer) return;
    state.workloadRenderTimer = setTimeout(() => {
      state.workloadRenderTimer = 0;
      const stream = state.workloadStream;
      if (stream) state.workloads = [...stream.items.values()].sort(compareWorkloads);
      updateWorkloadView();
    }, WORKLOAD_STREAM_RENDER_MS);
  }

  function updateWorkloadView(resetScroll = false) {
    if (state.route?.path !== "/workloads") return;
    const content = document.getElementById("workload-content");
    if (!content) return;
    const viewport = document.getElementById("workload-table-scroll");
    if (!resetScroll && ((state.workloadScrollActive && viewport) || workloadActionMenuOpen())) {
      state.workloadViewPending = true;
      return;
    }
    state.workloadViewPending = false;
    const items = filteredWorkloads();
    state.workloadViewItems = items;
    state.workloadViewVersion += 1;
    const displayMode = workloadDisplayMode(items);
    const shouldShowTable = state.connections.length && state.workloads.length && items.length && displayMode === "list";
    if (!shouldShowTable || !viewport) {
      const overviewScroll = document.getElementById("workload-overview-scroll")?.scrollTop || 0;
      content.innerHTML = workloadContent(items);
      content.dataset.workloadView = displayMode;
      state.workloadWindowScrollTop = 0;
      bindWorkloadViewport();
      const nextOverview = document.getElementById("workload-overview-scroll");
      if (nextOverview && !resetScroll) nextOverview.scrollTop = overviewScroll;
    } else {
      content.dataset.workloadView = "list";
      if (resetScroll) {
        state.workloadWindowScrollTop = 0;
        viewport.scrollTop = 0;
      }
      updateWorkloadWindow(true);
    }
    updateNamespaceOptions();
    const errors = document.getElementById("workload-errors");
    if (errors) errors.innerHTML = workloadErrorNotice();
    const status = document.getElementById("workload-inventory-status");
    if (status) status.innerHTML = workloadInventoryStatus();
    const page = content.closest(".page");
    if (page) page.setAttribute("aria-busy", String(state.workloadRefreshing));
    const refresh = document.getElementById("refresh-workloads");
    if (refresh) {
      refresh.disabled = state.workloadRefreshing;
      refresh.textContent = workloadRefreshLabel();
      refresh.title = workloadRefreshTitle();
    }
  }

  function workloadRefreshLabel() {
    if (state.workloadRefreshing) return filterValues(state.workloadRefreshScope).length ? "Refreshing selected…" : "Discovering…";
    return filterValues(state.filters.connection).length ? "Refresh selected" : "Refresh";
  }

  function workloadRefreshTitle() {
    const connectionIDs = filterValues(state.workloadRefreshing ? state.workloadRefreshScope : state.filters.connection);
    if (connectionIDs.length === 1) return `Refresh ${connectionName(connectionIDs[0])} only`;
    if (connectionIDs.length > 1) return `Refresh ${connectionIDs.length} selected connections`;
    return "Refresh all connections";
  }

  function filteredWorkloads() {
    const filters = state.filters;
    const needle = filters.search.toLowerCase();
    return state.workloads.filter(item => {
      const haystack = [
        item.name,
        item.kind,
        item.connection,
        item.namespace,
        composeProjectName(item),
        composeServiceName(item),
        ...(item.images || []),
      ].join(" ").toLowerCase();
      return (!needle || haystack.includes(needle))
        && filterIncludes(filters.connection, item.connection_id)
        && filterIncludes(filters.namespace, item.namespace)
        && (!filters.status || statusBucket(item) === filters.status);
    });
  }

  function compareWorkloads(a, b) {
    return String(a.connection || "").localeCompare(String(b.connection || ""))
      || String(a.namespace || "").localeCompare(String(b.namespace || ""))
      || String(a.name || "").localeCompare(String(b.name || ""))
      || String(a.kind || "").localeCompare(String(b.kind || ""));
  }

  function updateNamespaceOptions() {
    const field = document.querySelector('[data-workload-filter="namespace"]');
    if (!field) return;
    const value = filterValues(state.filters.namespace);
    const namespaces = [...new Set(state.workloads.map(item => item.namespace).filter(Boolean))].sort();
    const options = [{ value: "", label: "All namespaces" }, ...namespaces.map(namespace => ({ value: namespace, label: namespace }))];
    const signature = workloadFilterSignature(options);
    if (field.dataset.options !== signature) {
      const menuOpen = !field.querySelector(".log-menu")?.hidden;
      const draftValues = menuOpen
        ? [...field.querySelectorAll(".log-menu-option.selected")].map(option => option.dataset.value).filter(Boolean)
        : value;
      field.dataset.options = signature;
      const container = field.querySelector("[data-log-menu-options]");
      if (container) container.innerHTML = workloadFilterOptions(options, draftValues, "namespace", true);
      const search = field.querySelector("[data-log-menu-search]");
      filterLogMenuOptions(field, search?.value || "");
      if (menuOpen) updateWorkloadFilterDraftSummary(field);
      else updateWorkloadFilterMenu("namespace", value);
      return;
    }
    updateWorkloadFilterMenu("namespace", value);
  }

  function workloadErrorNotice() {
    const failures = Object.entries(state.workloadErrors);
    if (!failures.length) return "";
    return `<div class="notice warning">${failures.length} connection${failures.length === 1 ? "" : "s"} could not be read. ${failures.map(([id, value]) => `${html(connectionName(id))}: ${html(value)}`).join(" · ")}</div>`;
  }

  function workloadInventoryStatus() {
    if (!state.workloadRefreshing) return "";
    const total = state.workloadStreamTotal;
    const refreshScope = filterValues(state.workloadRefreshScope);
    const progress = refreshScope.length
      ? refreshScope.length === 1 ? `Refreshing ${connectionName(refreshScope[0])}` : `Refreshing ${refreshScope.length} connections`
      : total ? `${state.workloadStreamCompleted}/${total} runtimes responded` : "Opening runtime streams";
    return `<div class="inventory-status streaming" role="status" aria-live="polite"><span class="inventory-signal" aria-hidden="true"></span><span>${html(progress)}</span><strong>${state.workloadDiscovered ? `${state.workloadDiscovered} discovered` : "Waiting for first workload"}</strong></div>`;
  }

  function loadWorkloadMetrics(renderID, connectionFilter = [], force = false) {
    if (!state.connections.length) return;
    const connectionIDs = filterValues(connectionFilter);
    const workloadCount = connectionIDs.length
      ? state.workloads.filter(item => connectionIDs.includes(item.connection_id)).length
      : state.workloads.length;
    if (!force && workloadCount > WORKLOAD_AUTO_METRICS_LIMIT) {
      state.workloadMetricsDeferred = true;
      state.workloadMetricsLoading = false;
      updateWorkloadWindow(true);
      return;
    }
    state.workloadMetricsDeferred = false;
    state.workloadMetricsLoading = true;
    updateWorkloadWindow(true);
    loadMetrics(connectionIDs).then(() => {
      if (renderID !== state.workloadRenderID || state.route?.path !== "/workloads") return;
      state.workloadMetricsLoaded = true;
      refreshWorkloadMetrics();
    }).catch(error => {
      if (!(error instanceof AuthenticationRequired)) toast(`Metrics: ${error.message}`, "error");
    }).finally(() => {
      if (renderID !== state.workloadRenderID || state.route?.path !== "/workloads") return;
      state.workloadMetricsLoading = false;
      updateWorkloadWindow(true);
    });
  }

  function metricsAvailability() {
    const count = Object.keys(state.metricErrors).length;
    if (!count) return "";
    return `<details class="metrics-availability"><summary>Metrics unavailable on ${count} connection${count === 1 ? "" : "s"}</summary><div>${Object.entries(state.metricErrors).map(([id, value]) => `${html(connectionName(id))}: ${html(value)}`).join(" · ")}</div></details>`;
  }

  function refreshWorkloadMetrics() {
    document.querySelectorAll("[data-metric-key]").forEach(row => {
      const metric = state.metrics.get(row.dataset.metricKey);
      const cpu = row.querySelector("[data-metric-cell=cpu]");
      const memory = row.querySelector("[data-metric-cell=memory]");
      if (cpu) cpu.innerHTML = metricCPUCell(metric);
      if (memory) memory.innerHTML = metricMemoryCell(metric);
    });
    const availability = document.getElementById("metrics-availability");
    if (availability) availability.innerHTML = metricsAvailability();
  }

  function workloadContent(items) {
    if (!state.connections.length) {
      return emptyState("No connections", "Add a Kubernetes cluster or Docker host to list workloads and stream live activity.", "Add connection", "add-connection");
    }
    if (state.workloadRefreshing && !state.workloads.length) {
      return `<div class="workload-discovery" role="status"><div class="discovery-track" aria-hidden="true"><span></span></div><strong>Discovering workloads</strong></div>`;
    }
    if (!state.workloads.length && Object.keys(state.workloadErrors).length) {
      return emptyState("No workload data", "Runwake could not read workloads from the configured connections. Review the errors above and test each connection.", "Open connections", "open-connections");
    }
    if (!items.length) {
      return emptyState("No matching workloads", "Change the search or filters to see other workloads.", "Clear filters", "clear-filters");
    }
    if (workloadDisplayMode(items) === "overview") return workloadOverviewContent(items);
    const initialEnd = Math.min(items.length, 24);
    return `<div class="workload-results">
      <div class="workload-results-bar">
        <strong id="workload-result-total">${html(workloadResultTotal(items.length))}</strong>
        <span class="workload-results-meta"><span id="workload-result-actions">${workloadResultActions()}</span><span id="workload-result-range">${html(workloadResultRange(0, initialEnd, items.length))}</span></span>
      </div>
      <div id="workload-table-scroll" class="table-wrap workload-table-scroll" tabindex="0" role="region" aria-label="Workload results">
        <table class="data-table workload-table" aria-rowcount="${items.length + 1}">
          <thead><tr><th>Workload</th><th>Location</th><th>State</th><th>CPU</th><th>Memory</th><th>Actions</th></tr></thead>
          <tbody>${workloadWindowRows(items, 0, initialEnd)}</tbody>
        </table>
      </div>
    </div>`;
  }

  function workloadDisplayMode(items) {
    if (!items.length) return "empty";
    if (state.workloadBrowseMode === "list") return "list";
    if (state.filters.search || filterValues(state.filters.namespace).length) return "list";
    if (state.workloadRefreshing) return "overview";
    return items.length > WORKLOAD_OVERVIEW_THRESHOLD ? "overview" : "list";
  }

  function workloadOverviewContent(items) {
    const model = workloadOverviewModel(items);
    return `<section class="workload-overview" aria-label="Browse workloads by ${html(model.singular)}">
      <div class="workload-overview-bar">
        <span><strong>${model.groups.length.toLocaleString()} ${html(model.groups.length === 1 ? model.singular : model.plural)}</strong><small>${items.length.toLocaleString()} workloads</small></span>
        <button type="button" class="table-text-action" data-action="show-workload-list">Show workloads</button>
      </div>
      <div id="workload-overview-scroll" class="workload-overview-scroll">
        <div class="workload-overview-columns" aria-hidden="true"><span>${html(model.heading)}</span><span>Workloads</span><span>State</span><span></span></div>
        <ul class="workload-group-list">
          ${model.groups.map(workloadOverviewRow).join("")}
        </ul>
      </div>
    </section>`;
  }

  function workloadOverviewModel(items) {
    const connectionIDs = [...new Set(items.map(item => item.connection_id))];
    const byConnection = !filterValues(state.filters.connection).length && connectionIDs.length > 1;
    const groups = new Map();
    for (const item of items) {
      const docker = item.platform === "docker";
      const project = docker ? composeProjectName(item) : "";
      const scope = docker ? (project || "Standalone containers") : (item.namespace || "Cluster wide");
      const key = byConnection ? item.connection_id : `${item.connection_id}|${scope}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          label: byConnection ? item.connection : scope,
          detail: byConnection ? (docker ? "Docker" : "Kubernetes") : item.connection,
          connectionID: item.connection_id,
          namespace: byConnection || docker ? "" : item.namespace || "",
          search: byConnection || !docker || !project ? "" : project,
          level: byConnection ? "connection" : "scope",
          count: 0,
          good: 0,
          warn: 0,
          bad: 0,
          other: 0,
        };
        groups.set(key, group);
      }
      group.count += 1;
      group[statusBucket(item)] += 1;
    }
    const values = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    if (byConnection) return { groups: values, singular: "connection", plural: "connections", heading: "Connection" };
    const onlyDocker = items.every(item => item.platform === "docker");
    const onlyKubernetes = items.every(item => item.platform !== "docker");
    if (onlyDocker) return { groups: values, singular: "project", plural: "projects", heading: "Project" };
    if (onlyKubernetes) return { groups: values, singular: "namespace", plural: "namespaces", heading: "Namespace" };
    return { groups: values, singular: "group", plural: "groups", heading: "Group" };
  }

  function workloadOverviewRow(group) {
    const stateClass = group.bad ? "bad" : group.warn ? "warn" : "good";
    const stateText = group.bad
      ? `${group.bad.toLocaleString()} failed${group.warn ? ` · ${group.warn.toLocaleString()} attention` : ""}`
      : group.warn ? `${group.warn.toLocaleString()} ${group.warn === 1 ? "needs" : "need"} attention`
        : `${group.good.toLocaleString()} ready`;
    const label = `Open ${group.label}, ${group.count} workloads, ${stateText}`;
    return `<li>
      <button type="button" class="workload-group-row" data-action="open-workload-group" data-level="${html(group.level)}" data-connection="${html(group.connectionID)}" data-namespace="${html(group.namespace)}" data-search="${html(group.search)}" aria-label="${html(label)}">
        <span class="workload-group-name"><strong>${html(group.label)}</strong><small>${html(group.detail)}</small></span>
        <span class="workload-group-count">${group.count.toLocaleString()}</span>
        <span class="workload-group-state ${stateClass}"><i aria-hidden="true"></i>${html(stateText)}</span>
        <span class="workload-group-arrow" aria-hidden="true">→</span>
      </button>
    </li>`;
  }

  function dockerConnection(connectionID) {
    return state.connections.find(item => item.id === connectionID && item.kind === "docker");
  }

  function canManageDockerConnection(connectionID) {
    const connection = dockerConnection(connectionID);
    return Boolean(connection && connection.mode === "direct" && connection.access_mode === "manage");
  }

  function workloadActionCell(item) {
    if (item.platform !== "docker") return `<td class="workload-action-cell"><span aria-hidden="true">—</span></td>`;
    if (!canManageDockerConnection(item.connection_id)) {
      return `<td class="workload-action-cell"><span class="workload-access-note read-only" title="This Docker connection can only view workloads">View only</span></td>`;
    }
    if (!item.uid) {
      return `<td class="workload-action-cell"><span class="workload-access-note unavailable" title="The Docker Engine did not return a container ID">Unavailable</span></td>`;
    }
    const menuID = `workload-actions-${item.connection_id}-${item.uid}`;
    return `<td class="workload-action-cell">
      <div class="connection-action-menu workload-action-menu">
        <button type="button" class="connection-menu-trigger" data-action="toggle-connection-menu" aria-label="Runtime actions for ${html(item.name)}" aria-haspopup="menu" aria-controls="${html(menuID)}" aria-expanded="false">
          <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="4" cy="10" r="1.4"></circle><circle cx="10" cy="10" r="1.4"></circle><circle cx="16" cy="10" r="1.4"></circle></svg>
        </button>
        <div id="${html(menuID)}" class="connection-menu" role="menu" aria-label="${html(item.name)} runtime actions" hidden>
          <button type="button" role="menuitem" data-action="restart-docker-container" data-connection="${html(item.connection_id)}" data-container="${html(item.uid)}" data-name="${html(item.name)}">Restart container</button>
          <div class="connection-menu-separator" role="separator"></div>
          <button type="button" class="danger" role="menuitem" data-action="delete-docker-container" data-connection="${html(item.connection_id)}" data-container="${html(item.uid)}" data-name="${html(item.name)}">Delete container</button>
        </div>
      </div>
    </td>`;
  }

  function workloadRow(item, rowIndex = -1) {
    const readiness = item.desired ? `${Number(item.ready || 0)}/${item.desired} ready` : "";
    const restarts = item.restarts ? `${item.restarts} restart${item.restarts === 1 ? "" : "s"}` : "";
    const detail = [readiness, restarts].filter(Boolean).join(" · ") || "No replica details";
    const metric = state.metrics.get(metricKey(item));
    const docker = item.platform === "docker";
    const composeProject = docker ? composeProjectName(item) : "";
    const composeService = docker ? composeServiceName(item) : "";
    const encoded = encodeURIComponent(JSON.stringify({
      connection_id: item.connection_id,
      kind: item.kind,
      namespace: item.namespace || "",
      name: item.name,
      topology_project: composeProject,
    }));
    const locationType = composeProject ? "Compose project" : docker ? "Docker runtime" : "Namespace";
    const locationPrimary = composeProject || (docker ? item.connection : (item.namespace || "Cluster wide"));
    const locationSecondary = composeProject
      ? `${composeService || "service"} via ${item.connection}`
      : docker ? "Standalone container" : item.connection;
    const topologyRequest = composeProject
      ? encodeURIComponent(JSON.stringify({ connection_id: item.connection_id, project: composeProject }))
      : "";
    const locationPrimaryHTML = topologyRequest
      ? `<button type="button" class="location-primary location-primary-link" data-topology="${topologyRequest}" aria-label="Open ${html(composeProject)} topology">${html(locationPrimary)}</button>`
      : `<div class="location-primary" title="${html(locationPrimary)}">${html(locationPrimary)}</div>`;
    return `<tr class="clickable" tabindex="0" ${rowIndex >= 0 ? `aria-rowindex="${rowIndex + 2}"` : ""} data-workload="${encoded}" data-metric-key="${html(metricKey(item))}">
      <td><div class="cell-title">${html(item.name)}</div><div class="cell-subtitle">${html(item.kind || item.platform)}</div><div class="workload-mobile-location">${html(locationPrimary)} · ${html(locationSecondary)}</div></td>
      <td>${locationPrimaryHTML}<div class="location-route"><span>${html(locationType)}</span><span aria-hidden="true">·</span><span title="${html(locationSecondary)}">${html(locationSecondary)}</span></div></td>
      <td><span class="status ${statusBucket(item)}">${html(item.state || "Unknown")}</span><div class="cell-subtitle">${html(detail)}</div></td>
      <td data-metric-cell="cpu">${metricCPUCell(metric)}</td>
      <td data-metric-cell="memory">${metricMemoryCell(metric)}</td>
      ${workloadActionCell(item)}
    </tr>`;
  }

  function workloadRowHeight() {
    return window.matchMedia("(max-width: 650px)").matches ? WORKLOAD_ROW_HEIGHT_NARROW : WORKLOAD_ROW_HEIGHT;
  }

  function workloadWindowRows(items, start, end) {
    const rowHeight = workloadRowHeight();
    const rows = [];
    if (start > 0) rows.push(workloadSpacerRow(start * rowHeight));
    for (let index = start; index < end; index += 1) rows.push(workloadRow(items[index], index));
    if (end < items.length) rows.push(workloadSpacerRow((items.length - end) * rowHeight));
    return rows.join("");
  }

  function workloadSpacerRow(height) {
    return `<tr class="workload-virtual-spacer" aria-hidden="true"><td colspan="6" style="height:${height}px"></td></tr>`;
  }

  function workloadResultTotal(count) {
    const filters = state.filters;
    const filtered = Boolean(filters.search || filterValues(filters.connection).length || filterValues(filters.namespace).length || filters.status);
    return `${count.toLocaleString()} ${filtered ? (count === 1 ? "match" : "matches") : (count === 1 ? "workload" : "workloads")}`;
  }

  function workloadResultRange(start, end, total) {
    if (!total) return "Showing 0";
    return `Showing ${(start + 1).toLocaleString()}–${end.toLocaleString()}`;
  }

  function workloadMetricsAction() {
    if (state.workloadMetricsLoading) return `<button type="button" class="table-text-action" disabled>Loading metrics…</button>`;
    if (!state.workloadMetricsDeferred) return "";
    const label = state.workloadMetricsLoaded ? "Refresh metrics" : "Load metrics";
    return `<button type="button" class="table-text-action" data-action="load-workload-metrics" title="Load CPU and memory for the current inventory">${label}</button>`;
  }

  function workloadResultActions() {
    return `${workloadOverviewReturnAction()}${workloadMetricsAction()}`;
  }

  function workloadOverviewReturnAction() {
    const filters = state.filters;
    const baseItems = state.workloads.filter(item => {
      return filterIncludes(filters.connection, item.connection_id)
        && (!filters.status || statusBucket(item) === filters.status);
    });
    if (baseItems.length <= WORKLOAD_OVERVIEW_THRESHOLD) return "";
    const model = workloadOverviewModel(baseItems);
    const label = `Browse ${model.plural}`;
    return `<button type="button" class="table-text-action" data-action="show-workload-overview">${label}</button>`;
  }

  function bindWorkloadViewport() {
    const viewport = document.getElementById("workload-table-scroll");
    if (!viewport || viewport.dataset.bound === "true") return;
    viewport.dataset.bound = "true";
    viewport.scrollTop = state.workloadWindowScrollTop;
    viewport.addEventListener("scroll", () => {
      closeConnectionMenus();
      state.workloadWindowScrollTop = viewport.scrollTop;
      state.workloadScrollActive = true;
      if (state.workloadScrollIdleTimer) clearTimeout(state.workloadScrollIdleTimer);
      state.workloadScrollIdleTimer = setTimeout(() => {
        state.workloadScrollIdleTimer = 0;
        state.workloadScrollActive = false;
        flushPendingWorkloadView();
      }, 140);
      if (state.workloadWindowFrame) return;
      state.workloadWindowFrame = requestAnimationFrame(() => {
        state.workloadWindowFrame = 0;
        updateWorkloadWindow();
      });
    }, { passive: true });
    updateWorkloadWindow(true);
  }

  function updateWorkloadWindow(force = false) {
    if (workloadActionMenuOpen()) {
      state.workloadViewPending = true;
      return;
    }
    const viewport = document.getElementById("workload-table-scroll");
    const table = viewport?.querySelector(".workload-table");
    const body = table?.tBodies?.[0];
    if (!viewport || !table || !body) return;
    const items = state.workloadViewItems;
    const rowHeight = workloadRowHeight();
    const viewportHeight = Math.max(rowHeight, viewport.clientHeight - table.tHead.offsetHeight);
    const visibleCount = Math.ceil(viewportHeight / rowHeight);
    const firstVisible = Math.min(
      Math.floor(viewport.scrollTop / rowHeight),
      Math.max(0, items.length - visibleCount),
    );
    const visibleEnd = Math.min(items.length, firstVisible + visibleCount);
    const range = document.getElementById("workload-result-range");
    if (range) range.textContent = workloadResultRange(firstVisible, visibleEnd, items.length);
    const currentStart = Number(body.dataset.windowStart);
    const currentEnd = Number(body.dataset.windowEnd);
    const sameWindowModel = body.dataset.windowVersion === String(state.workloadViewVersion)
      && body.dataset.rowHeight === String(rowHeight);
    if (!force && sameWindowModel && firstVisible >= currentStart && visibleEnd <= currentEnd) return;
    const start = Math.max(0, firstVisible - WORKLOAD_OVERSCAN);
    const end = Math.min(items.length, firstVisible + visibleCount + WORKLOAD_OVERSCAN);
    const signature = `${state.workloadViewVersion}:${start}:${end}:${rowHeight}`;
    if (!force && body.dataset.window === signature) return;
    body.dataset.window = signature;
    body.dataset.windowStart = String(start);
    body.dataset.windowEnd = String(end);
    body.dataset.windowVersion = String(state.workloadViewVersion);
    body.dataset.rowHeight = String(rowHeight);
    body.innerHTML = workloadWindowRows(items, start, end);
    table.setAttribute("aria-rowcount", String(items.length + 1));
    const total = document.getElementById("workload-result-total");
    const actions = document.getElementById("workload-result-actions");
    if (total) total.textContent = workloadResultTotal(items.length);
    if (actions) actions.innerHTML = workloadResultActions();
  }

  function renderTopology(params) {
    const renderID = ++state.topologyRenderID;
    const request = {
      connection_id: params.get("connection_id") || "",
      project: params.get("project") || "",
      focus: params.get("focus") || "",
    };
    if (!request.connection_id || !request.project) {
      navigate("/workloads");
      return;
    }
    const zoomKey = `${request.connection_id}|${request.project}`;
    if (state.topologyZoomKey !== zoomKey) {
      state.topologyZoomKey = zoomKey;
      state.topologyZoom = 1;
    }
    drawTopologyPage(request);
    hydrateTopology(request, renderID);
  }

  function drawTopologyPage(request, loaded = false) {
    const connection = state.connections.find(item => item.id === request.connection_id);
    const model = dockerTopologyModel(request);
    const connectionLabel = connection?.name || request.connection_id;
    const managed = canManageDockerConnection(request.connection_id);
    const activityRequest = topologyActivityRequest(request, model);
    shell(`<section class="page topology-page ${request.focus ? "topology-page-focused" : ""}">
      <header class="page-header topology-header">
        <div>
          <button class="btn ghost small activity-back" data-action="back-workloads">← Workloads</button>
          <h1 class="page-title activity-title">${html(request.focus || request.project)}</h1>
          <div class="activity-meta"><button type="button" class="activity-meta-link" data-action="filter-workloads-from-topology" data-connection="${html(request.connection_id)}" aria-label="Show workloads from ${html(connectionLabel)}">${html(connectionLabel)}</button>${request.focus ? `<span>${html(request.project)}</span>` : ""}<span>Docker Compose</span><span>${managed ? "Manage containers" : "View only"}</span></div>
        </div>
        <div class="topology-header-actions">
          ${request.focus ? `<button class="btn ghost" data-action="show-full-topology" data-connection="${html(request.connection_id)}" data-project="${html(request.project)}">Full project</button>` : ""}
          ${!request.focus && managed ? `<button class="btn" data-action="restart-compose-project" data-connection="${html(request.connection_id)}" data-project="${html(request.project)}">Restart project</button>` : ""}
          <button id="refresh-topology" class="btn" data-action="refresh-topology" data-connection="${html(request.connection_id)}" data-project="${html(request.project)}" data-focus="${html(request.focus)}" ${state.topologyRefreshing ? "disabled" : ""}>${state.topologyRefreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
      </header>
      ${request.focus ? workloadViewTabs(activityRequest, "topology", model?.workloads.find(item => item.name === request.focus)) : ""}
      <div id="topology-content" aria-busy="${state.topologyRefreshing}">${topologyContent(model, request, loaded)}</div>
    </section>`, "workloads");
    bindTopologyCanvas();
  }

  async function hydrateTopology(request, renderID) {
    const hasProject = state.workloads.some(item => item.connection_id === request.connection_id && composeProjectName(item) === request.project);
    const pending = [];
    if (!state.connections.length) pending.push(loadConnections());
    if (!hasProject) pending.push(loadWorkloads(request.connection_id));
    if (!pending.length) return;
    try {
      await Promise.all(pending);
    } catch (error) {
      if (!(error instanceof AuthenticationRequired)) toast(`Topology: ${error.message}`, "error");
      return;
    }
    if (renderID !== state.topologyRenderID || state.route?.path !== "/topology") return;
    drawTopologyPage(request, true);
  }

  async function refreshTopology(request) {
    if (state.topologyRefreshing) return;
    state.topologyRefreshing = true;
    const button = document.getElementById("refresh-topology");
    const content = document.getElementById("topology-content");
    if (button) {
      button.disabled = true;
      button.textContent = "Refreshing…";
    }
    if (content) content.setAttribute("aria-busy", "true");
    try {
      await loadWorkloads(request.connection_id);
      if (state.route?.path !== "/topology") return;
      stopTopologyLayout();
      if (content) {
        content.innerHTML = topologyContent(dockerTopologyModel(request), request, true);
        content.setAttribute("aria-busy", "false");
      }
      bindTopologyCanvas();
    } catch (error) {
      if (!(error instanceof AuthenticationRequired)) toast(`Topology: ${error.message}`, "error");
    } finally {
      state.topologyRefreshing = false;
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.textContent = "Refresh";
      }
      if (content && document.body.contains(content)) content.setAttribute("aria-busy", "false");
    }
  }

  function composeProjectName(workload) {
    return workload?.docker?.compose_project || workload?.labels?.["com.docker.compose.project"] || "";
  }

  function composeServiceName(workload) {
    return workload.docker?.compose_service || workload.labels?.["com.docker.compose.service"] || workload.name;
  }

  function topologyActivityRequest(request, model) {
    const workload = model?.workloads.find(item => item.name === request.focus);
    return {
      connection_id: request.connection_id,
      kind: workload?.kind || "Container",
      namespace: workload?.namespace || "",
      name: request.focus,
      pod: "",
      container: "",
      topology_project: request.project,
    };
  }

  function dockerTopologyModel(request) {
    const workloads = state.workloads
      .filter(item => item.connection_id === request.connection_id && composeProjectName(item) === request.project)
      .sort((a, b) => composeServiceName(a).localeCompare(composeServiceName(b)) || String(a.name).localeCompare(String(b.name)));
    if (!workloads.length) return null;

    const servicesByName = new Map();
    const networksByName = new Map();
    const storageByKey = new Map();
    for (const workload of workloads) {
      const docker = workload.docker || {};
      const serviceName = composeServiceName(workload);
      let service = servicesByName.get(serviceName);
      if (!service) {
        service = { name: serviceName, workloads: [], images: new Set(), ports: new Map(), dependencies: new Set(), networkKeys: new Set(), storageKeys: new Set() };
        servicesByName.set(serviceName, service);
      }
      service.workloads.push(workload);
      for (const image of workload.images || []) if (image) service.images.add(image);
      for (const dependency of docker.depends_on || []) if (dependency) service.dependencies.add(dependency);
      for (const port of docker.ports || []) {
        const key = [port.container_port, port.protocol, port.host_ip, port.host_port].join("|");
        service.ports.set(key, port);
      }
      for (const network of docker.networks || []) {
        if (!network.name) continue;
        let resource = networksByName.get(network.name);
        if (!resource) {
          resource = { key: network.name, name: network.name, gateway: network.gateway || "", networkID: network.network_id || "", attachments: [] };
          networksByName.set(network.name, resource);
        }
        if (!resource.gateway && network.gateway) resource.gateway = network.gateway;
        if (!resource.networkID && network.network_id) resource.networkID = network.network_id;
        resource.attachments.push({
          service: serviceName,
          container: workload.name,
          containerNumber: docker.compose_container_number || "",
          address: network.ip_address || network.global_ipv6_address || "",
          aliases: network.aliases || [],
        });
        service.networkKeys.add(network.name);
      }
      for (const mount of docker.mounts || []) {
        const kind = mount.type || "mount";
        const identity = kind === "volume" ? (mount.name || mount.source || mount.destination) : (mount.source || mount.destination);
        const key = `${kind}:${identity}`;
        let resource = storageByKey.get(key);
        if (!resource) {
          resource = { key, kind, name: identity, source: mount.source || "", driver: mount.driver || "", attachments: [] };
          storageByKey.set(key, resource);
        }
        resource.attachments.push({
          service: serviceName,
          container: workload.name,
          containerNumber: docker.compose_container_number || "",
          destination: mount.destination || "",
          readOnly: Boolean(mount.read_only),
        });
        service.storageKeys.add(key);
      }
    }

    const services = [...servicesByName.values()].sort((a, b) => a.name.localeCompare(b.name));
    const networks = [...networksByName.values()].sort((a, b) => a.name.localeCompare(b.name));
    const storage = [...storageByKey.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    const networkIDs = new Map(networks.map((item, index) => [item.key, `topology-network-${index}`]));
    const storageIDs = new Map(storage.map((item, index) => [item.key, `topology-storage-${index}`]));
    const serviceIDs = new Map(services.map((item, index) => [item.name, `topology-service-${index}`]));
    services.forEach((service, index) => {
      service.nodeID = `topology-service-${index}`;
      service.targetIDs = [
        ...[...service.networkKeys].map(key => networkIDs.get(key)),
        ...[...service.storageKeys].map(key => storageIDs.get(key)),
      ].filter(Boolean);
      service.dependencyIDs = [...service.dependencies].map(name => serviceIDs.get(name)).filter(Boolean);
    });
    networks.forEach((item, index) => { item.nodeID = `topology-network-${index}`; });
    storage.forEach((item, index) => { item.nodeID = `topology-storage-${index}`; });

    const first = workloads[0].docker || {};
    return {
      project: request.project,
      connectionID: workloads[0].connection_id,
      connection: workloads[0].connection,
      workingDir: first.compose_working_dir || workloads[0].labels?.["com.docker.compose.project.working_dir"] || "",
      configFiles: first.compose_config_files || workloads[0].labels?.["com.docker.compose.project.config_files"] || "",
      composeVersion: first.compose_version || workloads[0].labels?.["com.docker.compose.version"] || "",
      services, networks, storage, workloads,
    };
  }

  function topologyContent(model, request, loaded = false) {
    if (!model) {
      if (loaded) return emptyState("Compose project not found", `${request.project} is no longer present on this Docker connection.`, "Workloads", "back-workloads");
      return `<div class="workload-discovery" role="status"><div class="discovery-track" aria-hidden="true"><span></span></div><strong>Loading topology</strong></div>`;
    }
    const focusedWorkload = request.focus ? model.workloads.find(item => item.name === request.focus) : null;
    const focusedService = focusedWorkload
      ? model.services.find(service => service.workloads.some(item => item.name === focusedWorkload.name))
      : null;
    if (focusedWorkload && focusedService) return focusedTopologyContent(model, focusedWorkload, focusedService);
    const resources = model.networks.length + model.storage.length;
    return `${topologyControls()}<div class="topology-summary" aria-label="Topology summary">
      <span><strong>${model.services.length}</strong> service${model.services.length === 1 ? "" : "s"}</span>
      <span><strong>${model.workloads.length}</strong> container${model.workloads.length === 1 ? "" : "s"}</span>
      <span><strong>${model.networks.length}</strong> network${model.networks.length === 1 ? "" : "s"}</span>
      <span><strong>${model.storage.length}</strong> storage source${model.storage.length === 1 ? "" : "s"}</span>
    </div>
    <div id="topology-viewport" class="topology-viewport" tabindex="0" aria-label="Topology canvas. Use Control or Command with the mouse wheel to zoom.">
    <div id="topology-world" class="topology-world"><div class="topology-map">
      <svg class="topology-edge-layer" aria-hidden="true"></svg>
      <section class="topology-column topology-project-column" aria-labelledby="topology-project-label">
        <h2 id="topology-project-label" class="topology-column-label">Project</h2>
        ${topologyProjectNode(model, resources)}
      </section>
      <section class="topology-column topology-service-column" aria-labelledby="topology-service-label">
        <h2 id="topology-service-label" class="topology-column-label">Services</h2>
        <div class="topology-node-list">${model.services.map(service => topologyServiceNode(service)).join("")}</div>
      </section>
      <section class="topology-column topology-resource-column" aria-labelledby="topology-resource-label">
        <h2 id="topology-resource-label" class="topology-column-label">Runtime resources</h2>
        ${model.networks.length ? `<div class="topology-resource-group"><h3>Networks</h3><div class="topology-node-list">${model.networks.map(network => topologyNetworkNode(network, model.project)).join("")}</div></div>` : ""}
        ${model.storage.length ? `<div class="topology-resource-group"><h3>Storage and host paths</h3><div class="topology-node-list">${model.storage.map(item => topologyStorageNode(item)).join("")}</div></div>` : ""}
        ${resources ? "" : `<div class="topology-resource-empty">No networks or mounts reported.</div>`}
      </section>
    </div></div></div>`;
  }

  function topologyControls() {
    return `<div class="topology-controls" aria-label="Topology controls">
      <button class="btn small" data-action="toggle-all-topology-nodes" aria-pressed="false">Expand all</button>
      <div class="topology-zoom-controls" aria-label="Canvas zoom">
        <button class="btn small icon-button" data-action="zoom-topology" data-zoom="-0.1" aria-label="Zoom out" title="Zoom out (−)">−</button>
        <button id="topology-zoom-level" class="btn small topology-zoom-level" data-action="reset-topology-zoom" aria-label="Reset zoom to 100%" title="Reset zoom (0)">${Math.round(state.topologyZoom * 100)}%</button>
        <button class="btn small icon-button" data-action="zoom-topology" data-zoom="0.1" aria-label="Zoom in" title="Zoom in (+)">+</button>
      </div>
    </div>`;
  }

  function focusedTopologyContent(model, workload, service) {
    const networks = model.networks
      .filter(item => service.networkKeys.has(item.key))
      .map(item => ({ ...item, attachments: item.attachments.filter(attachment => attachment.container === workload.name) }));
    const storage = model.storage
      .filter(item => service.storageKeys.has(item.key))
      .map(item => ({ ...item, attachments: item.attachments.filter(attachment => attachment.container === workload.name) }));
    const dependencyNames = [...service.dependencies].sort();
    const dependencies = dependencyNames.map((name, index) => ({
      name,
      nodeID: `topology-focus-dependency-${index}`,
      service: model.services.find(item => item.name === name),
    }));
    const targetIDs = [...networks, ...storage].map(item => item.nodeID);
    const resources = networks.length + storage.length;
    return `${topologyControls()}<div class="topology-summary" aria-label="Focused topology summary">
      <span><strong>1</strong> selected container</span>
      <span><strong>${dependencies.length}</strong> dependenc${dependencies.length === 1 ? "y" : "ies"}</span>
      <span><strong>${networks.length}</strong> network${networks.length === 1 ? "" : "s"}</span>
      <span><strong>${storage.length}</strong> storage source${storage.length === 1 ? "" : "s"}</span>
    </div>
    <div id="topology-viewport" class="topology-viewport" tabindex="0" aria-label="Topology canvas. Use Control or Command with the mouse wheel to zoom.">
    <div id="topology-world" class="topology-world"><div class="topology-map topology-map-focused" data-focus-container="${html(workload.name)}">
      <svg class="topology-edge-layer" aria-hidden="true"></svg>
      <section class="topology-column topology-focus-context-column" aria-labelledby="topology-context-label">
        <h2 id="topology-context-label" class="topology-column-label">Compose context</h2>
        <div class="topology-node-list">
          ${topologyProjectNode(model, model.networks.length + model.storage.length)}
          ${dependencies.map(item => topologyDependencyNode(item)).join("")}
        </div>
      </section>
      <section class="topology-column topology-focus-column" aria-labelledby="topology-focus-label">
        <h2 id="topology-focus-label" class="topology-column-label">Selected container</h2>
        ${topologyFocusNode(workload, service, targetIDs, dependencies.map(item => item.nodeID))}
      </section>
      <section class="topology-column topology-focus-resource-column" aria-labelledby="topology-connected-label">
        <h2 id="topology-connected-label" class="topology-column-label">Connected resources</h2>
        ${networks.length ? `<div class="topology-resource-group"><h3>Networks</h3><div class="topology-node-list">${networks.map(network => topologyNetworkNode(network, model.project)).join("")}</div></div>` : ""}
        ${storage.length ? `<div class="topology-resource-group"><h3>Storage and host paths</h3><div class="topology-node-list">${storage.map(item => topologyStorageNode(item)).join("")}</div></div>` : ""}
        ${resources ? "" : `<div class="topology-resource-empty">No networks or mounts reported.</div>`}
      </section>
    </div></div></div>`;
  }

  function topologyDependencyNode(item) {
    const workloads = item.service?.workloads || [];
    const workload = workloads.length === 1 ? workloads[0] : null;
    const good = workloads.filter(workload => statusBucket(workload) === "good").length;
    const bucket = workloads.some(workload => statusBucket(workload) === "bad")
      ? "bad"
      : workloads.some(workload => statusBucket(workload) === "warn")
        ? "warn"
        : workloads.length && good === workloads.length ? "good" : "other";
    return `<article id="${html(item.nodeID)}" class="topology-node topology-related-node" tabindex="0" data-topology-node data-topology-role="dependency" data-topology-label="${html(item.name)}" data-topology-connection="${html(workload?.connection_id || "")}" data-topology-project="${html(workload ? composeProjectName(workload) : "")}" data-topology-focus="${html(workload?.name || "")}" data-topology-openable="true" aria-label="${html(item.name)} service. Double-click to open when one container is available. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">S</span><div><strong>${html(item.name)}</strong><small>${workloads.length ? `${workloads.length} container${workloads.length === 1 ? "" : "s"}` : "Not observed"}</small></div>${workloads.length ? `<span class="topology-state ${bucket}">${good}/${workloads.length}</span>` : ""}</div>
    </article>`;
  }

  function topologyNodeToggle(label, expanded = false) {
    return `<button type="button" class="topology-node-toggle" data-action="toggle-topology-node" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${html(label)} details"><span aria-hidden="true"></span></button>`;
  }

  function topologyNodeDetails(content, expanded = false) {
    return `<div class="topology-node-details" ${expanded ? "" : "hidden"}>${content}</div>`;
  }

  function topologyFocusNode(workload, service, targetIDs, dependencyIDs) {
    const image = workload.images?.[0] || "";
    const ports = [...new Set([...service.ports.values()].map(formatDockerPort))];
    const activityRequest = encodeURIComponent(JSON.stringify({
      connection_id: workload.connection_id,
      kind: workload.kind,
      namespace: workload.namespace || "",
      name: workload.name,
      pod: "",
      container: "",
      topology_project: composeProjectName(workload),
    }));
    return `<article id="topology-focus" class="topology-node topology-focus-node" tabindex="0" data-topology-node data-topology-role="focus" data-topology-label="${html(workload.name)}" data-topology-connection="${html(workload.connection_id)}" data-topology-project="${html(composeProjectName(workload))}" data-topology-container="${html(workload.uid || "")}" data-topology-request="${activityRequest}" data-topology-openable="true" data-topology-targets="${html(targetIDs.join(" "))}" data-topology-dependencies="${html(dependencyIDs.join(" "))}" aria-label="${html(workload.name)} container. Double-click to open logs. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">C</span><div><strong>${html(workload.name)}</strong><small>${html(service.name)}</small></div><span class="status ${statusBucket(workload)}">${html(workload.state || "Unknown")}</span>${topologyNodeToggle(workload.name, true)}</div>
      ${topologyNodeDetails(`${image ? `<div class="topology-image" title="${html(image)}">${html(image)}</div>` : ""}${ports.length ? `<div class="topology-inline-facts"><strong>Ports</strong>${ports.map(port => `<code>${html(port)}</code>`).join("")}</div>` : ""}`, true)}
    </article>`;
  }

  function topologyProjectNode(model, resourceCount) {
    const focused = Boolean(routeInfo().params.get("focus"));
    const facts = [
      model.configFiles ? `<div><dt>Compose file</dt><dd title="${html(model.configFiles)}">${html(model.configFiles)}</dd></div>` : "",
      model.workingDir ? `<div><dt>Working directory</dt><dd title="${html(model.workingDir)}">${html(model.workingDir)}</dd></div>` : "",
      model.composeVersion ? `<div><dt>Compose</dt><dd>v${html(model.composeVersion)}</dd></div>` : "",
    ].join("");
    const openHint = focused ? "Double-click to open the full project view." : "Double-click to expand all connected nodes.";
    return `<article id="topology-project" class="topology-node topology-project-node" tabindex="0" data-topology-node data-topology-role="project" data-topology-label="${html(model.project)}" data-topology-connection="${html(model.connectionID)}" data-topology-project="${html(model.project)}" data-topology-openable="true" aria-label="${html(model.project)} project. ${openHint} Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">P</span><div><strong>${html(model.project)}</strong><small>${model.services.length} services · ${resourceCount} resources</small></div>${topologyNodeToggle(model.project)}</div>
      ${topologyNodeDetails(facts ? `<dl class="topology-project-facts">${facts}</dl>` : "")}
    </article>`;
  }

  function topologyServiceNode(service) {
    const workloads = [...service.workloads].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const workload = workloads.length === 1 ? workloads[0] : null;
    const good = workloads.filter(item => statusBucket(item) === "good").length;
    const bucket = workloads.some(item => statusBucket(item) === "bad")
      ? "bad"
      : workloads.some(item => statusBucket(item) === "warn")
        ? "warn"
        : good === workloads.length ? "good" : "other";
    const images = [...service.images];
    const ports = [...new Set([...service.ports.values()].map(formatDockerPort))];
    const dependencies = [...service.dependencies].sort();
    return `<article id="${html(service.nodeID)}" class="topology-node topology-service-node" tabindex="0" data-topology-node data-topology-role="service" data-topology-label="${html(service.name)}" data-topology-connection="${html(workloads[0]?.connection_id || "")}" data-topology-project="${html(workloads[0] ? composeProjectName(workloads[0]) : "")}" data-topology-focus="${html(workload?.name || "")}" data-topology-openable="true" data-topology-targets="${html(service.targetIDs.join(" "))}" data-topology-dependencies="${html(service.dependencyIDs.join(" "))}" aria-label="${html(service.name)} service with ${workloads.length} container${workloads.length === 1 ? "" : "s"}. Double-click to ${workload ? "open its connected view" : "show its containers"}. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">S</span><div><strong>${html(service.name)}</strong><small>${workloads.length} container${workloads.length === 1 ? "" : "s"}</small></div><span class="topology-state ${bucket}">${good}/${workloads.length}</span>${topologyNodeToggle(service.name)}</div>
      ${topologyNodeDetails(`${images.length ? `<div class="topology-image" title="${html(images.join(", "))}">${html(images.join(", "))}</div>` : ""}
      <div class="topology-container-list">${workloads.map(workload => {
        const encoded = encodeURIComponent(JSON.stringify({ connection_id: workload.connection_id, kind: workload.kind, namespace: workload.namespace || "", name: workload.name, topology_project: composeProjectName(workload) }));
        return `<button type="button" class="topology-container-link" data-workload="${encoded}"><span class="topology-container-state ${statusBucket(workload)}" aria-hidden="true"></span><span>${html(workload.name)}</span><span>${html(workload.state || "Unknown")}</span><span aria-hidden="true">→</span></button>`;
      }).join("")}</div>
      ${ports.length ? `<div class="topology-inline-facts"><strong>Ports</strong>${ports.map(port => `<code>${html(port)}</code>`).join("")}</div>` : ""}
      ${dependencies.length ? `<div class="topology-dependencies"><strong>Depends on</strong><span>${dependencies.map(html).join(" · ")}</span></div>` : ""}`)}
    </article>`;
  }

  function topologyNetworkNode(network, project) {
    const displayName = network.name.startsWith(`${project}_`) ? network.name.slice(project.length + 1) : network.name;
    return `<article id="${html(network.nodeID)}" class="topology-node topology-resource-node" tabindex="0" data-topology-node data-topology-role="network" data-topology-label="${html(displayName)}" data-topology-openable="true" aria-label="${html(displayName)} network with ${network.attachments.length} attachment${network.attachments.length === 1 ? "" : "s"}. Double-click to show attachments. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">N</span><div><strong>${html(displayName)}</strong><small>${html(network.name)} · ${network.attachments.length} attachment${network.attachments.length === 1 ? "" : "s"}</small></div>${topologyNodeToggle(displayName)}</div>
      ${topologyNodeDetails(`${network.gateway ? `<div class="topology-resource-path"><span>Gateway</span><code title="${html(network.networkID)}">${html(network.gateway)}</code></div>` : ""}
      <div class="topology-attachment-list">${network.attachments.sort(compareTopologyAttachments).map(item => `<div><span title="${html(item.container)}">${html(topologyAttachmentLabel(item))}</span><code title="${item.aliases.length ? `Aliases: ${html(item.aliases.join(", "))}` : ""}">${html(item.address || "attached")}</code></div>`).join("")}</div>`)}
    </article>`;
  }

  function topologyStorageNode(item) {
    const typeLabel = item.kind === "bind" ? "Host path" : item.kind === "volume" ? "Named volume" : item.kind;
    const source = item.kind === "volume" ? item.name : item.source || item.name;
    return `<article id="${html(item.nodeID)}" class="topology-node topology-resource-node" tabindex="0" data-topology-node data-topology-role="storage" data-topology-label="${html(source)}" data-topology-openable="true" aria-label="${html(source)} ${html(typeLabel.toLowerCase())} with ${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}. Double-click to show attachments. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">${item.kind === "bind" ? "H" : "V"}</span><div><strong title="${html(source)}">${html(source)}</strong><small>${html(typeLabel)} · ${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}</small></div>${topologyNodeToggle(source)}</div>
      ${topologyNodeDetails(`${item.kind === "volume" && item.source && item.source !== item.name ? `<div class="topology-resource-path"><span>Docker host path</span><code title="${html(item.source)}">${html(item.source)}</code></div>` : ""}
      <div class="topology-attachment-list">${item.attachments.sort(compareTopologyAttachments).map(attachment => `<div><span title="${html(attachment.container)}">${html(topologyAttachmentLabel(attachment))}</span><code>${html(attachment.destination)}${attachment.readOnly ? " · read-only" : ""}</code></div>`).join("")}</div>`)}
    </article>`;
  }

  function topologyAttachmentLabel(attachment) {
    return attachment.containerNumber ? `${attachment.service} #${attachment.containerNumber}` : attachment.service;
  }

  function compareTopologyAttachments(a, b) {
    return String(a.service).localeCompare(String(b.service))
      || Number(a.containerNumber || 0) - Number(b.containerNumber || 0)
      || String(a.container).localeCompare(String(b.container));
  }

  function formatDockerPort(port) {
    const protocol = port.protocol || "tcp";
    if (!port.host_port) return `${port.container_port}/${protocol}`;
    const host = !port.host_ip || port.host_ip === "0.0.0.0" || port.host_ip === "::" ? "" : `${port.host_ip}:`;
    return `${host}${port.host_port} → ${port.container_port}/${protocol}`;
  }

  function clampTopologyZoom(value) {
    return Math.min(1.6, Math.max(0.5, Math.round(value * 10) / 10));
  }

  function scheduleTopologyDraw() {
    if (state.topologyDrawFrame) cancelAnimationFrame(state.topologyDrawFrame);
    state.topologyDrawFrame = requestAnimationFrame(drawTopologyEdges);
  }

  function applyTopologyZoom(value) {
    const viewport = document.getElementById("topology-viewport");
    const world = document.getElementById("topology-world");
    const map = viewport?.querySelector(".topology-map");
    if (!viewport || !world || !map) return;
    state.topologyZoom = clampTopologyZoom(value);
    const naturalWidth = viewport.clientWidth;
    map.style.width = `${naturalWidth}px`;
    map.style.transform = `scale(${state.topologyZoom})`;
    world.style.width = `${naturalWidth * state.topologyZoom}px`;
    world.style.height = `${map.offsetHeight * state.topologyZoom}px`;
    const label = document.getElementById("topology-zoom-level");
    if (label) label.textContent = `${Math.round(state.topologyZoom * 100)}%`;
    scheduleTopologyDraw();
  }

  function updateTopologyExpandControl() {
    const toggles = [...document.querySelectorAll(".topology-node-toggle")];
    const allExpanded = toggles.length > 0 && toggles.every(button => button.getAttribute("aria-expanded") === "true");
    const button = document.querySelector('[data-action="toggle-all-topology-nodes"]');
    if (button) {
      button.textContent = allExpanded ? "Collapse all" : "Expand all";
      button.setAttribute("aria-pressed", String(allExpanded));
    }
  }

  function toggleTopologyNode(node, forceExpanded, deferLayout = false) {
    const button = node?.querySelector(":scope > .topology-node-heading .topology-node-toggle");
    const details = node?.querySelector(":scope > .topology-node-details");
    if (!node || !button || !details) return;
    const expanded = forceExpanded ?? button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${node.querySelector(":scope > .topology-node-heading strong")?.textContent || "node"} details`);
    details.hidden = !expanded;
    updateTopologyExpandControl();
    if (!deferLayout) requestAnimationFrame(() => applyTopologyZoom(state.topologyZoom));
  }

  function toggleAllTopologyNodes() {
    const nodes = [...document.querySelectorAll(".topology-node")].filter(node => node.querySelector(":scope > .topology-node-details"));
    const shouldExpand = nodes.some(node => node.querySelector(":scope > .topology-node-details")?.hidden);
    setAllTopologyNodes(shouldExpand);
  }

  function setAllTopologyNodes(expanded) {
    const nodes = [...document.querySelectorAll(".topology-node")].filter(node => node.querySelector(":scope > .topology-node-details"));
    nodes.forEach(node => toggleTopologyNode(node, expanded, true));
    updateTopologyExpandControl();
    requestAnimationFrame(() => applyTopologyZoom(state.topologyZoom));
  }

  function openTopologyNodeView(node) {
    if (!node) return;
    const role = node.dataset.topologyRole || "";
    const connection = node.dataset.topologyConnection || routeInfo().params.get("connection_id") || "";
    const project = node.dataset.topologyProject || routeInfo().params.get("project") || "";
    const focus = node.dataset.topologyFocus || "";
    if (role === "project") {
      if (routeInfo().params.get("focus")) {
        navigate(`/topology?${new URLSearchParams({ connection_id: connection, project }).toString()}`);
      } else {
        setAllTopologyNodes(true);
      }
      return;
    }
    if (role === "focus" && node.dataset.topologyRequest) {
      const request = JSON.parse(decodeURIComponent(node.dataset.topologyRequest));
      navigate(`/activity?${new URLSearchParams(request).toString()}`);
      return;
    }
    if (focus && connection && project) {
      navigate(`/topology?${new URLSearchParams({ connection_id: connection, project, focus }).toString()}`);
      return;
    }
    if (node.querySelector(":scope > .topology-node-details")) toggleTopologyNode(node, true);
  }

  function topologyContextIcon(name) {
    const paths = {
      logs: '<path d="M3.5 4.5 6.5 8l-3 3.5M8.5 11.5h4"/>',
      topology: '<circle cx="3.5" cy="8" r="1.5"/><circle cx="12.5" cy="4" r="1.5"/><circle cx="12.5" cy="12" r="1.5"/><path d="M5 8h2.2c1.5 0 1.8-4 3.8-4M7.2 8c1.5 0 1.8 4 3.8 4"/>',
      workloads: '<rect x="3" y="3.5" width="10" height="3" rx="1"/><rect x="3" y="9.5" width="10" height="3" rx="1"/><path d="M5.5 5h.01M5.5 11h.01"/>',
      connected: '<rect x="2.5" y="5.5" width="4" height="5" rx="1"/><rect x="9.5" y="2.5" width="4" height="4" rx="1"/><rect x="9.5" y="9.5" width="4" height="4" rx="1"/><path d="M6.5 8h1c1.2 0 1-3.5 2-3.5M7.5 8c1.2 0 1 3.5 2 3.5"/>',
      expand: '<path d="m5.5 2.5-3 3m0-3v3h3M10.5 13.5l3-3m0 3v-3h-3"/>',
      collapse: '<path d="m2.5 5.5 3-3m0 3v-3h-3M13.5 10.5l-3 3m0-3v3h3"/>',
      containers: '<rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><path d="M5 5h.01M5 11h.01"/>',
      attachments: '<path d="M6.4 9.6 4.8 11.2a2.1 2.1 0 0 1-3-3l2.5-2.5a2.1 2.1 0 0 1 3 0M9.6 6.4l1.6-1.6a2.1 2.1 0 0 1 3 3l-2.5 2.5a2.1 2.1 0 0 1-3 0M5.8 10.2l4.4-4.4"/>',
      copy: '<rect x="5.5" y="5.5" width="7" height="7" rx="1.3"/><path d="M10.5 5.5V4.2a1.7 1.7 0 0 0-1.7-1.7H4.2a1.7 1.7 0 0 0-1.7 1.7v4.6a1.7 1.7 0 0 0 1.7 1.7h1.3"/>',
      restart: '<path d="M12.8 5.4V2.7l-1.7 1.7A5.3 5.3 0 1 0 13 9.8"/><path d="M12.8 2.7h-2.7"/>',
      delete: '<path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6"/>',
    };
    return `<svg viewBox="0 0 16 16" aria-hidden="true">${paths[name] || paths.topology}</svg>`;
  }

  function topologyContextAction(action, label, values = {}, icon = "topology") {
    const attributes = Object.entries(values)
      .map(([key, value]) => ` data-${key}="${html(value)}"`)
      .join("");
    return `<button type="button" role="menuitem" data-action="${html(action)}"${attributes}><span class="topology-context-action-icon">${topologyContextIcon(icon)}</span><span>${html(label)}</span></button>`;
  }

  function closeTopologyContextMenu(restoreFocus = false) {
    const menu = document.getElementById("topology-context-menu");
    if (!menu) return;
    const owner = document.getElementById(menu.dataset.owner || "");
    owner?.classList.remove("topology-node-context-active");
    menu.remove();
    if (restoreFocus) owner?.focus();
  }

  function showTopologyContextMenu(node, clientX, clientY, focusMenu = false) {
    if (!node || state.route?.path !== "/topology") return;
    closeTopologyContextMenu();
    const role = node.dataset.topologyRole || "resource";
    const label = node.dataset.topologyLabel || node.querySelector(":scope > .topology-node-heading strong")?.textContent || "Resource";
    const connection = node.dataset.topologyConnection || routeInfo().params.get("connection_id") || "";
    const project = node.dataset.topologyProject || routeInfo().params.get("project") || "";
    const focus = node.dataset.topologyFocus || "";
    const containerID = node.dataset.topologyContainer || "";
    const managed = canManageDockerConnection(connection);
    const details = node.querySelector(":scope > .topology-node-details");
    const expanded = details ? !details.hidden : false;
    const actions = [];
    const typeLabels = {
      project: "Compose project",
      focus: "Container",
      service: "Service",
      dependency: "Service",
      network: "Network",
      storage: "Storage",
    };
    const typeLabel = typeLabels[role] || "Resource";
    const mark = node.querySelector(":scope > .topology-node-heading .topology-node-mark")?.textContent?.trim() || "•";

    if (role === "project") {
      if (routeInfo().params.get("focus")) {
        actions.push(topologyContextAction("open-topology-project", "Open project topology", { connection, project }, "topology"));
      } else {
        const hasCollapsed = [...document.querySelectorAll(".topology-node-details")].some(item => item.hidden);
        actions.push(topologyContextAction("set-all-topology-nodes", hasCollapsed ? "Expand all details" : "Collapse all details", { expanded: hasCollapsed }, hasCollapsed ? "expand" : "collapse"));
      }
      actions.push(topologyContextAction("filter-topology-node-workloads", "Show project workloads", { connection, search: project }, "workloads"));
      if (managed) actions.push(topologyContextAction("restart-compose-project", "Restart project", { connection, project }, "restart"));
    } else if (role === "focus") {
      actions.push(topologyContextAction("open-topology-logs", "Open logs", { request: node.dataset.topologyRequest || "" }, "logs"));
      actions.push(topologyContextAction("open-topology-project", "Open project topology", { connection, project }, "topology"));
      actions.push(topologyContextAction("filter-topology-node-workloads", "Show in workloads", { connection, search: label }, "workloads"));
      if (managed && containerID) {
        actions.push(`<div class="topology-context-separator" role="separator"></div>`);
        actions.push(topologyContextAction("restart-docker-container", "Restart container", { connection, container: containerID, name: label }, "restart"));
        actions.push(topologyContextAction("delete-docker-container", "Delete container", { connection, container: containerID, name: label }, "delete"));
      }
    } else if (role === "service" || role === "dependency") {
      if (focus) actions.push(topologyContextAction("open-topology-connected", "Open connected view", { connection, project, focus }, "connected"));
      if (details) actions.push(topologyContextAction("toggle-topology-context-node", expanded ? "Collapse details" : "Show containers", { node: node.id }, expanded ? "collapse" : "containers"));
      actions.push(topologyContextAction("filter-topology-node-workloads", "Show service workloads", { connection, search: label }, "workloads"));
    } else if (details) {
      actions.push(topologyContextAction("toggle-topology-context-node", expanded ? "Hide attachments" : "Show attached containers", { node: node.id }, expanded ? "collapse" : "attachments"));
    }

    actions.push(`<div class="topology-context-separator" role="separator"></div>`);
    actions.push(topologyContextAction("copy-topology-node-name", `Copy ${role === "project" ? "project name" : "name"}`, { value: label }, "copy"));
    document.body.insertAdjacentHTML("beforeend", `<div id="topology-context-menu" class="topology-context-menu" role="menu" aria-label="${html(label)} actions" data-owner="${html(node.id)}">
      <div class="topology-context-heading"><span class="topology-context-node-mark" aria-hidden="true">${html(mark)}</span><span><strong title="${html(label)}">${html(label)}</strong><small>${html(typeLabel)}</small></span></div>
      ${actions.join("")}
    </div>`);
    const menu = document.getElementById("topology-context-menu");
    if (!menu) return;
    node.classList.add("topology-node-context-active");
    const bounds = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    if (focusMenu) menu.querySelector('[role="menuitem"]')?.focus();
  }

  function bindTopologyCanvas() {
    const map = document.querySelector(".topology-map");
    const viewport = document.getElementById("topology-viewport");
    if (!map || !viewport) return;
    state.topologyObserver = new ResizeObserver(() => applyTopologyZoom(state.topologyZoom));
    state.topologyObserver.observe(map);
    state.topologyObserver.observe(viewport);
    const highlight = event => {
      const node = event.target.closest?.("[data-topology-node]");
      if (!node || !map.contains(node)) return;
      map.dataset.highlightNode = node.id;
      map.querySelectorAll(".topology-edge").forEach(edge => {
        edge.classList.toggle("active", edge.dataset.from === node.id || edge.dataset.to === node.id);
      });
    };
    const clearHighlight = event => {
      const node = event.target.closest?.("[data-topology-node]");
      if (node && event.relatedTarget && node.contains(event.relatedTarget)) return;
      delete map.dataset.highlightNode;
      map.querySelectorAll(".topology-edge.active").forEach(edge => edge.classList.remove("active"));
    };
    map.addEventListener("pointerover", highlight);
    map.addEventListener("pointerout", clearHighlight);
    map.addEventListener("focusin", highlight);
    map.addEventListener("focusout", clearHighlight);
    viewport.addEventListener("wheel", event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      applyTopologyZoom(state.topologyZoom + (event.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    viewport.addEventListener("keydown", event => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        applyTopologyZoom(state.topologyZoom + 0.1);
      } else if (event.key === "-") {
        event.preventDefault();
        applyTopologyZoom(state.topologyZoom - 0.1);
      } else if (event.key === "0") {
        event.preventDefault();
        applyTopologyZoom(1);
      }
    });
    updateTopologyExpandControl();
    requestAnimationFrame(() => applyTopologyZoom(state.topologyZoom));
  }

  function drawTopologyEdges() {
    state.topologyDrawFrame = 0;
    const map = document.querySelector(".topology-map");
    const svg = map?.querySelector(".topology-edge-layer");
    const root = document.getElementById("topology-project");
    if (!map || !svg || !root) return;
    const mapRect = map.getBoundingClientRect();
    const scale = state.topologyZoom || 1;
    const mapWidth = map.offsetWidth;
    const mapHeight = map.offsetHeight;
    svg.setAttribute("viewBox", `0 0 ${mapWidth} ${mapHeight}`);
    svg.setAttribute("width", mapWidth);
    svg.setAttribute("height", mapHeight);
    const pathFor = (from, to, kind) => {
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const startX = (fromRect.right - mapRect.left) / scale;
      const startY = (fromRect.top + fromRect.height / 2 - mapRect.top) / scale;
      const endX = (toRect.left - mapRect.left) / scale;
      const endY = (toRect.top + toRect.height / 2 - mapRect.top) / scale;
      const bend = Math.max(34, Math.abs(endX - startX) * .48);
      return `<path class="topology-edge ${kind}" data-from="${html(from.id)}" data-to="${html(to.id)}" d="M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${(startX + bend).toFixed(1)} ${startY.toFixed(1)}, ${(endX - bend).toFixed(1)} ${endY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}"></path>`;
    };
    const dependencyPathFor = (from, to) => {
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const startX = (fromRect.right - mapRect.left) / scale;
      const startY = (fromRect.top + fromRect.height / 2 - mapRect.top) / scale;
      const endX = (toRect.right - mapRect.left) / scale;
      const endY = (toRect.top + toRect.height / 2 - mapRect.top) / scale;
      const sideX = Math.max(startX, endX) + 20;
      return `<path class="topology-edge dependency-edge" data-from="${html(from.id)}" data-to="${html(to.id)}" d="M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${sideX.toFixed(1)} ${startY.toFixed(1)}, ${sideX.toFixed(1)} ${endY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}"></path>`;
    };
    const paths = [];
    const focus = document.getElementById("topology-focus");
    if (focus) {
      paths.push(pathFor(root, focus, "project-edge"));
      for (const dependency of document.querySelectorAll('[data-topology-role="dependency"]')) {
        paths.push(pathFor(dependency, focus, "dependency-edge"));
      }
      for (const targetID of String(focus.dataset.topologyTargets || "").split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(targetID);
        if (target) paths.push(pathFor(focus, target, "resource-edge"));
      }
      svg.innerHTML = paths.join("");
      return;
    }
    document.querySelectorAll('[data-topology-role="service"]').forEach(service => {
      paths.push(pathFor(root, service, "project-edge"));
      for (const targetID of String(service.dataset.topologyTargets || "").split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(targetID);
        if (target) paths.push(pathFor(service, target, "resource-edge"));
      }
      for (const dependencyID of String(service.dataset.topologyDependencies || "").split(/\s+/).filter(Boolean)) {
        const dependency = document.getElementById(dependencyID);
        if (dependency) paths.push(dependencyPathFor(service, dependency));
      }
    });
    svg.innerHTML = paths.join("");
  }

  function stopTopologyLayout() {
    state.topologyObserver?.disconnect();
    state.topologyObserver = null;
    if (state.topologyDrawFrame) cancelAnimationFrame(state.topologyDrawFrame);
    state.topologyDrawFrame = 0;
  }

  function metricCPUCell(metric) {
    return `<div class="metric-cell">${html(formatCPU(metric))}</div><div class="cell-subtitle">${metric ? html(formatTime(metric.timestamp)) : html(workloadMetricPlaceholder())}</div>`;
  }

  function metricMemoryCell(metric) {
    return `<div class="metric-cell">${html(formatMemory(metric))}</div><div class="cell-subtitle">${metric?.memory_limit_bytes ? "usage / limit" : metric ? "working set" : html(workloadMetricPlaceholder())}</div>`;
  }

  function workloadMetricPlaceholder() {
    if (state.workloadMetricsLoading) return "Loading…";
    if (state.workloadMetricsDeferred) return "Not loaded";
    if (state.workloadMetricsLoaded) return "No sample";
    return "After discovery";
  }

  function metricKey(item) {
    return [item.connection_id || "", item.namespace || "", item.kind || "", item.name || ""].join("|");
  }

  function formatCPU(metric) {
    if (!metric || metric.error) return "—";
    if (metric.cpu_percent !== undefined && metric.cpu_percent !== null) return `${Number(metric.cpu_percent).toFixed(metric.cpu_percent >= 10 ? 1 : 2)}%`;
    const millicores = Number(metric.cpu_cores || 0) * 1000;
    return millicores >= 1000 ? `${(millicores / 1000).toFixed(2)} cores` : `${millicores.toFixed(millicores >= 10 ? 0 : 1)}m`;
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let current = bytes;
    let index = 0;
    while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1; }
    return `${current.toFixed(current >= 100 || index === 0 ? 0 : current >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function formatMemory(metric) {
    if (!metric || metric.error) return "—";
    const usage = formatBytes(metric.memory_bytes);
    return metric.memory_limit_bytes ? `${usage} / ${formatBytes(metric.memory_limit_bytes)}` : usage;
  }

  function statusBucket(item) {
    const value = `${item.severity || ""} ${item.state || ""}`.toLowerCase();
    if (/error|failed|failure|degraded|unhealthy|crash|terminated/.test(value)) return "bad";
    if (/warning|pending|restart|progress|unknown|notready|not ready/.test(value)) return "warn";
    if (/healthy|ready|running|available|active|created/.test(value)) return "good";
    return "other";
  }

  function emptyState(title, copy, button, action) {
    return `<div class="empty"><div class="empty-inner"><div class="empty-symbol" aria-hidden="true">◇</div><h2>${html(title)}</h2><p>${html(copy)}</p>${button ? `<button class="btn primary" data-action="${html(action)}">${html(button)}</button>` : ""}</div></div>`;
  }

  function bindWorkloadControls() {
    bindWorkloadViewport();
    const search = document.getElementById("workload-search");
    if (search) search.addEventListener("input", debounce(() => {
      state.filters.search = search.value;
      state.workloadBrowseMode = "auto";
      updateWorkloadView(true);
    }, 120));
    [["connection-filter", "connection"], ["namespace-filter", "namespace"], ["status-filter", "status"]].forEach(([id, key]) => {
      document.getElementById(id)?.addEventListener("change", event => {
        state.filters[key] = ["connection", "namespace"].includes(key)
          ? filterInputValues(event.target.value)
          : event.target.value;
        state.workloadBrowseMode = "auto";
        updateWorkloadView(true);
      });
    });
    document.querySelectorAll(".workload-filter-menu [data-log-menu-search]").forEach(input => {
      input.addEventListener("input", event => filterLogMenuOptions(event.target.closest(".log-menu-field"), event.target.value));
    });
  }

  function syncWorkloadFilterControls() {
    const search = document.getElementById("workload-search");
    if (search) search.value = state.filters.search;
    updateWorkloadFilterMenu("connection", state.filters.connection);
    updateWorkloadFilterMenu("namespace", state.filters.namespace);
    updateWorkloadFilterMenu("status", state.filters.status);
  }

  function updateWorkloadFilterMenu(filter, value) {
    const field = document.querySelector(`[data-workload-filter="${filter}"]`);
    if (!field) return;
    const multiple = field.dataset.multiple === "true";
    const input = field.querySelector("input[type=hidden]");
    const options = [...field.querySelectorAll(".log-menu-option")];
    const values = filterValues(value);
    const selected = options.filter(option => option.dataset.value && values.includes(option.dataset.value));
    const allOption = options.find(option => !option.dataset.value) || options[0];
    const label = multiple && selected.length > 1
      ? `${selected.length} ${filter === "connection" ? "connections" : "namespaces"}`
      : selected[0]?.dataset.label || allOption?.dataset.label || allOption?.textContent?.trim() || "";
    const fullLabel = selected.length ? selected.map(option => option.dataset.label).join(", ") : allOption?.dataset.label || "";
    if (input) input.value = multiple ? JSON.stringify(values) : values[0] || "";
    field.querySelector("[data-log-menu-label]")?.replaceChildren(document.createTextNode(label));
    const trigger = field.querySelector(".log-menu-trigger");
    if (trigger) {
      const filterLabel = filter === "connection" ? "Connection" : filter === "namespace" ? "Namespace" : "State";
      trigger.setAttribute("aria-label", `${filterLabel}: ${fullLabel}`);
      trigger.title = fullLabel;
    }
    for (const option of options) {
      const isSelected = option.dataset.value ? values.includes(option.dataset.value) : values.length === 0;
      option.classList.toggle("selected", isSelected);
      option.setAttribute("aria-selected", String(isSelected));
    }
    updateWorkloadFilterDraftSummary(field);
  }

  function filterInputValues(value) {
    try {
      const parsed = JSON.parse(value);
      return filterValues(parsed);
    } catch {
      return filterValues(value);
    }
  }

  function updateWorkloadFilterDraftSummary(field) {
    const summary = field?.querySelector("[data-workload-selection-count]");
    if (!summary) return;
    const count = [...field.querySelectorAll(".log-menu-option.selected")].filter(option => option.dataset.value).length;
    summary.textContent = count ? `${count} selected` : "All";
  }

  function resetWorkloadFilterDraft(field) {
    if (!field || field.dataset.multiple !== "true") return;
    const values = filterInputValues(field.querySelector("input[type=hidden]")?.value || "[]");
    for (const option of field.querySelectorAll(".log-menu-option")) {
      const selected = option.dataset.value ? values.includes(option.dataset.value) : values.length === 0;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    }
    updateWorkloadFilterDraftSummary(field);
  }

  async function renderConnections() {
    loadingPage("connections", "Connections");
    await Promise.all([loadConnections(), state.settings ? Promise.resolve() : loadSettings()]);
    drawConnections();
  }

  function drawConnections() {
    const remoteAgents = remoteAgentsAvailable();
    const availableConnections = remoteAgents ? state.connections : state.connections.filter(item => item.mode !== "agent");
    const filter = !remoteAgents && state.connectionFilter === "agents" ? "all" : state.connectionFilter || "all";
    state.connectionFilter = filter;
    const filtered = availableConnections.filter(item => {
      if (filter === "kubernetes") return item.kind === "kubernetes" && item.mode !== "agent";
      if (filter === "docker") return item.kind === "docker" && item.mode !== "agent";
      if (filter === "agents") return remoteAgents && item.mode === "agent";
      return true;
    });
    const attention = availableConnections.filter(item => ["bad", "warn"].includes(connectionStatusClass(item.status?.state))).length;
    shell(`<section class="page connections-page">
      <header class="page-header"><div><h1 class="page-title">Connections</h1></div><div class="header-actions"><button class="btn primary" data-action="add-connection">Add connection</button></div></header>
      ${availableConnections.length ? `
        <div class="connection-status-strip" aria-label="Connection overview">
          <span><strong>${availableConnections.length}</strong> configured</span>
          <span class="${attention ? "warn" : ""}"><strong>${attention}</strong> need attention</span>
        </div>
        <section class="connection-registry">
          <div class="connection-toolbar">
            <div class="segmented-control" aria-label="Filter connections">
              ${connectionFilterButton("all", "All")}
              ${connectionFilterButton("kubernetes", "Kubernetes")}
              ${connectionFilterButton("docker", "Docker")}
              ${connectionFilterButton("agents", "Agents", !remoteAgents)}
            </div>
          </div>
          <div class="connection-registry-head" aria-hidden="true"><span>Runtime</span><span>Route</span><span>State</span><span>Last contact</span><span>Actions</span></div>
          <div class="connection-registry-body">${filtered.length ? filtered.map(connectionRegistryRow).join("") : `<div class="connection-filter-empty">No connections match this view.</div>`}</div>
        </section>` : connectionOnboarding()}
    </section>`, "connections");
  }

  function connectionFilterButton(value, label, disabled = false) {
    return `<button type="button" class="${state.connectionFilter === value ? "active" : ""}" data-action="filter-connections" data-filter="${value}" ${disabled ? 'disabled title="Coming soon"' : ""}>${label}${disabled ? `<span class="control-note">Coming soon</span>` : ""}</button>`;
  }

  function connectionOnboarding() {
    return `<section class="connection-onboarding">
      <div class="connection-onboarding-copy"><h2>Connect your first runtime</h2></div>
      <div class="connection-choice-list">
        ${connectionChoice("K", "Kubernetes", "Kubeconfig, OpenShift, EKS, GKE, or AKS", "kubernetes")}
        ${connectionChoice("D", "Docker", "Local socket, SSH host, or remote Engine API", "docker")}
        ${connectionChoice("A", "Remote agent", "Kubernetes and Docker", "agent", true)}
      </div>
    </section>`;
  }

  function connectionChoice(symbol, title, copy, kind, disabled = false) {
    return `<button type="button" class="connection-choice ${disabled ? "is-disabled" : ""}" data-action="add-connection-kind" data-kind="${kind}" ${disabled ? 'disabled title="Coming soon"' : ""}>
      <span class="connection-choice-symbol">${symbol}</span><span><strong>${title}</strong><small>${copy}</small></span>${disabled ? `<span class="control-note">Coming soon</span>` : `<span class="connection-choice-arrow">→</span>`}
    </button>`;
  }

  function connectionRegistryRow(item) {
    const status = item.status || { state: "configured" };
    const scope = connectionScope(item);
    const route = item.mode === "agent"
      ? ((item.deployment?.mode === "temporary" || item.agent?.run_mode === "temporary") ? "Temporary agent" : item.ssh ? "SSH-managed agent" : "Remote agent")
      : item.ssh && item.http_proxy ? "SSH + HTTP proxy" : item.ssh ? "SSH" : item.http_proxy ? "HTTP proxy" : "Direct";
    const access = item.kind === "docker"
      ? (item.access_mode === "manage" ? "Manage containers" : "View only")
      : "View only";
    const kindLabel = item.kind === "kubernetes" ? "Kubernetes" : "Docker";
    const symbol = item.kind === "kubernetes" ? "K" : "D";
    const contact = item.mode === "agent" ? (status.last_seen ? relativeTime(status.last_seen) : "Waiting") : "On demand";
    const menuID = `connection-actions-${item.id}`;
    return `<article class="connection-registry-row">
      <div class="connection-runtime"><span class="connection-mark" aria-hidden="true">${symbol}</span><span><strong>${html(item.name)}</strong><small>${html(kindLabel)} · ${html(route)} · ${html(access)}</small></span></div>
      <div class="connection-route" title="${html(scope)}"><strong>${html(scope)}</strong>${status.message ? `<small>${html(status.message)}</small>` : ""}</div>
      <span class="status ${connectionStatusClass(status.state)}">${html(status.state || "configured")}</span>
      <span class="connection-contact">${html(contact)}</span>
      <div class="connection-row-actions">
        <div class="connection-action-menu">
          <button type="button" class="connection-menu-trigger" data-action="toggle-connection-menu" aria-label="Actions for ${html(item.name)}" aria-haspopup="menu" aria-controls="${html(menuID)}" aria-expanded="false">
            <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="4" cy="10" r="1.4"></circle><circle cx="10" cy="10" r="1.4"></circle><circle cx="16" cy="10" r="1.4"></circle></svg>
          </button>
          <div id="${html(menuID)}" class="connection-menu" role="menu" aria-label="${html(item.name)} actions" hidden>
            <button type="button" role="menuitem" data-action="edit-connection" data-id="${html(item.id)}">Edit</button>
            <button type="button" role="menuitem" data-action="view-connection-workloads" data-id="${html(item.id)}">View workloads</button>
            <button type="button" role="menuitem" data-action="test-connection" data-id="${html(item.id)}">Test</button>
            <div class="connection-menu-separator" role="separator"></div>
            <button type="button" class="danger" role="menuitem" data-action="delete-connection" data-id="${html(item.id)}">Delete</button>
          </div>
        </div>
      </div>
    </article>`;
  }

  function closeConnectionMenus(restoreFocus = false) {
    let closedWorkloadMenu = false;
    document.querySelectorAll(".connection-action-menu").forEach(field => {
      const menu = field.querySelector(".connection-menu");
      const trigger = field.querySelector(".connection-menu-trigger");
      if (!menu || menu.hidden) return;
      if (field.classList.contains("workload-action-menu")) {
        closedWorkloadMenu = true;
        state.workloadPendingMenuFocus = restoreFocus && state.workloadViewPending ? menu.id : "";
      }
      menu.hidden = true;
      field.classList.remove("opens-up");
      field.classList.remove("aligns-right");
      trigger?.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger?.focus();
    });
    if (closedWorkloadMenu) flushPendingWorkloadView();
  }

  function workloadActionMenuOpen() {
    return Boolean(document.querySelector("#workload-content .workload-action-menu .connection-menu:not([hidden])"));
  }

  function flushPendingWorkloadView() {
    if (!state.workloadViewPending) return;
    queueMicrotask(() => {
      if (!state.workloadViewPending || state.route?.path !== "/workloads" || state.workloadScrollActive || workloadActionMenuOpen()) return;
      const focusMenuID = state.workloadPendingMenuFocus;
      state.workloadPendingMenuFocus = "";
      state.workloadViewPending = false;
      updateWorkloadView();
      if (!focusMenuID) return;
      const trigger = [...document.querySelectorAll(".workload-action-menu .connection-menu-trigger")]
        .find(item => item.getAttribute("aria-controls") === focusMenuID);
      trigger?.focus();
    });
  }

  function toggleConnectionMenu(field, focusFirst = false) {
    if (!field) return;
    const menu = field.querySelector(".connection-menu");
    const trigger = field.querySelector(".connection-menu-trigger");
    if (!menu || !trigger) return;
    const open = menu.hidden;
    closeConnectionMenus();
    if (!open) return;
    const bounds = field.getBoundingClientRect();
    const roomBelow = window.innerHeight - bounds.bottom;
    field.classList.toggle("opens-up", roomBelow < 210 && bounds.top > roomBelow);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    if (focusFirst) requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus());
  }

  function connectionScope(item) {
    if (item.mode === "agent") {
      if (item.ssh?.host) return `${item.kind === "docker" ? "Docker" : "Kubernetes"} on ${sshTarget(item.ssh)}`;
      const namespaces = item.deployment?.namespaces || item.agent?.namespaces || [];
      return namespaces.length ? namespaces.join(", ") : "All permitted namespaces";
    }
    if (item.ssh?.host) {
      const remote = sshTarget(item.ssh);
      const target = item.kind === "docker" ? `${remote} · ${item.docker?.endpoint || "/var/run/docker.sock"}` : `${remote} · ${item.kubernetes?.kubeconfig_path || "~/.kube/config"}`;
      return item.http_proxy?.display_url ? `${target} · via ${item.http_proxy.display_url}` : target;
    }
    if (item.kind === "docker") {
      const target = item.docker?.endpoint || "Docker Engine";
      return item.http_proxy?.display_url ? `${target} · via ${item.http_proxy.display_url}` : target;
    }
    const source = item.kubernetes?.kubeconfig_source === "stored" ? "Stored kubeconfig" : item.kubernetes?.kubeconfig_path || "Kubeconfig";
    const target = item.kubernetes?.context ? `${source} · ${item.kubernetes.context}` : source;
    return item.http_proxy?.display_url ? `${target} · via ${item.http_proxy.display_url}` : target;
  }

  function sshTarget(value) {
    const user = value?.user ? `${value.user}@` : "";
    const port = value?.port && value.port !== 22 ? `:${value.port}` : "";
    return `${user}${value?.host || "SSH host"}${port}`;
  }

  function connectionStatusClass(value) {
    value = String(value || "").toLowerCase();
    if (/connected|ready/.test(value)) return "good";
    if (/error|failed/.test(value)) return "bad";
    if (/connecting|expir|offline|disconnected/.test(value)) return "warn";
    return "info";
  }

  async function renderSettings() {
    loadingPage("settings", "Settings");
    await Promise.all([loadSettings(), loadSSHProfiles()]);
    if (state.settingsTab === "ssh") {
      renderSSHProfileSettings();
      return;
    }
    const settings = state.settings;
    shell(`<section class="page settings-page">
      <header class="page-header">
        <div><h1 class="page-title">Settings</h1></div>
        <div class="header-actions"><button id="settings-save" class="btn primary" type="submit" form="settings-form" disabled>Saved</button></div>
      </header>
      ${settingsTabs("general")}
      <form id="settings-form" class="settings-instrument">
        <section class="settings-group">
          <div class="settings-group-heading">
            <div><h2>Live defaults</h2><p>Changes apply to new views.</p></div>
          </div>
          <div class="settings-row-list">
            <label class="settings-row">
              <span><strong>Initial log window</strong><small>Lines requested when a live log workbench opens.</small></span>
              <div class="field-with-unit"><input class="field" name="default_tail_lines" type="number" min="0" max="100000" value="${html(settings.default_tail_lines ?? 200)}"><span>lines</span></div>
            </label>
            <label class="settings-row">
              <span><strong>Workload overview refresh</strong><small>How often CPU and memory refresh on the workload list.</small></span>
              <div class="field-with-unit"><input class="field" name="overview_metrics_interval_seconds" type="number" min="10" max="3600" value="${html(settings.overview_metrics_interval_seconds ?? 30)}"><span>seconds</span></div>
            </label>
            <label class="settings-row">
              <span><strong>Open workload metrics</strong><small>Metric cadence while any workload is selected.</small></span>
              <div class="field-with-unit"><input class="field" name="selected_metrics_interval_seconds" type="number" min="1" max="300" value="${html(settings.selected_metrics_interval_seconds ?? 2)}"><span>seconds</span></div>
            </label>
          </div>
        </section>

        <section class="settings-group">
          <div class="settings-group-heading">
            <div><h2>Remote agents</h2></div>
            <span class="settings-policy-label">Coming soon</span>
          </div>
        </section>

        <details class="settings-group settings-group-disclosure">
          <summary>
            <span><strong>Legacy Kubernetes over SSH</strong><small>External commands are used only for Kubernetes connections routed through an SSH host.</small></span>
            <span class="settings-group-summary"><span class="settings-policy-label">${settings.exec_plugin_policy === "deny" ? "Never run" : settings.exec_plugin_policy === "allow" ? "Any helper" : "Known helpers"}</span><span class="settings-chevron">›</span></span>
          </summary>
          <div class="settings-group-body">
            <div class="settings-security-layout">
              <label>Default remote kubectl executable<input class="field mono" name="kubectl_path" value="${html(settings.kubectl_path || "kubectl")}"><span class="hint">Used only on SSH hosts; direct connections call the Kubernetes API.</span></label>
              <fieldset class="policy-choices">
                <legend>Credential helper policy</legend>
                ${settingsPolicyChoice("deny", "Never run", "Static tokens and certificates only.", settings.exec_plugin_policy)}
                ${settingsPolicyChoice("allowlist", "Known helpers", "Run only commands named below.", settings.exec_plugin_policy)}
                ${settingsPolicyChoice("allow", "Any helper", "Trust every command in a kubeconfig.", settings.exec_plugin_policy)}
              </fieldset>
              <label id="exec-allowlist-field">Allowed commands<input class="field mono" name="exec_plugin_allowlist" value="${html((settings.exec_plugin_allowlist || []).join(", "))}"><span class="hint">For example: aws, gke-gcloud-auth-plugin, kubelogin, oc.</span></label>
            </div>
          </div>
        </details>
      </form>
    </section>`, "settings");
    const form = document.getElementById("settings-form");
    form.addEventListener("submit", saveSettings);
    const markDirty = () => {
      const button = document.getElementById("settings-save");
      if (!button) return;
      button.disabled = false;
      button.textContent = "Save changes";
    };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    document.querySelectorAll('[name="exec_plugin_policy"]').forEach(input => input.addEventListener("change", updateExecAllowlistVisibility));
    updateExecAllowlistVisibility();
  }

  function settingsTabs(active) {
    return `<nav class="view-tabs settings-tabs" aria-label="Settings sections">
      <button class="view-tab ${active === "general" ? "active" : ""}" data-action="settings-tab" data-tab="general">General</button>
      <button class="view-tab ${active === "ssh" ? "active" : ""}" data-action="settings-tab" data-tab="ssh">SSH profiles <span class="tab-count">${state.sshProfiles.length}</span></button>
    </nav>`;
  }

  function renderSSHProfileSettings() {
    const profiles = state.sshProfiles;
    shell(`<section class="page settings-page">
      <header class="page-header">
        <div><h1 class="page-title">Settings</h1></div>
        <div class="header-actions"><button class="btn primary" data-action="add-ssh-profile">New profile</button></div>
      </header>
      ${settingsTabs("ssh")}
      <section class="ssh-profile-registry" aria-label="Saved SSH profiles">
        <div class="ssh-profile-registry-head">
          <div><h2>SSH profiles</h2></div>
          <span>${profiles.length} saved</span>
        </div>
        ${profiles.length ? `<div class="ssh-profile-list">${profiles.map(sshProfileRow).join("")}</div>` : `
          <div class="ssh-profile-empty">
            <span class="ssh-profile-empty-mark" aria-hidden="true">SSH</span>
            <div><strong>No SSH profiles yet</strong><p>Create one here or while adding a connection.</p></div>
            <button class="btn" data-action="add-ssh-profile">Create profile</button>
          </div>`}
      </section>
    </section>`, "settings");
  }

  function sshProfileRow(profile) {
    const auth = profile.has_private_key ? "Stored key" : "SSH agent or default key";
    const verification = profile.host_key_policy === "strict" ? "Known host required" : "Trust first use";
    return `<article class="ssh-profile-row">
      <span class="ssh-profile-mark" aria-hidden="true">S</span>
      <div class="ssh-profile-identity"><strong>${html(profile.name)}</strong><small class="mono">${html(sshProfileTarget(profile))}</small></div>
      <div class="ssh-profile-meta"><span>${auth}</span><span>${verification}</span>${profile.proxy_jump ? `<span>via ${html(profile.proxy_jump)}</span>` : ""}</div>
      <div class="ssh-profile-actions"><button class="btn small" data-action="test-ssh-profile" data-id="${html(profile.id)}">Test</button><button class="btn small danger" data-action="delete-ssh-profile" data-id="${html(profile.id)}">Remove</button></div>
    </article>`;
  }

  function sshProfileTarget(profile) {
    const user = profile?.user ? `${profile.user}@` : "";
    const port = profile?.port && profile.port !== 22 ? `:${profile.port}` : "";
    return `${user}${profile?.host || "SSH host"}${port}`;
  }

  function showSSHProfileModal() {
    showModal(`<div class="modal-header"><div><h2 class="modal-title">New SSH profile</h2></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body"><form id="ssh-profile-form">${sshProfileEditorFields()}</form></div>
      <div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="save-ssh-profile">Save</button></div>`);
    document.querySelector('#ssh-profile-form [name="name"]')?.focus();
  }

  function sshProfilePayload(data, prefix = "") {
    return {
      name: String(data.get(`${prefix}name`) || "").trim(),
      host: String(data.get(`${prefix}host`) || "").trim(),
      port: Number(data.get(`${prefix}port`) || 22),
      user: String(data.get(`${prefix}user`) || "").trim(),
      private_key: String(data.get(`${prefix}private_key`) || "").trim(),
      known_hosts_path: String(data.get(`${prefix}known_hosts_path`) || "").trim(),
      host_key_policy: String(data.get(`${prefix}host_key_policy`) || "accept-new"),
      proxy_jump: String(data.get(`${prefix}proxy_jump`) || "").trim(),
    };
  }

  async function saveSSHProfile() {
    const form = document.getElementById("ssh-profile-form");
    if (!form?.reportValidity()) return;
    const button = modalRoot.querySelector('[data-action="save-ssh-profile"]');
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const profile = await api("/api/v1/ssh-profiles", { method: "POST", body: JSON.stringify(sshProfilePayload(new FormData(form))) });
      state.sshProfiles.push(profile);
      state.sshProfiles.sort((a, b) => a.name.localeCompare(b.name));
      closeModal();
      toast("SSH profile saved");
      if (state.route?.path === "/settings") renderSSHProfileSettings();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Save";
    }
  }

  async function saveInlineSSHProfile() {
    const fieldset = document.getElementById("ssh-inline-create");
    if (!fieldset) return;
    const controls = [...fieldset.querySelectorAll("input, textarea, select")];
    if (!controls.every(control => control.reportValidity())) return;
    const button = fieldset.querySelector('[data-action="save-inline-ssh-profile"]');
    const status = document.getElementById("ssh-profile-save-state");
    button.disabled = true;
    button.textContent = "Saving…";
    status.textContent = "Encrypting credentials…";
    try {
      const data = new FormData(document.getElementById("connection-form"));
      const profile = await api("/api/v1/ssh-profiles", { method: "POST", body: JSON.stringify(sshProfilePayload(data, "ssh_profile_")) });
      state.sshProfiles.push(profile);
      state.sshProfiles.sort((a, b) => a.name.localeCompare(b.name));
      const select = document.getElementById("ssh-profile-select");
      const createOption = select.querySelector('option[value="__new__"]');
      createOption.insertAdjacentHTML("beforebegin", `<option value="${html(profile.id)}">${html(profile.name)} — ${html(sshProfileTarget(profile))}</option>`);
      createOption.textContent = "New SSH profile…";
      select.value = profile.id;
      updateSSHProfileSelection();
      updateDockerConnectionName();
      invalidateConnectionTest();
      toast("SSH profile saved and selected");
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
      button.textContent = "Save profile";
    }
  }

  function settingsPolicyChoice(value, title, copy, selected) {
    return `<label class="policy-choice"><input type="radio" name="exec_plugin_policy" value="${value}" ${selected === value ? "checked" : ""}><span><strong>${title}</strong><small>${copy}</small></span></label>`;
  }

  function updateExecAllowlistVisibility() {
    const field = document.getElementById("exec-allowlist-field");
    const policy = document.querySelector('[name="exec_plugin_policy"]:checked')?.value;
    if (field) field.hidden = policy !== "allowlist";
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = document.getElementById("settings-save");
    button.disabled = true;
    button.textContent = "Saving…";
    let saved = false;
    try {
      const settings = {
        public_url: String(state.settings?.public_url || "").trim(),
        default_agent_image: String(state.settings?.default_agent_image || "").trim(),
        default_tail_lines: Number(data.get("default_tail_lines") || 0),
        overview_metrics_interval_seconds: Number(data.get("overview_metrics_interval_seconds") || 30),
        selected_metrics_interval_seconds: Number(data.get("selected_metrics_interval_seconds") || 2),
        kubectl_path: String(data.get("kubectl_path") || "kubectl").trim(),
        exec_plugin_policy: String(data.get("exec_plugin_policy") || "allowlist"),
        exec_plugin_allowlist: listFrom(data.get("exec_plugin_allowlist")),
      };
      state.settings = await api("/api/v1/settings", { method: "PUT", body: JSON.stringify(settings) });
      toast("Settings saved");
      saved = true;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.textContent = saved ? "Saved" : "Save changes";
      button.disabled = saved;
    }
  }

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

  function renderActivity(params) {
    const renderID = ++state.activityRenderID;
    const request = {
      connection_id: params.get("connection_id") || "",
      kind: params.get("kind") || "",
      namespace: params.get("namespace") || "",
      name: params.get("name") || "",
      pod: params.get("pod") || "",
      container: params.get("container") || "",
      topology_project: params.get("topology_project") || "",
    };
    const view = params.get("view") === "metrics" ? "metrics" : "activity";
    if (!request.connection_id || !request.kind || !request.name) {
      navigate("/workloads");
      return;
    }
    const workload = state.workloads.find(item => matchesWorkloadRequest(item, request));
    const connection = state.connections.find(item => item.id === request.connection_id);
    const title = workload?.name || request.name;
    const scopeEnabled = supportsLogScope(request, connection);
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
        <section class="metric-plot"><div class="section-head"><h2 class="section-title">Memory</h2><span class="hint">Working set</span></div><div id="metric-memory-chart" class="metric-chart"><div class="stream-state">Waiting for samples…</div></div></section>
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
              <div class="log-inspector-heading"><div><strong>Record</strong><small>Select a line to inspect or reformat.</small></div></div>
              <div id="log-record-detail" class="log-record-detail"><div class="log-inspector-empty">Select a log line.</div></div>
            </section>
          </aside>
        </div>
      </section>`;
    shell(`<section class="page activity-page ${view === "activity" ? "activity-page-live" : ""}">
      <header class="page-header activity-header">
        <div><button class="btn ghost small activity-back" data-action="back-workloads">← Workloads</button><h1 id="activity-title" class="page-title activity-title">${html(title)}</h1><div id="activity-meta" class="activity-meta">${activityMetaHTML(request, connection, workload)}</div></div>
      </header>
      ${workloadViewTabs(request, view, workload)}
      ${content}
    </section>`, "workloads");
    if (view === "metrics") {
      startMetricStream(request);
    } else {
      bindActivityControls(request);
      startActivityStream(request);
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
    if (title) title.textContent = workload?.name || request.name;
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
      <button class="view-tab ${view === "metrics" ? "active" : ""}" data-action="show-metrics-view" data-request="${encodedRequest}">Metrics</button>
      ${topologyRequest ? `<button class="view-tab ${view === "topology" ? "active" : ""}" data-action="show-topology-view" data-topology-request="${topologyRequest}">Topology</button>` : ""}
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
    const query = new URLSearchParams({ ...request, events: String(events), previous: String(previous), tail_lines: String(tail) });
    const source = new EventSource(`/api/v1/activity/stream?${query.toString()}`);
    const targetProfile = logTargetProfile(request);
    const retained = retainedRecords.slice(-3000);
    state.stream = {
      source,
      records: retained,
      seen: new Set(retained.flatMap(activityRecordKeys)),
      sources: new Set(),
      request,
      targetProfile,
      connected: false,
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
      const origin = [record.source, record.pod, record.container].filter(Boolean).join(" · ");
      if (origin) state.stream.sources.add(origin);
    }
    updateLogSourceOptions();
    updateLogTargetOptions(null, targetProfile);
    if (retained.length) scheduleActivityRender(true);
    setStreamStatus("Opening live stream…", "info");
    source.addEventListener("open", () => {
      if (!state.stream || state.stream.source !== source) return;
      state.stream.connected = true;
      setStreamStatus(state.stream.records.length ? "Live" : "Live · waiting for logs", "info");
    });
    source.addEventListener("activity", event => {
      if (!state.stream || state.stream.source !== source) return;
      let record;
      try { record = JSON.parse(event.data); } catch { return; }
      const key = activityRecordDedupeKey(record);
      if (state.stream.seen.has(key)) return;
      record._runwakeKey = key;
      record._coalescedKeys = [key];
      record._lineCount = Math.max(1, String(record.message || "").split("\n").length);
      state.stream.seen.add(key);
      const coalesced = coalesceActivityRecord(state.stream, record);
      if (!coalesced) state.stream.records.push(record);
      if (state.stream.records.length > 3000) {
        const removed = state.stream.records.splice(0, 500);
        const removedKeys = new Set();
        removed.forEach(item => {
          for (const removedKey of activityRecordKeys(item)) {
            removedKeys.add(removedKey);
            state.stream.seen.delete(removedKey);
          }
          state.stream.profile.overrides.delete(activityRecordKey(item, 0));
          state.stream.expandedEntries.delete(activityRecordKey(item, 0));
        });
        state.stream.jumpHistory.forEach(anchor => { anchor.indexHint = Math.max(0, anchor.indexHint - removed.length); });
        if (removedKeys.has(state.stream.selectedKey)) state.stream.selectedKey = "";
        state.stream.fullRender = true;
      }
      setStreamStatus(`Live · latest ${formatTime(record.timestamp)}`, "info");
      updateLogSourceOptions(record);
      updateLogTargetOptions(record);
      scheduleActivityRender(coalesced);
    });
    source.addEventListener("activity-end", () => {
      if (!state.stream || state.stream.source !== source) return;
      state.stream.connected = false;
      setStreamStatus("Stream ended · showing buffered records", "info");
    });
    source.addEventListener("error", () => {
      if (!state.stream || state.stream.source !== source) return;
      state.stream.connected = false;
      setStreamStatus("Stream interrupted. The browser will retry while this page remains open.", "warning");
    });
  }

  function stopActivityStream() {
    if (state.stream?.renderFrame) cancelAnimationFrame(state.stream.renderFrame);
    if (state.stream?.positionFrame) cancelAnimationFrame(state.stream.positionFrame);
    if (state.stream?.source) state.stream.source.close();
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
    set("metric-source", `${latest.source || "metrics"} · ${formatTime(latest.timestamp)}`);
    const cpuPercent = latest.cpu_percent !== undefined && latest.cpu_percent !== null;
    set("metric-cpu-unit", cpuPercent ? "Percent of one or more CPUs" : "Millicores");
    const cpuValues = samples.map(item => cpuPercent ? Number(item.cpu_percent || 0) : Number(item.cpu_cores || 0) * 1000);
    const memoryValues = samples.map(item => Number(item.memory_bytes || 0) / (1024 * 1024));
    const cpuChart = document.getElementById("metric-cpu-chart");
    const memoryChart = document.getElementById("metric-memory-chart");
    if (cpuChart) cpuChart.innerHTML = metricChart(cpuValues, cpuPercent ? "%" : "m");
    if (memoryChart) memoryChart.innerHTML = metricChart(memoryValues, "MiB");
    renderContainerMetrics(latest);
  }

  function metricChart(values, unit) {
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
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Last ten minutes"><line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" class="chart-axis"></line><polyline points="${points}" class="chart-line"></polyline></svg><div class="chart-caption"><span>10 minutes</span><span>${number(latest)} ${unit} current · ${number(max)} ${unit} max</span></div>`;
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
    const origin = [record.source, record.pod, record.container].filter(Boolean).join(" · ");
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
    const content = [record.timestamp, record.type, record.level, record.source, record.pod, record.container, record.message];
    return content.some(value => value !== undefined && value !== null && value !== "")
      ? `c:${JSON.stringify(content)}`
      : `s:${record.sequence || ""}`;
  }

  function activityRecordKeys(record) {
    return record._coalescedKeys?.length ? record._coalescedKeys : [activityRecordDedupeKey(record)];
  }

  function displayLogOrigin(record) {
    const requestName = String(state.stream?.request?.name || "");
    const parts = [record.source];
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
      const origin = [record.source, record.pod, record.container].filter(Boolean).join(" · ");
      if (origin) stream.sources.add(origin);
    }
    const current = select.value;
    const sources = [...stream.sources].sort();
    const signature = sources.join("\n");
    if (select.dataset.sources === signature) return;
    select.dataset.sources = signature;
    select.innerHTML = `<option value="">All sources</option>${sources.map(value => `<option value="${html(value)}">${html(value)}</option>`).join("")}`;
    if (sources.includes(current)) select.value = current;
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
    const focusActions = record.pod ? `<div class="log-record-focus">
      <span>Focus the live stream</span>
      <button class="log-focus-choice" data-action="focus-log-pod" data-pod="${html(record.pod)}">Only this pod</button>
      ${record.container ? `<button class="log-focus-choice" data-action="focus-log-source" data-pod="${html(record.pod)}" data-container="${html(record.container)}">Only this source</button>` : ""}
    </div>` : "";
    target.innerHTML = `
      <div class="log-record-meta"><span>${html(formatTime(record.timestamp, true))}</span><span>${html(origin || record.type || "record")}</span></div>
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

  function showAddConnection(kind = "kubernetes") {
    if (kind === "agent" && !remoteAgentsAvailable()) {
      toast("Remote agents are coming soon");
      kind = "kubernetes";
    }
    const settings = state.settings || { exec_plugin_policy: "allowlist", exec_plugin_allowlist: [] };
    const direct = kind !== "agent";
    showModal(`
      <div class="modal-header"><div><h2 class="modal-title">${direct ? "Add connection" : "Create remote agent"}</h2></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="tabs"><button class="tab ${kind === "kubernetes" ? "active" : ""}" data-action="switch-add-kind" data-kind="kubernetes">Kubernetes</button><button class="tab ${kind === "docker" ? "active" : ""}" data-action="switch-add-kind" data-kind="docker">Docker</button><button class="tab ${kind === "agent" ? "active" : ""}" data-action="switch-add-kind" data-kind="agent" ${remoteAgentsAvailable() ? "" : 'disabled title="Coming soon"'}>Remote agent${remoteAgentsAvailable() ? "" : `<span class="control-note">Coming soon</span>`}</button></div>
        <form id="connection-form">
          <input type="hidden" name="kind" value="${kind}">
          ${kind === "kubernetes" ? kubernetesForm(settings) : kind === "docker" ? dockerForm() : remoteAgentForm(settings)}
        </form>
      </div>
      <div class="modal-footer connection-footer">
        ${direct ? `<div id="connection-test-state" class="connection-test-state idle"><span></span><strong>Not tested</strong></div>` : `<div id="connection-test-state" class="connection-test-state idle" hidden><span></span><strong></strong></div>`}
        <div class="connection-footer-actions">
          <button class="btn" data-action="close-modal">Cancel</button>
          ${direct ? `<button class="btn" data-action="test-draft-connection">Test</button><span id="add-connection-gate" class="button-gate locked" tabindex="0" data-tooltip="Test the connection successfully before adding it."><button class="btn primary" data-action="submit-connection" disabled>Add</button></span>` : `<button class="btn" data-action="test-agent-ssh" hidden>Test</button><span id="add-connection-gate" class="button-gate"><button class="btn primary" data-action="submit-connection">Create setup</button></span>`}
        </div>
      </div>`, "wide connection-modal");
    document.getElementById("kube-source")?.addEventListener("change", updateKubeSourceFields);
    document.getElementById("kube-transport")?.addEventListener("change", updateKubeTransportFields);
    document.getElementById("http-proxy-mode")?.addEventListener("change", event => {
      updateHTTPProxyFields();
      if (event.target.value === "http") requestAnimationFrame(() => document.querySelector('[name="http_proxy_url"]')?.focus());
    });
    document.getElementById("kube-platform")?.addEventListener("change", updateKubePlatformFields);
    document.querySelector('[name="kubeconfig"]')?.addEventListener("input", inferKubeconfigMetadata);
    document.getElementById("oc-login-command")?.addEventListener("input", updateOpenShiftLogin);
    for (const id of ["openshift-server-input", "openshift-auth-method", "openshift-token-input", "openshift-username-input", "openshift-password-input", "openshift-insecure-input"]) {
      document.getElementById(id)?.addEventListener("input", () => updateOpenShiftManual());
      document.getElementById(id)?.addEventListener("change", () => updateOpenShiftManual());
    }
    document.getElementById("cloud-credential-command")?.addEventListener("input", applyCloudCommandToFields);
    document.getElementById("cloud-import-button")?.addEventListener("click", importCloudKubeconfig);
    document.querySelector('[name="name"]')?.addEventListener("input", event => {
      delete event.target.dataset.openshiftAutofilled;
      delete event.target.dataset.cloudAutofilled;
      delete event.target.dataset.kubeconfigAutofilled;
      delete event.target.dataset.dockerAutofilled;
    });
    document.querySelector('[name="context"]')?.addEventListener("input", event => delete event.target.dataset.computed);
    document.getElementById("kubeconfig-file")?.addEventListener("change", readKubeconfigFile);
    document.querySelector('[name="endpoint"]')?.addEventListener("input", updateDockerConnectionName);
    document.getElementById("ssh-profile-select")?.addEventListener("change", () => {
      updateSSHProfileSelection();
      updateDockerConnectionName();
    });
    document.getElementById("docker-transport")?.addEventListener("change", updateDockerTransportFields);
    document.getElementById("namespace-mode")?.addEventListener("change", updateNamespaceField);
    document.getElementById("remote-agent-kind")?.addEventListener("change", updateRemoteAgentFields);
    document.getElementById("remote-agent-mode")?.addEventListener("change", updateRemoteAgentFields);
    document.getElementById("remote-agent-namespace-mode")?.addEventListener("change", updateRemoteAgentFields);
    document.getElementById("remote-agent-setup-method")?.addEventListener("change", updateRemoteAgentFields);
    const connectionForm = document.getElementById("connection-form");
    connectionForm.dataset.testPassed = direct ? "false" : "not-required";
    connectionForm.addEventListener("input", invalidateConnectionTest);
    connectionForm.addEventListener("change", invalidateConnectionTest);
    updateKubeSourceFields();
    updateKubeTransportFields();
    updateKubePlatformFields();
    updateNamespaceField();
    updateRemoteAgentFields();
    updateDockerTransportFields();
    updateHTTPProxyFields();
    updateSSHProfileSelection();
    updateDockerConnectionName();
    modalRoot.querySelector(`[data-action="switch-add-kind"][data-kind="${kind}"]`)?.focus();
  }

  function kubernetesForm(settings) {
    return `<div class="form-grid">
      <label class="full">Cluster setup<select id="kube-platform"><option value="kubernetes">Kubernetes kubeconfig</option><option value="openshift">Red Hat OpenShift</option><option value="eks">Amazon EKS</option><option value="gke">Google GKE</option><option value="aks">Microsoft Azure AKS</option></select></label>
      <label class="full">Connection name<input class="field" name="name" placeholder="Production cluster" required></label>
      <div class="full" id="kube-standard-fields">
        <label>Runtime access<select id="kube-transport" name="transport"><option value="direct">From this computer</option><option value="ssh">From an SSH profile</option></select></label>
        ${sshFields()}
        ${httpProxyControl()}
        <label>Kubeconfig source<select id="kube-source" name="kubeconfig_source"><option value="path">Path on this computer</option><option value="upload">Paste or upload a copy</option></select></label>
        <label id="kube-path-field">Kubeconfig path<input class="field mono" name="kubeconfig_path" placeholder="~/.kube/config"><span id="kube-path-hint" class="hint">The path, referenced CA files, client certificates, and exec commands must exist on this computer.</span></label>
        <div id="kube-upload-field" hidden><label>Kubeconfig content<textarea class="mono" name="kubeconfig" placeholder="apiVersion: v1…"></textarea><span class="hint">Referenced files must exist on the Runwake host. Flatten kubeconfigs that reference local-only files before uploading.</span></label><div class="file-input-row"><input id="kubeconfig-file" type="file" accept=".yaml,.yml,.config,text/yaml,application/yaml"></div></div>
      </div>
      <div class="full" id="openshift-login-fields" hidden>
        <label>OpenShift login command <span class="optional-label">Optional</span><textarea id="oc-login-command" class="mono compact-textarea" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="oc login --token=sha256~… --server=https://api.cluster.example:6443"></textarea></label>
        <div class="form-grid provider-fields">
          <label class="full">API server<input id="openshift-server-input" class="field mono" type="url" placeholder="https://api.cluster.example:6443"></label>
          <label>Authentication<select id="openshift-auth-method"><option value="token">Bearer token</option><option value="password">Username and password</option></select></label>
          <label id="openshift-token-field">Token<input id="openshift-token-input" class="field mono" type="password" autocomplete="off" placeholder="sha256~…"></label>
          <label id="openshift-username-field" hidden>Username<input id="openshift-username-input" class="field" autocomplete="username"></label>
          <label id="openshift-password-field" hidden>Password<input id="openshift-password-input" class="field" type="password" autocomplete="current-password"></label>
          <label class="choice full-choice full"><input id="openshift-insecure-input" type="checkbox"><span><span class="choice-title">Skip TLS certificate verification</span><span class="choice-copy">Use only when the cluster uses a certificate this computer cannot verify.</span></span></label>
        </div>
        <div id="openshift-login-status" class="notice info openshift-login-status">Waiting for an <span class="mono">oc login</span> command.</div>
        <div class="openshift-preview" id="openshift-preview" hidden>
          <div><span>Server</span><strong id="openshift-server"></strong></div>
          <div><span>Authentication</span><strong id="openshift-auth"></strong></div>
        </div>
      </div>
      <div class="full" id="cloud-login-fields" hidden>
        <label><span id="cloud-command-label">Cloud credential command</span> <span class="optional-label">Optional</span><textarea id="cloud-credential-command" class="mono compact-textarea" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
        <div id="cloud-provider-fields" class="form-grid provider-fields"></div>
        <div class="cloud-import-row"><button id="cloud-import-button" class="btn small" type="button">Import kubeconfig</button><span id="cloud-cli-requirement" class="hint"></span></div>
        <div id="cloud-import-status" class="notice info cloud-import-status">Paste the provider credential command, then import it.</div>
        <div class="openshift-preview" id="cloud-preview" hidden>
          <div><span>Cluster</span><strong id="cloud-cluster"></strong></div>
          <div><span>Credential helper</span><strong id="cloud-auth"></strong></div>
        </div>
      </div>
      <label>Namespace scope<select id="namespace-mode" name="namespace_mode"><option value="all">All permitted namespaces</option><option value="selected">Selected namespaces</option></select></label>
      <label id="namespace-field" hidden>Namespaces<input class="field" name="namespaces" placeholder="payments, platform"></label>
    </div>
    <details id="kube-advanced-options" class="kube-overrides">
      <summary>
        <span class="kube-overrides-copy"><strong>Cluster access overrides</strong><small>Context and legacy SSH connection options</small></span>
        <span class="kube-overrides-toggle"><span class="kube-overrides-action"><span class="when-closed">Configure</span><span class="when-open">Hide</span></span><span class="kube-overrides-chevron" aria-hidden="true">›</span></span>
      </summary>
      <div class="kube-overrides-body">
        <div class="form-grid">
          <label class="full">Context override<input class="field mono" name="context" placeholder="production"></label>
          <label id="kube-kubectl-field" hidden>Remote kubectl executable<input class="field mono" name="kubectl_path" placeholder="${html(settings.kubectl_path || "kubectl")}"></label>
          <label id="kube-exec-policy-field" hidden>Exec credential plugins<select name="exec_policy"><option value="deny" ${settings.exec_plugin_policy === "deny" ? "selected" : ""}>Deny</option><option value="allowlist" ${settings.exec_plugin_policy === "allowlist" ? "selected" : ""}>Allow listed commands</option><option value="allow" ${settings.exec_plugin_policy === "allow" ? "selected" : ""}>Allow all kubeconfig exec commands</option></select></label>
          <label id="kube-exec-allowlist-field" class="full" hidden>Allowed exec commands<input class="field mono" name="exec_allowlist" value="${html((settings.exec_plugin_allowlist || []).join(", "))}"><span class="hint">Examples include aws, oc, az, gcloud, kubelogin, and custom organization login tools.</span></label>
          <label id="kube-environment-field" class="full" hidden>Environment overrides<textarea class="mono" name="environment" placeholder="AWS_PROFILE=production&#10;AZURE_CONFIG_DIR=/runwake/azure"></textarea><span class="hint">Passed to kubectl and credential plugins on the SSH host.</span></label>
        </div>
      </div>
    </details>`;
  }

  function dockerForm() {
    return `<div class="form-grid">
      <label>Connection name<input class="field" name="name" placeholder="Local Docker" required></label>
      <label>Runtime access<select id="docker-transport" name="transport"><option value="local">Local socket</option><option value="ssh">From an SSH profile</option><option value="api">Remote Engine API</option></select><span id="runtime-access-hint" class="hint" hidden></span></label>
      ${sshFields()}
      ${httpProxyControl()}
      <label id="docker-endpoint-field" class="full">Engine endpoint<input class="field mono" name="endpoint" value="unix:///var/run/docker.sock" required><span id="docker-endpoint-hint" class="hint" hidden></span></label>
      <fieldset class="runtime-permission full">
        <legend>Docker permissions</legend>
        <div class="runtime-permission-options">
          <label class="choice"><input type="radio" name="access_mode" value="read_only" checked><span><span class="choice-title">View only</span><span class="choice-copy">Inspect containers, logs, events, and metrics without changing workloads.</span></span></label>
          <label class="choice"><input type="radio" name="access_mode" value="manage"><span><span class="choice-title">Manage containers</span><span class="choice-copy">Restart or delete containers, and restart Compose projects.</span></span></label>
        </div>
        <p class="runtime-permission-note">Runwake enforces this choice in its interface and API. The Docker endpoint itself remains privileged.</p>
      </fieldset>
    </div>
    <details id="docker-tls-options" class="disclosure" hidden><summary>TLS client authentication</summary>
      <div class="form-grid">
        <label class="full">Server name<input class="field mono" name="tls_server_name" placeholder="docker.example.com"></label>
        <label class="full">CA certificate<textarea class="mono" name="tls_ca" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label>
        <label>Client certificate<textarea class="mono" name="tls_cert" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label>
        <label>Client private key<textarea class="mono" name="tls_key" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></label>
      </div>
    </details>`;
  }

  function remoteAgentForm(settings) {
    return `<div class="form-grid">
      <label>Connection name<input class="field" name="name" placeholder="Production agent" required></label>
      <label>Target<select id="remote-agent-kind" name="agent_kind"><option value="kubernetes">Kubernetes cluster</option><option value="docker">Docker host</option></select></label>
      <label class="full">Setup method<select id="remote-agent-setup-method" name="setup_method"><option value="instructions">Generate setup instructions</option><option value="ssh">Install over SSH</option></select></label>
      ${sshFields()}
      <label id="remote-agent-kubeconfig-field" class="full" hidden>Remote kubeconfig path<input class="field mono" name="remote_kubeconfig_path" value="~/.kube/config"><span class="hint">Path on the SSH host.</span></label>
      <label id="remote-agent-kubectl-field" hidden>Remote kubectl executable<input class="field mono" name="remote_kubectl_path" value="kubectl"></label>
      <label id="remote-agent-docker-socket-field" class="full" hidden>Remote Docker socket<input class="field mono" name="docker_socket_path" value="/var/run/docker.sock"></label>
      <label>Run mode<select id="remote-agent-mode" name="mode"><option value="persistent">Persistent</option><option value="temporary">Temporary</option></select></label>
      <label id="remote-agent-ttl-field" hidden>Lifetime in minutes<input class="field" name="ttl_minutes" type="number" min="1" value="30"></label>
      <label class="full">Runwake server URL<input class="field mono" name="server_url" type="url" value="${html(settings.public_url || "")}" placeholder="https://runwake.example.com" required><span class="hint">Must be reachable from the target.</span></label>
      <label class="full">Agent image<input class="field mono" name="image" value="${html(settings.default_agent_image || "")}" placeholder="registry.example.com/runwake-agent:0.1.0" required></label>
      <label id="remote-agent-namespace-field">Agent namespace<input class="field mono" name="agent_namespace" value="runwake-system"></label>
      <label id="remote-agent-scope-field">Workload namespace scope<select id="remote-agent-namespace-mode" name="namespace_mode"><option value="all">All permitted namespaces</option><option value="selected">Selected namespaces</option></select></label>
      <label id="remote-agent-namespaces-field" class="full" hidden>Namespaces<input class="field" name="namespaces" placeholder="payments, platform"></label>
    </div>
    <div id="remote-agent-docker-warning" class="notice mt-16" hidden>Docker agents require privileged socket access.</div>`;
  }

  function sshFields() {
    const options = state.sshProfiles.map(profile => `<option value="${html(profile.id)}">${html(profile.name)} — ${html(sshProfileTarget(profile))}</option>`).join("");
    return `<section id="ssh-fields" class="full ssh-profile-picker" hidden>
      <div class="ssh-profile-picker-main">
        <label>SSH profile<select id="ssh-profile-select" name="ssh_profile_id">${options}<option value="__new__">${state.sshProfiles.length ? "New SSH profile…" : "Create your first SSH profile"}</option></select></label>
        <div id="ssh-profile-summary" class="ssh-profile-summary"></div>
      </div>
      <fieldset id="ssh-inline-create" class="ssh-inline-create" ${state.sshProfiles.length ? "hidden disabled" : ""}>
        <div class="ssh-inline-heading"><div><strong>New SSH profile</strong></div><button class="btn ghost small" type="button" data-action="cancel-inline-ssh" ${state.sshProfiles.length ? "" : "hidden"}>Cancel</button></div>
        ${sshProfileEditorFields("ssh_profile_", true)}
      </fieldset>
    </section>`;
  }

  function httpProxyControl() {
    return `<section id="http-proxy-control" class="full http-proxy-control">
      <label>HTTP proxy<select id="http-proxy-mode" name="http_proxy_mode"><option value="none">No proxy</option><option value="http">Use an HTTP proxy</option></select><span id="http-proxy-hint" class="hint" hidden></span></label>
      <fieldset id="http-proxy-fields" class="http-proxy-fields" hidden disabled>
        <label>Proxy URL<input class="field mono" name="http_proxy_url" autocomplete="off" placeholder="http://proxy.example.com:8080" required></label>
        <label>Bypass proxy <span class="optional-label">Optional</span><input class="field mono" name="http_proxy_no_proxy" placeholder="localhost, 127.0.0.1, .svc"><span class="hint">Hosts, domains, IP ranges, or ports that should connect directly.</span></label>
      </fieldset>
    </section>`;
  }

  function sshProfileEditorFields(prefix = "", inline = false) {
    return `<div class="ssh-profile-editor-grid">
      <label>Profile name<input class="field" name="${prefix}name" placeholder="Production bastion" required></label>
      <label>Host<input class="field mono" name="${prefix}host" autocomplete="off" placeholder="server.example.com" required></label>
      <label>User <span class="optional-label">Optional</span><input class="field mono" name="${prefix}user" autocomplete="username" placeholder="ubuntu"></label>
      <label>Port<input class="field" name="${prefix}port" type="number" min="1" max="65535" value="22" required></label>
    </div>
    ${inline ? `<div class="ssh-inline-actions"><span id="ssh-profile-save-state" class="hint">Test the full runtime after saving.</span><button class="btn small" type="button" data-action="save-inline-ssh-profile">Save profile</button></div>` : ""}
    <details class="ssh-profile-details">
      <summary><span><strong>Authentication and routing</strong><small>Default keys, host verification, and jump host</small></span><span class="settings-chevron">›</span></summary>
      <div class="ssh-profile-details-body">
        <label>Private key <span class="optional-label">Optional</span><textarea class="mono compact-textarea" name="${prefix}private_key" autocomplete="off" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea><span class="hint">Leave blank to use your SSH agent, SSH config, or default keys.</span></label>
        <div class="ssh-profile-editor-grid">
          <label>Host verification<select name="${prefix}host_key_policy"><option value="accept-new">Trust new hosts; reject changes</option><option value="strict">Require a known-host entry</option></select></label>
          <label>Known hosts file <span class="optional-label">Optional</span><input class="field mono" name="${prefix}known_hosts_path" placeholder="~/.ssh/known_hosts"></label>
          <label class="full">Jump host <span class="optional-label">Optional</span><input class="field mono" name="${prefix}proxy_jump" placeholder="bastion.example.com"></label>
        </div>
      </div>
    </details>`;
  }

  function updateSSHProfileSelection() {
    const picker = document.getElementById("ssh-fields");
    const select = document.getElementById("ssh-profile-select");
    const creator = document.getElementById("ssh-inline-create");
    const summary = document.getElementById("ssh-profile-summary");
    if (!picker || !select || !creator || !summary) return;
    const creating = select.value === "__new__";
    creator.hidden = !creating;
    creator.disabled = picker.hidden || !creating;
    const profile = state.sshProfiles.find(item => item.id === select.value);
    summary.hidden = !profile;
    summary.innerHTML = profile ? `<span><strong>${html(sshProfileTarget(profile))}</strong><small>${profile.has_private_key ? "Stored key" : "SSH agent or default key"}${profile.proxy_jump ? ` · via ${html(profile.proxy_jump)}` : ""}</small></span><button class="btn ghost small" type="button" data-action="manage-ssh-profiles">Manage</button>` : "";
  }

  function updateRemoteAgentFields() {
    const kind = document.getElementById("remote-agent-kind")?.value;
    const mode = document.getElementById("remote-agent-mode")?.value;
    const namespaceMode = document.getElementById("remote-agent-namespace-mode")?.value;
    const setupMethod = document.getElementById("remote-agent-setup-method")?.value;
    const useSSH = setupMethod === "ssh";
    for (const id of ["remote-agent-namespace-field", "remote-agent-scope-field"]) {
      const field = document.getElementById(id);
      if (field) field.hidden = kind !== "kubernetes";
    }
    const namespaces = document.getElementById("remote-agent-namespaces-field");
    if (namespaces) namespaces.hidden = kind !== "kubernetes" || namespaceMode !== "selected";
    const ttl = document.getElementById("remote-agent-ttl-field");
    if (ttl) ttl.hidden = mode !== "temporary";
    setSSHFieldsVisible(useSSH);
    const kubeconfig = document.getElementById("remote-agent-kubeconfig-field");
    const kubectl = document.getElementById("remote-agent-kubectl-field");
    const dockerSocket = document.getElementById("remote-agent-docker-socket-field");
    const dockerWarning = document.getElementById("remote-agent-docker-warning");
    if (kubeconfig) kubeconfig.hidden = !useSSH || kind !== "kubernetes";
    if (kubectl) kubectl.hidden = !useSSH || kind !== "kubernetes";
    if (dockerSocket) dockerSocket.hidden = !useSSH || kind !== "docker";
    if (dockerWarning) dockerWarning.hidden = kind !== "docker";
    const form = document.getElementById("connection-form");
    const test = modalRoot.querySelector('[data-action="test-agent-ssh"]');
    const submit = modalRoot.querySelector('[data-action="submit-connection"]');
    const gate = document.getElementById("add-connection-gate");
    const testState = document.getElementById("connection-test-state");
    if (!form || !test || !submit || !gate) return;
    test.hidden = !useSSH;
    if (testState) testState.hidden = !useSSH;
    submit.textContent = useSSH ? "Install" : "Create setup";
    submit.disabled = useSSH;
    form.dataset.testPassed = useSSH ? "false" : "not-required";
    gate.classList.toggle("locked", useSSH);
    gate.toggleAttribute("tabindex", useSSH);
    gate.tabIndex = useSSH ? 0 : -1;
    if (useSSH) {
      gate.dataset.tooltip = "Test the SSH target successfully before installing.";
      updateConnectionTestState("idle", "Not tested");
    } else {
      gate.removeAttribute("data-tooltip");
      gate.removeAttribute("tabindex");
    }
  }

  function updateKubeSourceFields() {
    const value = document.getElementById("kube-source")?.value;
    const path = document.getElementById("kube-path-field");
    const upload = document.getElementById("kube-upload-field");
    if (path) path.hidden = value !== "path";
    if (upload) upload.hidden = value !== "upload";
  }

  function updateKubeTransportFields() {
    const useSSH = document.getElementById("kube-transport")?.value === "ssh";
    if (!document.getElementById("kube-transport")) return;
    setSSHFieldsVisible(useSSH);
    const accessHint = document.getElementById("runtime-access-hint");
    if (accessHint) accessHint.textContent = useSSH ? "kubectl runs on the selected SSH host." : "Runwake connects directly to the Kubernetes API; kubectl is not required.";
    for (const id of ["kube-kubectl-field", "kube-exec-policy-field", "kube-exec-allowlist-field", "kube-environment-field"]) {
      const field = document.getElementById(id);
      if (field) field.hidden = !useSSH;
    }
    const source = document.getElementById("kube-source");
    const path = document.querySelector('[name="kubeconfig_path"]');
    const hint = document.getElementById("kube-path-hint");
    if (source) {
      if (useSSH) source.value = "path";
      source.disabled = useSSH;
      const pathOption = source.querySelector('option[value="path"]');
      if (pathOption) pathOption.textContent = useSSH ? "Path on the SSH host" : "Path on this computer";
    }
    if (path && useSSH && (!path.value || path.value === "~/.kube/config")) path.value = "~/.kube/config";
    if (hint) hint.textContent = useSSH
      ? "The path, referenced files, kubectl, and credential helpers must exist on the SSH host."
      : "The path and any referenced CA or client-certificate files must exist on this computer.";
    updateHTTPProxyFields();
    updateKubeSourceFields();
  }

  function updateDockerTransportFields() {
    const transport = document.getElementById("docker-transport")?.value;
    if (!transport) return;
    const useSSH = transport === "ssh";
    setSSHFieldsVisible(useSSH);
    const accessHint = document.getElementById("runtime-access-hint");
    if (accessHint) {
      accessHint.hidden = transport === "local";
      accessHint.textContent = useSSH
        ? "Docker commands run on the selected SSH host."
        : transport === "api" ? "Runwake connects from this computer." : "";
    }
    const proxyControl = document.getElementById("http-proxy-control");
    const proxyMode = document.getElementById("http-proxy-mode");
    if (proxyControl) proxyControl.hidden = transport === "local";
    if (proxyMode) proxyMode.disabled = transport === "local";
    const endpoint = document.querySelector('[name="endpoint"]');
    const hint = document.getElementById("docker-endpoint-hint");
    const tls = document.getElementById("docker-tls-options");
    if (endpoint) {
      const defaults = ["unix:///var/run/docker.sock", "/var/run/docker.sock", "tcp://docker.example.com:2376"];
      if (!endpoint.value || defaults.includes(endpoint.value)) {
        endpoint.value = useSSH ? "/var/run/docker.sock" : transport === "api" ? "tcp://docker.example.com:2376" : "unix:///var/run/docker.sock";
      }
    }
    if (hint) {
      hint.hidden = transport === "local";
      hint.textContent = useSSH
        ? "Socket path or Engine API reachable from the SSH host. Requires the Docker CLI."
        : transport === "api" ? "HTTP or TLS Docker Engine endpoint." : "";
    }
    if (tls) tls.hidden = transport !== "api";
    updateHTTPProxyFields();
    updateDockerConnectionName();
  }

  function updateHTTPProxyFields() {
    const control = document.getElementById("http-proxy-control");
    const mode = document.getElementById("http-proxy-mode");
    const fields = document.getElementById("http-proxy-fields");
    const hint = document.getElementById("http-proxy-hint");
    if (!control || !mode || !fields) return;
    const enabled = !control.hidden && !mode.disabled && mode.value === "http";
    fields.hidden = !enabled;
    fields.disabled = !enabled;
    const useSSH = document.getElementById("kube-transport")?.value === "ssh" || document.getElementById("docker-transport")?.value === "ssh";
    if (hint) {
      hint.hidden = !enabled;
      hint.textContent = useSSH ? "Must be reachable from the selected SSH host." : "Must be reachable from this computer.";
    }
  }

  function setSSHFieldsVisible(visible) {
    const fields = document.getElementById("ssh-fields");
    if (!fields) return;
    fields.hidden = !visible;
    const select = document.getElementById("ssh-profile-select");
    if (select) select.required = visible;
    updateSSHProfileSelection();
  }

  function updateKubePlatformFields() {
    const platform = document.getElementById("kube-platform")?.value || "kubernetes";
    const openshift = platform === "openshift";
    const cloud = ["eks", "gke", "aks"].includes(platform);
    const name = document.querySelector('[name="name"]');
    const context = document.querySelector('[name="context"]');
    if (name && ((openshift && (name.dataset.cloudAutofilled === "true" || name.dataset.kubeconfigAutofilled === "true")) || (cloud && (name.dataset.openshiftAutofilled === "true" || name.dataset.kubeconfigAutofilled === "true")) || (!openshift && !cloud && (name.dataset.cloudAutofilled === "true" || name.dataset.openshiftAutofilled === "true")))) {
      name.value = "";
      delete name.dataset.cloudAutofilled;
      delete name.dataset.openshiftAutofilled;
      delete name.dataset.kubeconfigAutofilled;
    }
    if (!openshift && context?.value === "runwake-openshift") context.value = "";
    if (cloud && context?.dataset.computed === "true") {
      context.value = "";
      delete context.dataset.computed;
    }
    const standard = document.getElementById("kube-standard-fields");
    const login = document.getElementById("openshift-login-fields");
    const cloudLogin = document.getElementById("cloud-login-fields");
    const advanced = document.getElementById("kube-advanced-options");
    const source = document.getElementById("kube-source");
    const transport = document.getElementById("kube-transport");
    if (standard) standard.hidden = openshift || cloud;
    if (login) login.hidden = !openshift;
    if (cloudLogin) cloudLogin.hidden = !cloud;
    if (advanced) advanced.hidden = openshift || cloud;
    if (source && (openshift || cloud)) {
      if (transport) transport.value = "direct";
      updateKubeTransportFields();
      source.value = "upload";
      if (openshift) updateOpenShiftLogin();
      if (cloud) updateCloudImportFields(platform);
    } else {
      updateKubeSourceFields();
    }
  }

  function updateCloudImportFields(provider) {
    const options = {
      eks: {
        label: "AWS credential command",
        placeholder: "aws eks update-kubeconfig --region us-east-1 --name production",
        requirement: "Requires a signed-in AWS CLI.",
      },
      gke: {
        label: "Google Cloud credential command",
        placeholder: "gcloud container clusters get-credentials production --location us-central1 --project my-project",
        requirement: "Requires a signed-in gcloud CLI.",
      },
      aks: {
        label: "Azure credential command",
        placeholder: "az aks get-credentials --resource-group platform --name production",
        requirement: "Requires a signed-in Azure CLI.",
      },
    };
    const option = options[provider];
    const command = document.getElementById("cloud-credential-command");
    if (command) {
      if (command.dataset.provider && command.dataset.provider !== provider) command.value = "";
      command.dataset.provider = provider;
      command.placeholder = option.placeholder;
    }
    document.getElementById("cloud-command-label").textContent = option.label;
    document.getElementById("cloud-cli-requirement").textContent = option.requirement;
    renderCloudProviderFields(provider);
    const status = document.getElementById("cloud-import-status");
    if (status) {
      status.className = "notice info cloud-import-status";
      status.textContent = "Paste the provider credential command, then import it.";
    }
    const preview = document.getElementById("cloud-preview");
    if (preview) preview.hidden = true;
    const kubeconfig = document.querySelector('[name="kubeconfig"]');
    if (kubeconfig) kubeconfig.value = "";
  }

  function renderCloudProviderFields(provider) {
    const fields = document.getElementById("cloud-provider-fields");
    if (!fields) return;
    if (provider === "eks") {
      fields.innerHTML = `
        <label>Cluster name<input id="cloud-cluster-name-input" class="field" placeholder="production"></label>
        <label>AWS region<input id="cloud-region-input" class="field mono" placeholder="us-east-1"></label>
        <label>AWS profile <span class="optional-label">Optional</span><input id="cloud-profile-input" class="field mono" placeholder="production"></label>
        <label>Authentication role ARN <span class="optional-label">Optional</span><input id="cloud-role-input" class="field mono" placeholder="arn:aws:iam::…:role/…"></label>`;
    } else if (provider === "gke") {
      fields.innerHTML = `
        <label>Cluster name<input id="cloud-cluster-name-input" class="field" placeholder="production"></label>
        <label>Location<input id="cloud-location-input" class="field mono" placeholder="us-central1"></label>
        <label>Google Cloud project<input id="cloud-project-input" class="field mono" placeholder="my-project"></label>
        <label>Google account <span class="optional-label">Optional</span><input id="cloud-account-input" class="field mono" type="email" placeholder="operator@example.com"></label>`;
    } else {
      fields.innerHTML = `
        <label>Cluster name<input id="cloud-cluster-name-input" class="field" placeholder="production"></label>
        <label>Resource group<input id="cloud-resource-group-input" class="field" placeholder="platform"></label>
        <label>Azure subscription <span class="optional-label">Optional</span><input id="cloud-subscription-input" class="field mono" placeholder="name or subscription ID"></label>
        <label class="choice full-choice"><input id="cloud-admin-input" type="checkbox"><span><span class="choice-title">Use cluster administrator credentials</span><span class="choice-copy">Prefer normal user credentials unless break-glass access is required.</span></span></label>`;
    }
    fields.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", updateCloudCommandFromFields);
      input.addEventListener("change", updateCloudCommandFromFields);
    });
  }

  function updateCloudCommandFromFields() {
    const provider = document.getElementById("kube-platform")?.value;
    const cluster = cloudFieldValue("cloud-cluster-name-input");
    updateComputedConnectionName(cloudProviderName(provider), cluster, "cloudAutofilled");
    const parts = [];
    if (provider === "eks" && cluster) {
      parts.push("aws", "eks", "update-kubeconfig");
      addCommandOption(parts, "--region", cloudFieldValue("cloud-region-input"));
      addCommandOption(parts, "--name", cluster);
      addCommandOption(parts, "--profile", cloudFieldValue("cloud-profile-input"));
      addCommandOption(parts, "--role-arn", cloudFieldValue("cloud-role-input"));
    } else if (provider === "gke" && cluster) {
      parts.push("gcloud", "container", "clusters", "get-credentials", cluster);
      addCommandOption(parts, "--location", cloudFieldValue("cloud-location-input"));
      addCommandOption(parts, "--project", cloudFieldValue("cloud-project-input"));
      addCommandOption(parts, "--account", cloudFieldValue("cloud-account-input"));
    } else if (provider === "aks" && cluster && cloudFieldValue("cloud-resource-group-input")) {
      parts.push("az", "aks", "get-credentials");
      addCommandOption(parts, "--resource-group", cloudFieldValue("cloud-resource-group-input"));
      addCommandOption(parts, "--name", cluster);
      addCommandOption(parts, "--subscription", cloudFieldValue("cloud-subscription-input"));
      if (document.getElementById("cloud-admin-input")?.checked) parts.push("--admin");
    }
    const command = document.getElementById("cloud-credential-command");
    if (command) command.value = parts.map(commandShellQuote).join(" ");
    resetCloudImport(parts.length ? "Command ready. Import it to retrieve the cluster kubeconfig." : "Fill the required cluster fields or paste a credential command.");
  }

  function applyCloudCommandToFields() {
    const provider = document.getElementById("kube-platform")?.value;
    if (!["eks", "gke", "aks"].includes(provider)) return;
    const command = document.getElementById("cloud-credential-command")?.value.trim();
    if (!command) {
      resetCloudImport("Fill the required cluster fields or paste a credential command.");
      return;
    }
    try {
      const args = shellWords(command);
      if (provider === "eks") {
        requireCommandPrefix(args, ["aws", "eks", "update-kubeconfig"]);
        setCloudField("cloud-cluster-name-input", commandOption(args, "--name"));
        setCloudField("cloud-region-input", commandOption(args, "--region"));
        setCloudField("cloud-profile-input", commandOption(args, "--profile"));
        setCloudField("cloud-role-input", commandOption(args, "--role-arn"));
      } else if (provider === "gke") {
        requireCommandPrefix(args, ["gcloud", "container", "clusters", "get-credentials"]);
        setCloudField("cloud-cluster-name-input", args[4] && !args[4].startsWith("-") ? args[4] : "");
        setCloudField("cloud-location-input", commandOption(args, "--location", "--region", "--zone", "-z"));
        setCloudField("cloud-project-input", commandOption(args, "--project"));
        setCloudField("cloud-account-input", commandOption(args, "--account"));
      } else {
        requireCommandPrefix(args, ["az", "aks", "get-credentials"]);
        setCloudField("cloud-cluster-name-input", commandOption(args, "--name", "-n"));
        setCloudField("cloud-resource-group-input", commandOption(args, "--resource-group", "-g"));
        setCloudField("cloud-subscription-input", commandOption(args, "--subscription"));
        const admin = document.getElementById("cloud-admin-input");
        if (admin) admin.checked = args.includes("--admin") || args.includes("-a");
      }
      resetCloudImport("Fields filled from the command. Review them, then import the kubeconfig.");
    } catch (error) {
      const status = document.getElementById("cloud-import-status");
      status.className = "notice error cloud-import-status";
      status.textContent = error.message;
    }
  }

  function resetCloudImport(message) {
    const kubeconfig = document.querySelector('[name="kubeconfig"]');
    if (kubeconfig) kubeconfig.value = "";
    const preview = document.getElementById("cloud-preview");
    if (preview) preview.hidden = true;
    const status = document.getElementById("cloud-import-status");
    if (status) {
      status.className = "notice info cloud-import-status";
      status.textContent = message;
    }
  }

  function cloudFieldValue(id) {
    return document.getElementById(id)?.value.trim() || "";
  }

  function setCloudField(id, value) {
    const field = document.getElementById(id);
    if (field) field.value = value || "";
  }

  function addCommandOption(parts, option, value) {
    if (value) parts.push(option, value);
  }

  function requireCommandPrefix(args, prefix) {
    if (!prefix.every((part, index) => args[index]?.toLowerCase() === part)) {
      throw new Error(`Paste a ${prefix.join(" ")} command for this provider.`);
    }
  }

  function commandOption(args, ...names) {
    for (let index = 0; index < args.length; index += 1) {
      for (const name of names) {
        if (args[index] === name) return args[index + 1] || "";
        if (args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
      }
    }
    return "";
  }

  async function importCloudKubeconfig() {
    invalidateConnectionTest();
    const provider = document.getElementById("kube-platform")?.value;
    const command = document.getElementById("cloud-credential-command")?.value.trim();
    const button = document.getElementById("cloud-import-button");
    const status = document.getElementById("cloud-import-status");
    const preview = document.getElementById("cloud-preview");
    if (!command) {
      status.className = "notice error cloud-import-status";
      status.textContent = "Fill the cluster fields or paste a cloud credential command first.";
      return;
    }
    button.disabled = true;
    button.textContent = "Importing…";
    status.className = "notice info cloud-import-status";
    status.textContent = "Contacting the cloud provider and generating a temporary kubeconfig…";
    try {
      const response = await api("/api/v1/kubernetes/import-cloud", {
        method: "POST",
        body: JSON.stringify({ provider, command }),
      });
      document.getElementById("kube-source").value = "upload";
      document.querySelector('[name="kubeconfig"]').value = response.kubeconfig;
      document.querySelector('[name="context"]').value = "";
      const name = document.querySelector('[name="name"]');
      if (!name.value || name.dataset.cloudAutofilled === "true" || name.dataset.openshiftAutofilled === "true" || name.dataset.kubeconfigAutofilled === "true") {
        name.value = `${cloudProviderName(provider)} · ${response.name}`;
        name.dataset.cloudAutofilled = "true";
        delete name.dataset.openshiftAutofilled;
      }
      const policy = document.querySelector('[name="exec_policy"]');
      if (policy) policy.value = "allowlist";
      const allowlist = document.querySelector('[name="exec_allowlist"]');
      if (allowlist) allowlist.value = (response.exec_allowlist || []).join(", ");
      const environment = document.querySelector('[name="environment"]');
      if (environment && response.environment) {
        environment.value = Object.entries(response.environment).map(([key, value]) => `${key}=${value}`).join("\n");
      }
      document.getElementById("cloud-cluster").textContent = response.name;
      document.getElementById("cloud-auth").textContent = (response.exec_allowlist || []).join(", ") || "Embedded credentials";
      if (preview) preview.hidden = false;
      status.className = "notice info cloud-import-status";
      status.textContent = "Kubeconfig imported. Keep the cloud CLI session signed in so its credential helper can refresh tokens.";
    } catch (error) {
      if (preview) preview.hidden = true;
      status.className = "notice error cloud-import-status";
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Import kubeconfig";
    }
  }

  function cloudProviderName(provider) {
    return { eks: "Amazon EKS", gke: "Google GKE", aks: "Azure AKS" }[provider] || "Kubernetes";
  }

  function updateOpenShiftLogin() {
    if (document.getElementById("kube-platform")?.value !== "openshift") return;
    const command = document.getElementById("oc-login-command")?.value || "";
    try {
      const parsed = parseOCLogin(command);
      if (!parsed) {
        updateOpenShiftManual(true);
        return;
      }
      document.getElementById("openshift-server-input").value = parsed.server;
      document.getElementById("openshift-auth-method").value = parsed.token ? "token" : "password";
      document.getElementById("openshift-token-input").value = parsed.token;
      document.getElementById("openshift-username-input").value = parsed.username;
      document.getElementById("openshift-password-input").value = parsed.password;
      document.getElementById("openshift-insecure-input").checked = parsed.insecure;
      updateOpenShiftManual(true);
    } catch (error) {
      const preview = document.getElementById("openshift-preview");
      const kubeconfig = document.querySelector('[name="kubeconfig"]');
      const status = document.getElementById("openshift-login-status");
      if (preview) preview.hidden = true;
      if (kubeconfig) kubeconfig.value = "";
      if (status) {
        status.className = "notice error openshift-login-status";
        status.textContent = error.message;
      }
    }
  }

  function updateOpenShiftManual(preserveCommand = false) {
    if (document.getElementById("kube-platform")?.value !== "openshift") return;
    const method = document.getElementById("openshift-auth-method")?.value || "token";
    const tokenField = document.getElementById("openshift-token-field");
    const usernameField = document.getElementById("openshift-username-field");
    const passwordField = document.getElementById("openshift-password-field");
    if (tokenField) tokenField.hidden = method !== "token";
    if (usernameField) usernameField.hidden = method !== "password";
    if (passwordField) passwordField.hidden = method !== "password";
    const login = {
      server: document.getElementById("openshift-server-input")?.value.trim() || "",
      token: method === "token" ? document.getElementById("openshift-token-input")?.value.trim() || "" : "",
      username: method === "password" ? document.getElementById("openshift-username-input")?.value.trim() || "" : "",
      password: method === "password" ? document.getElementById("openshift-password-input")?.value || "" : "",
      insecure: Boolean(document.getElementById("openshift-insecure-input")?.checked),
      certificateAuthority: "",
    };
    const status = document.getElementById("openshift-login-status");
    const preview = document.getElementById("openshift-preview");
    const kubeconfig = document.querySelector('[name="kubeconfig"]');
    if (!login.server || (method === "token" ? !login.token : !(login.username && login.password))) {
      if (preview) preview.hidden = true;
      if (kubeconfig) kubeconfig.value = "";
      status.className = "notice info openshift-login-status";
      status.textContent = "Enter the API server and authentication details, or paste an oc login command.";
      return;
    }
    let serverURL;
    try {
      serverURL = new URL(login.server);
      if (!["https:", "http:"].includes(serverURL.protocol)) throw new Error();
    } catch {
      if (preview) preview.hidden = true;
      if (kubeconfig) kubeconfig.value = "";
      status.className = "notice error openshift-login-status";
      status.textContent = "Enter a valid HTTP or HTTPS OpenShift API server URL.";
      return;
    }
    login.server = serverURL.toString().replace(/\/$/, "");
    document.getElementById("openshift-server-input").value = login.server;
    document.getElementById("kube-source").value = "upload";
    if (kubeconfig) kubeconfig.value = openShiftKubeconfig(login);
    document.querySelector('[name="context"]').value = "runwake-openshift";
    const name = document.querySelector('[name="name"]');
    if (name && (!name.value || name.dataset.openshiftAutofilled === "true" || name.dataset.cloudAutofilled === "true" || name.dataset.kubeconfigAutofilled === "true")) {
      name.value = openShiftConnectionName(login.server);
      name.dataset.openshiftAutofilled = "true";
      delete name.dataset.cloudAutofilled;
      delete name.dataset.kubeconfigAutofilled;
    }
    if (!preserveCommand) document.getElementById("oc-login-command").value = openShiftLoginCommand(login);
    document.getElementById("openshift-server").textContent = login.server;
    document.getElementById("openshift-auth").textContent = login.token ? "Bearer token" : `Username · ${login.username}`;
    if (preview) preview.hidden = false;
    const lifetime = openShiftCredentialMessage(login);
    status.className = `notice ${lifetime.kind} openshift-login-status`;
    status.textContent = lifetime.message;
  }

  function openShiftLoginCommand(login) {
    const parts = ["oc", "login", "--server", login.server];
    if (login.token) parts.push("--token", login.token);
    else parts.push("--username", login.username, "--password", login.password);
    if (login.insecure) parts.push("--insecure-skip-tls-verify=true");
    return parts.map(commandShellQuote).join(" ");
  }

  function parseOCLogin(command) {
    const value = String(command || "").trim();
    if (!value) return null;
    const args = shellWords(value);
    const loginIndex = args.findIndex((item, index) => item === "login" && index > 0 && /(^|[/\\])oc(?:\.exe)?$/i.test(args[index - 1]));
    if (loginIndex < 0) throw new Error("Paste a complete oc login command.");
    const result = { server: "", token: "", username: "", password: "", insecure: false, certificateAuthority: "" };
    const options = {
      "--server": "server",
      "-s": "server",
      "--token": "token",
      "-u": "username",
      "--username": "username",
      "-p": "password",
      "--password": "password",
      "--certificate-authority": "certificateAuthority",
      "--ca": "certificateAuthority",
    };
    for (let index = loginIndex + 1; index < args.length; index += 1) {
      const argument = args[index];
      if (/^https?:\/\//i.test(argument) && !result.server) {
        result.server = argument;
        continue;
      }
      const equals = argument.match(/^(--[a-z-]+)=(.*)$/i);
      const option = equals ? equals[1] : argument;
      const key = options[option];
      if (key) {
        const optionValue = equals ? equals[2] : args[++index];
        if (!optionValue) throw new Error(`${option} needs a value.`);
        result[key] = optionValue;
        continue;
      }
      if (option === "--insecure-skip-tls-verify" || option === "--insecure-skip-tls-verify=true") {
        result.insecure = !equals || equals[2] !== "false";
      }
    }
    if (!result.server) throw new Error("The oc login command does not include an OpenShift server.");
    let serverURL;
    try {
      serverURL = new URL(result.server);
    } catch {
      throw new Error("The OpenShift server URL is not valid.");
    }
    if (!["https:", "http:"].includes(serverURL.protocol)) throw new Error("The OpenShift server must use HTTP or HTTPS.");
    result.server = serverURL.toString().replace(/\/$/, "");
    if (!result.token && !(result.username && result.password)) {
      throw new Error("The command must include a token or both username and password.");
    }
    return result;
  }

  function shellWords(command) {
    const words = [];
    let current = "";
    let quote = "";
    let escaped = false;
    for (const character of command.replace(/\\\r?\n/g, " ")) {
      if (escaped) {
        current += character;
        escaped = false;
      } else if (character === "\\" && quote !== "'") {
        escaped = true;
      } else if (quote) {
        if (character === quote) quote = "";
        else current += character;
      } else if (character === "'" || character === '"') {
        quote = character;
      } else if (/\s/.test(character)) {
        if (current) {
          words.push(current);
          current = "";
        }
      } else {
        current += character;
      }
    }
    if (escaped || quote) throw new Error("The command has an unfinished quote or escape.");
    if (current) words.push(current);
    return words;
  }

  function commandShellQuote(value) {
    const text = String(value);
    if (/^[A-Za-z0-9_./:@~+=,-]+$/.test(text)) return text;
    return `'${text.replaceAll("'", `'\\''`)}'`;
  }

  function openShiftKubeconfig(login) {
    const clusterTLS = login.insecure
      ? "    insecure-skip-tls-verify: true"
      : login.certificateAuthority
        ? `    certificate-authority: ${JSON.stringify(login.certificateAuthority)}`
        : "";
    const credentials = login.token
      ? `    token: ${JSON.stringify(login.token)}`
      : `    username: ${JSON.stringify(login.username)}\n    password: ${JSON.stringify(login.password)}`;
    return `apiVersion: v1
kind: Config
clusters:
- name: runwake-openshift
  cluster:
    server: ${JSON.stringify(login.server)}
${clusterTLS}
users:
- name: runwake-openshift
  user:
${credentials}
contexts:
- name: runwake-openshift
  context:
    cluster: runwake-openshift
    user: runwake-openshift
current-context: runwake-openshift
`;
  }

  function openShiftConnectionName(server) {
    try {
      return `OpenShift · ${new URL(server).hostname}`;
    } catch {
      return "OpenShift cluster";
    }
  }

  function openShiftCredentialMessage(login) {
    if (!login.token) {
      return { kind: "info", message: "Username and password detected." };
    }
    const expiry = jwtExpiry(login.token);
    if (!expiry) {
      return { kind: "warning", message: "Token detected. Its expiry cannot be verified and it may be short-lived; this connection will stop working when the token expires." };
    }
    const remaining = expiry.getTime() - Date.now();
    if (remaining <= 0) {
      return { kind: "error", message: `This token appears to have expired ${formatTime(expiry.toISOString(), true)}.` };
    }
    const shortLived = remaining < 24 * 60 * 60 * 1000;
    return {
      kind: shortLived ? "warning" : "info",
      message: `Token expiry detected: ${formatTime(expiry.toISOString(), true)}${shortLived ? ". This is a short-lived token." : "."}`,
    };
  }

  function jwtExpiry(token) {
    const pieces = String(token).split(".");
    if (pieces.length !== 3) return null;
    try {
      const base64 = pieces[1].replaceAll("-", "+").replaceAll("_", "/");
      const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
      if (!Number.isFinite(payload.exp)) return null;
      return new Date(payload.exp * 1000);
    } catch {
      return null;
    }
  }
  function updateNamespaceField() {
    const field = document.getElementById("namespace-field");
    if (field) field.hidden = document.getElementById("namespace-mode")?.value !== "selected";
  }
  async function readKubeconfigFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const textarea = document.querySelector('[name="kubeconfig"]');
    if (textarea) {
      textarea.value = await file.text();
      inferKubeconfigMetadata();
    }
  }

  function inferKubeconfigMetadata() {
    if (document.getElementById("kube-platform")?.value !== "kubernetes") return;
    const content = document.querySelector('[name="kubeconfig"]')?.value || "";
    const match = content.match(/^\s*current-context\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m);
    if (!match) return;
    const currentContext = match[1].trim();
    const context = document.querySelector('[name="context"]');
    if (context && (!context.value || context.dataset.computed === "true")) {
      context.value = currentContext;
      context.dataset.computed = "true";
    }
    const friendly = currentContext.split(/[/:]/).filter(Boolean).at(-1) || currentContext;
    updateComputedConnectionName("Kubernetes", friendly, "kubeconfigAutofilled");
  }

  function updateComputedConnectionName(provider, target, marker) {
    if (!target) return;
    const name = document.querySelector('[name="name"]');
    if (!name) return;
    const autoMarkers = ["openshiftAutofilled", "cloudAutofilled", "kubeconfigAutofilled", "dockerAutofilled"];
    const wasComputed = autoMarkers.some(key => name.dataset[key] === "true");
    if (!name.value || wasComputed) {
      name.value = `${provider} · ${target}`;
      for (const key of autoMarkers) delete name.dataset[key];
      name.dataset[marker] = "true";
    }
  }

  function updateDockerConnectionName() {
    const endpoint = document.querySelector('[name="endpoint"]')?.value.trim();
    if (!endpoint) return;
    let target = "Local";
    if (document.getElementById("docker-transport")?.value === "ssh") {
      const profileID = document.getElementById("ssh-profile-select")?.value;
      target = state.sshProfiles.find(item => item.id === profileID)?.host || "SSH host";
    } else if (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://")) {
      try {
        target = new URL(endpoint.replace(/^tcp:/, "http:")).hostname || "Docker";
      } catch {
        target = endpoint;
      }
    }
    updateComputedConnectionName("Docker", target, "dockerAutofilled");
  }

  function invalidateConnectionTest() {
    const form = document.getElementById("connection-form");
    if (!form || form.dataset.testPassed === "not-required") return;
    form.dataset.testPassed = "false";
    const add = modalRoot.querySelector('[data-action="submit-connection"]');
    if (add) add.disabled = true;
    const gate = document.getElementById("add-connection-gate");
    if (gate) {
      const agentSSH = form.querySelector('[name="kind"]')?.value === "agent";
      gate.classList.add("locked");
      gate.tabIndex = 0;
      gate.dataset.tooltip = agentSSH ? "Test the SSH target successfully before installing." : "Test the connection successfully before adding it.";
    }
    updateConnectionTestState("idle", "Ready to test");
  }

  function updateConnectionTestState(stateName, message) {
    const status = document.getElementById("connection-test-state");
    if (!status) return;
    status.className = `connection-test-state ${stateName}`;
    status.querySelector("strong").textContent = message;
  }

  function cloudKubeconfigReady(kind, data) {
    const platform = document.getElementById("kube-platform")?.value;
    if (kind !== "kubernetes" || !["eks", "gke", "aks"].includes(platform) || String(data.get("kubeconfig") || "").trim()) return true;
    const status = document.getElementById("cloud-import-status");
    status.className = "notice error cloud-import-status";
    status.textContent = "Import the cloud kubeconfig before testing the connection.";
    return false;
  }

  function directConnectionPayload(data, skipTest) {
    const kind = String(data.get("kind"));
    const payload = { name: String(data.get("name") || "").trim(), kind, skip_test: skipTest };
    const useSSH = String(data.get("transport")) === "ssh";
    if (kind === "kubernetes") {
      payload.kubernetes = {
        kubeconfig_source: String(data.get("kubeconfig_source") || "path"),
        kubeconfig_path: String(data.get("kubeconfig_path") || "").trim(),
        kubeconfig: String(data.get("kubeconfig") || ""),
        context: String(data.get("context") || "").trim(),
        kubectl_path: String(data.get("kubectl_path") || "").trim(),
        namespace_mode: String(data.get("namespace_mode") || "all"),
        namespaces: listFrom(data.get("namespaces")),
        exec_policy: String(data.get("exec_policy") || "allowlist"),
        exec_allowlist: listFrom(data.get("exec_allowlist")),
        environment: environmentFrom(data.get("environment")),
      };
    } else {
      payload.access_mode = String(data.get("access_mode") || "read_only");
      let endpoint = String(data.get("endpoint") || "").trim();
      if (useSSH && endpoint.startsWith("/")) endpoint = `unix://${endpoint}`;
      payload.docker = {
        endpoint,
        tls_server_name: String(data.get("tls_server_name") || "").trim(),
        tls_ca: String(data.get("tls_ca") || ""),
        tls_cert: String(data.get("tls_cert") || ""),
        tls_key: String(data.get("tls_key") || ""),
      };
    }
    if (useSSH) payload.ssh_profile_id = selectedSSHProfileID(data);
    if (String(data.get("http_proxy_mode") || "none") === "http") {
      payload.http_proxy = {
        url: String(data.get("http_proxy_url") || "").trim(),
        no_proxy: listFrom(data.get("http_proxy_no_proxy")),
      };
    }
    return payload;
  }

  function selectedSSHProfileID(data) {
    const id = String(data.get("ssh_profile_id") || "").trim();
    if (!id || id === "__new__") throw new Error("Save and select an SSH profile first.");
    return id;
  }

  async function testDraftConnection() {
    const form = document.getElementById("connection-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const kind = String(data.get("kind"));
    if (kind === "agent" || !cloudKubeconfigReady(kind, data)) return;
    let payload;
    try {
      payload = directConnectionPayload(data, false);
    } catch (error) {
      updateConnectionTestState("bad", error.message);
      return;
    }
    const test = modalRoot.querySelector('[data-action="test-draft-connection"]');
    const add = modalRoot.querySelector('[data-action="submit-connection"]');
    test.disabled = true;
    test.textContent = "Testing…";
    add.disabled = true;
    updateConnectionTestState("testing", "Testing connection…");
    try {
      const response = await api("/api/v1/connections/test", { method: "POST", body: JSON.stringify(payload) });
      form.dataset.testPassed = "true";
      const detail = response.details?.server_version ? ` · ${response.details.server_version}` : "";
      updateConnectionTestState("good", `${response.message || "Connection successful"}${detail}`);
      const gate = document.getElementById("add-connection-gate");
      gate.classList.remove("locked");
      gate.removeAttribute("data-tooltip");
      gate.removeAttribute("tabindex");
      add.disabled = false;
    } catch (error) {
      form.dataset.testPassed = "false";
      updateConnectionTestState("bad", error.message);
    } finally {
      test.disabled = false;
      test.textContent = "Test";
    }
  }

  async function testAgentSSH() {
    const form = document.getElementById("connection-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    if (String(data.get("setup_method")) !== "ssh") return;
    const test = modalRoot.querySelector('[data-action="test-agent-ssh"]');
    const install = modalRoot.querySelector('[data-action="submit-connection"]');
    let profileID;
    try {
      profileID = selectedSSHProfileID(data);
    } catch (error) {
      updateConnectionTestState("bad", error.message);
      return;
    }
    const payload = {
      ssh_profile_id: profileID,
      kind: String(data.get("agent_kind") || "kubernetes"),
      remote_kubeconfig_path: String(data.get("remote_kubeconfig_path") || "").trim(),
      remote_kubectl_path: String(data.get("remote_kubectl_path") || "").trim(),
      docker_socket_path: String(data.get("docker_socket_path") || "").trim(),
    };
    test.disabled = true;
    test.textContent = "Testing…";
    install.disabled = true;
    updateConnectionTestState("testing", "Testing SSH target…");
    try {
      const response = await api("/api/v1/ssh/test", { method: "POST", body: JSON.stringify(payload) });
      form.dataset.testPassed = "true";
      const detail = response.details?.server_version ? ` · ${response.details.server_version}` : "";
      updateConnectionTestState("good", `${response.message || "SSH target is ready"}${detail}`);
      const gate = document.getElementById("add-connection-gate");
      gate.classList.remove("locked");
      gate.removeAttribute("data-tooltip");
      gate.removeAttribute("tabindex");
      install.disabled = false;
    } catch (error) {
      form.dataset.testPassed = "false";
      updateConnectionTestState("bad", error.message);
    } finally {
      test.disabled = false;
      test.textContent = "Test";
    }
  }

  async function submitConnection() {
    const form = document.getElementById("connection-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const kind = String(data.get("kind"));
    if (kind === "agent") {
      const mode = String(data.get("mode") || "persistent");
      const agentKind = String(data.get("agent_kind") || "kubernetes");
      const setupMethod = String(data.get("setup_method") || "instructions");
      if (setupMethod === "ssh" && form.dataset.testPassed !== "true") return;
      const payload = {
        name: String(data.get("name") || "").trim(),
        kind: agentKind,
        mode,
        server_url: String(data.get("server_url") || "").trim(),
        image: String(data.get("image") || "").trim(),
        namespace: String(data.get("agent_namespace") || "runwake-system").trim(),
        namespaces: agentKind === "kubernetes" && String(data.get("namespace_mode")) === "selected" ? listFrom(data.get("namespaces")) : [],
        ttl_seconds: mode === "temporary" ? Math.max(60, Number(data.get("ttl_minutes") || 30) * 60) : 0,
      };
      if (setupMethod === "ssh") {
        payload.ssh_profile_id = selectedSSHProfileID(data);
        payload.remote_kubeconfig_path = String(data.get("remote_kubeconfig_path") || "").trim();
        payload.remote_kubectl_path = String(data.get("remote_kubectl_path") || "").trim();
        payload.docker_socket_path = String(data.get("docker_socket_path") || "").trim();
      }
      const button = modalRoot.querySelector('[data-action="submit-connection"]');
      button.disabled = true;
      button.textContent = setupMethod === "ssh" ? "Installing…" : "Generating…";
      try {
        const response = await api("/api/v1/agents/enroll", { method: "POST", body: JSON.stringify(payload) });
        if (response.installed) {
          closeModal();
          toast("Agent installed over SSH");
          await renderConnections();
        } else {
          showAgentSetup(response, payload);
        }
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
        button.textContent = setupMethod === "ssh" ? "Install" : "Create setup";
      }
      return;
    }
    if (form.dataset.testPassed !== "true") return;
    const payload = directConnectionPayload(data, true);
    const button = modalRoot.querySelector('[data-action="submit-connection"]');
    button.disabled = true;
    button.textContent = "Adding…";
    try {
      await api("/api/v1/connections", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      toast("Connection added");
      await renderConnections();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Add";
    }
  }

  function showAgentModal(connection) {
    const settings = state.settings || {};
    showModal(`
      <div class="modal-header"><div><h2 class="modal-title">Deploy remote agent</h2></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body"><form id="agent-form">
        <div class="form-grid">
          <label>Connection name<input class="field" name="name" value="${html(connection.name)} agent" required></label>
          <label>Run mode<select id="agent-mode" name="mode"><option value="persistent">Persistent</option><option value="temporary">Temporary</option></select></label>
          <label class="full">Runwake server URL<input class="field mono" name="server_url" type="url" value="${html(settings.public_url || "")}" placeholder="https://runwake.example.com" required><span class="hint">Must be reachable from this cluster.</span></label>
          <label class="full">Agent image<input class="field mono" name="image" value="${html(settings.default_agent_image || "")}" placeholder="registry.example.com/runwake-agent:0.1.0" required></label>
          <label>Agent namespace<input class="field mono" name="namespace" value="runwake-system" required></label>
          <label>Workload namespace scope<select id="agent-namespace-mode" name="namespace_mode"><option value="all">All permitted namespaces</option><option value="selected">Selected namespaces</option></select></label>
          <label id="agent-namespaces-field" class="full" hidden>Namespaces<input class="field" name="namespaces" placeholder="payments, platform"></label>
          <label id="agent-ttl-field" hidden>Lifetime in minutes<input class="field" name="ttl_minutes" type="number" min="1" value="30"></label>
        </div>
        <div class="form-section"><label class="choice full-choice"><input type="checkbox" name="manual"><span><span class="choice-title">Generate manifest only</span><span class="choice-copy">Return YAML without applying it.</span></span></label></div>
        <div class="notice mt-16">The generated role can read Pods, Pod logs, Events, Deployments, StatefulSets, DaemonSets, Jobs, and Pod metrics when metrics.k8s.io is installed. It cannot read Secrets or modify application resources.</div>
      </form></div>
      <div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="submit-agent" data-id="${html(connection.id)}">Deploy agent</button></div>`, "wide");
    document.getElementById("agent-mode").addEventListener("change", updateAgentTTL);
    document.getElementById("agent-namespace-mode").addEventListener("change", updateAgentNamespaceField);
    updateAgentTTL();
    updateAgentNamespaceField();
  }

  function updateAgentTTL() {
    const field = document.getElementById("agent-ttl-field");
    if (field) field.hidden = document.getElementById("agent-mode")?.value !== "temporary";
  }
  function updateAgentNamespaceField() {
    const field = document.getElementById("agent-namespaces-field");
    if (field) field.hidden = document.getElementById("agent-namespace-mode")?.value !== "selected";
  }

  async function submitAgent(connectionID) {
    const form = document.getElementById("agent-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const mode = String(data.get("mode"));
    const payload = {
      name: String(data.get("name") || "").trim(),
      mode,
      server_url: String(data.get("server_url") || "").trim(),
      image: String(data.get("image") || "").trim(),
      namespace: String(data.get("namespace") || "runwake-system").trim(),
      namespaces: String(data.get("namespace_mode")) === "selected" ? listFrom(data.get("namespaces")) : [],
      ttl_seconds: mode === "temporary" ? Math.max(60, Number(data.get("ttl_minutes") || 30) * 60) : 0,
      manual: data.has("manual"),
    };
    const button = modalRoot.querySelector('[data-action="submit-agent"]');
    button.disabled = true;
    button.textContent = payload.manual ? "Generating…" : "Deploying…";
    try {
      const response = await api(`/api/v1/connections/${encodeURIComponent(connectionID)}/agent`, { method: "POST", body: JSON.stringify(payload) });
      if (response.manifest) {
        showKubernetesAgentSetup(response.manifest, response.teardown_manifest || "");
      } else {
        closeModal();
        toast("Agent resources applied");
        await renderConnections();
      }
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Deploy agent";
    }
  }

  function showKubernetesAgentSetup(installManifest, teardownManifest) {
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Kubernetes agent setup</h2><p class="modal-copy">The credential is embedded in the Secret and is shown only in this response. Store the removal manifest with your operational notes.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="code-section"><div class="section-head"><h3 class="section-title">Install</h3><button class="btn small" data-action="copy-code" data-target="agent-install-manifest">Copy</button></div><pre id="agent-install-manifest" class="code-block"></pre></div>
        ${teardownManifest ? `<div class="code-section"><div class="section-head"><h3 class="section-title">Remove</h3><button class="btn small" data-action="copy-code" data-target="agent-remove-manifest">Copy</button></div><pre id="agent-remove-manifest" class="code-block"></pre></div>` : ""}
      </div>
      <div class="modal-footer"><button class="btn primary" data-action="finish-agent-setup">Done</button></div>`, "wide");
    document.getElementById("agent-install-manifest").textContent = installManifest;
    if (teardownManifest) document.getElementById("agent-remove-manifest").textContent = teardownManifest;
  }

  function shellQuote(value) {
    return `'${String(value).replaceAll("'", `'"'"'`)}'`;
  }

  function showAgentSetup(response, request) {
    if (request.kind === "kubernetes") {
      showKubernetesAgentSetup(response.apply_manifest || "", response.teardown_manifest || "");
      return;
    }
    const environment = response.environment || {};
    const containerName = `runwake-agent-${String(response.connection?.id || "remote").slice(-8)}`;
    const flags = response.mode === "temporary" ? `--rm --name ${containerName}` : `-d --restart unless-stopped --name ${containerName}`;
    const continuation = " \\\n  ";
    const envFlags = Object.entries(environment).map(([key, value]) => `-e ${key}=${shellQuote(value)}`).join(continuation);
    const command = [
      `docker run ${flags}`,
      "--read-only --cap-drop ALL --security-opt no-new-privileges",
      `--group-add "$(stat -c '%g' /var/run/docker.sock)"`,
      "-v /var/run/docker.sock:/var/run/docker.sock",
      envFlags,
      shellQuote(request.image),
    ].filter(Boolean).join(continuation);
    const removeCommand = response.mode === "temporary" ? `docker stop ${containerName}` : `docker rm -f ${containerName}`;
    const envText = Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n");
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Docker agent setup</h2><p class="modal-copy">Run this on the Docker host. The token is shown once. Docker socket access is highly privileged; use a dedicated host or socket proxy when the trust boundary requires it.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="code-section"><div class="section-head"><h3 class="section-title">Start</h3><button class="btn small" data-action="copy-code" data-target="docker-agent-command">Copy</button></div><pre id="docker-agent-command" class="code-block"></pre></div>
        <div class="code-section"><div class="section-head"><h3 class="section-title">Remove</h3><button class="btn small" data-action="copy-code" data-target="docker-agent-remove">Copy</button></div><pre id="docker-agent-remove" class="code-block"></pre></div>
        <details class="disclosure"><summary>Environment variables</summary><pre id="docker-agent-environment" class="code-block"></pre></details>
        <div class="notice mt-16">The command maps the Docker socket group into the non-root agent container on Linux. Adjust the group mapping for hosts that expose the socket differently.</div>
      </div>
      <div class="modal-footer"><button class="btn primary" data-action="finish-agent-setup">Done</button></div>`, "wide");
    document.getElementById("docker-agent-command").textContent = command;
    document.getElementById("docker-agent-remove").textContent = removeCommand;
    document.getElementById("docker-agent-environment").textContent = envText;
  }

  function showModal(content, className = "") {
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="backdrop"><section class="modal ${className}" role="dialog" aria-modal="true">${content}</section></div>`;
  }
  function closeModal() { modalRoot.innerHTML = ""; }

  function showEditConnection(connection) {
    const dockerAccess = connection.kind === "docker" ? `
      <div class="connection-edit-access">
        <span class="connection-edit-label">Docker permissions</span>
        ${renderFixedChoiceMenu("connection-access-mode", "access_mode", "Docker permissions", [
          { value: "read_only", label: "View only", description: "Inspect workloads without changing them." },
          { value: "manage", label: "Manage containers", description: "Restart or delete containers and restart Compose projects." },
        ], connection.access_mode === "manage" ? "manage" : "read_only")}
        <span class="hint">Runwake enforces this choice. The Docker endpoint itself remains privileged.</span>
      </div>` : "";
    showModal(`<div class="modal-header">
        <div><h2 id="edit-connection-title" class="modal-title">Edit connection</h2></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <form id="edit-connection-form">
          <label>Connection name<input class="field" name="name" value="${html(connection.name)}" required></label>
          ${dockerAccess}
          <div class="connection-edit-route">
            <span>${html(connection.kind === "kubernetes" ? "Kubernetes" : "Docker")}</span>
            <strong title="${html(connectionScope(connection))}">${html(connectionScope(connection))}</strong>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="save-connection-edit" data-id="${html(connection.id)}">Save</button>
      </div>`, "edit-connection-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "edit-connection-title");
    const input = modalRoot.querySelector('[name="name"]');
    input?.focus();
    input?.select();
  }

  async function saveConnectionEdit(id) {
    const form = document.getElementById("edit-connection-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const name = String(data.get("name") || "").trim();
    const accessMode = data.has("access_mode") ? String(data.get("access_mode")) : undefined;
    const button = modalRoot.querySelector('[data-action="save-connection-edit"]');
    if (!button) return;
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await api(`/api/v1/connections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name, ...(accessMode ? { access_mode: accessMode } : {}) }) });
      state.workloads = state.workloads.filter(item => item.connection_id !== id);
      state.workloadCachedConnections.delete(id);
      state.workloadPendingConnections.delete(id);
      state.workloadObservedAt.delete(id);
      closeModal();
      toast("Connection updated");
      await renderConnections();
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw error;
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Save";
    }
  }

  function showRestartDockerContainerConfirmation(connectionID, containerID, name) {
    closeTopologyContextMenu();
    showModal(`<div class="modal-header">
        <div><h2 id="restart-container-title" class="modal-title">Restart container?</h2><p class="modal-copy">Docker will stop and start this container.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="runtime-action-confirmation">
          <span class="runtime-action-mark" aria-hidden="true">↻</span>
          <div><strong>${html(name)}</strong><p>Traffic may be interrupted while the container restarts. Its restart policy remains unchanged.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn primary" data-action="confirm-restart-docker-container" data-connection="${html(connectionID)}" data-container="${html(containerID)}" data-name="${html(name)}">Restart</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "restart-container-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  function showRestartComposeProjectConfirmation(connectionID, project) {
    closeTopologyContextMenu();
    const count = state.workloads.filter(item => item.connection_id === connectionID && composeProjectName(item) === project).length;
    showModal(`<div class="modal-header">
        <div><h2 id="restart-compose-title" class="modal-title">Restart Compose project?</h2><p class="modal-copy">Docker will restart every container currently in this project.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="runtime-action-confirmation">
          <span class="runtime-action-mark" aria-hidden="true">↻</span>
          <div><strong>${html(project)}</strong><p>${count ? `${count} observed container${count === 1 ? "" : "s"} will be restarted.` : "All matching containers reported by Docker will be restarted."} Service traffic may be interrupted.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn primary" data-action="confirm-restart-compose-project" data-connection="${html(connectionID)}" data-project="${html(project)}">Restart project</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "restart-compose-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  function showDeleteDockerContainerConfirmation(connectionID, containerID, name) {
    closeTopologyContextMenu();
    showModal(`<div class="modal-header">
        <div><h2 id="delete-container-title" class="modal-title">Delete container?</h2><p class="modal-copy">This force-removes the container and cannot be undone.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(name)}</strong><p>Docker will stop the container if needed, then remove it. Compose tooling may recreate it later.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn destructive" data-action="confirm-delete-docker-container" data-connection="${html(connectionID)}" data-container="${html(containerID)}" data-name="${html(name)}">Delete container</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "delete-container-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  async function performDockerRuntimeAction(button, options) {
    if (!button) return;
    const errorNotice = document.getElementById("docker-action-error");
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = options.pendingLabel;
    if (errorNotice) {
      errorNotice.hidden = true;
      errorNotice.textContent = "";
    }
    try {
      const response = await api(options.path, options.request);
      if (options.removeContainerID) {
        state.workloads = state.workloads.filter(item => item.uid !== options.removeContainerID || item.connection_id !== options.connectionID);
      }
      state.workloadCachedConnections.delete(options.connectionID);
      state.workloadPendingConnections.add(options.connectionID);
      closeModal();
      toast(options.successMessage(response));
      const route = routeInfo();
      if (route.path === "/workloads") {
        refreshWorkloads([options.connectionID]);
      } else if (route.path === "/topology") {
        await refreshTopology({
          connection_id: route.params.get("connection_id") || "",
          project: route.params.get("project") || "",
          focus: options.removeContainerID ? "" : route.params.get("focus") || "",
        });
      }
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw error;
      if (errorNotice) {
        errorNotice.textContent = error.message;
        errorNotice.hidden = false;
      }
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  function showDeleteConnectionConfirmation(connection) {
    const managesAgent = Boolean(connection.deployment);
    const description = managesAgent
      ? "Runwake will first remove the managed agent resources, then delete this connection."
      : "This removes the saved route. It does not stop or modify the runtime.";
    showModal(`<div class="modal-header">
        <div><h2 id="remove-connection-title" class="modal-title">Remove connection?</h2><p class="modal-copy">This action cannot be undone.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(connection.name)}</strong><p>${description}</p></div>
        </div>
        <div id="remove-connection-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn destructive" data-action="confirm-delete-connection" data-id="${html(connection.id)}">Remove</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "remove-connection-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  async function deleteConnection(id) {
    const connection = state.connections.find(item => item.id === id);
    const button = modalRoot.querySelector('[data-action="confirm-delete-connection"]');
    const errorNotice = document.getElementById("remove-connection-error");
    if (!connection || !button) return;
    button.disabled = true;
    button.textContent = "Removing…";
    if (errorNotice) {
      errorNotice.hidden = true;
      errorNotice.textContent = "";
    }
    try {
      await api(`/api/v1/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
      state.connections = state.connections.filter(item => item.id !== connection.id);
      state.workloads = state.workloads.filter(item => item.connection_id !== connection.id);
      state.workloadCachedConnections.delete(connection.id);
      state.workloadPendingConnections.delete(connection.id);
      state.workloadObservedAt.delete(connection.id);
      closeModal();
      toast("Connection removed");
      await renderConnections();
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw error;
      if (errorNotice) {
        errorNotice.textContent = error.message;
        errorNotice.hidden = false;
      }
      button.disabled = false;
      button.textContent = "Remove";
    }
  }

  function showDeleteSSHProfileConfirmation(profile) {
    showModal(`<div class="modal-header">
        <div><h2 id="remove-ssh-profile-title" class="modal-title">Remove SSH profile?</h2><p class="modal-copy">This action cannot be undone.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(profile.name)}</strong><p>Existing connections keep their copy. This removes only the reusable profile.</p></div>
        </div>
        <div id="remove-ssh-profile-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn destructive" data-action="confirm-delete-ssh-profile" data-id="${html(profile.id)}">Remove</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "remove-ssh-profile-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  async function deleteSSHProfile(id) {
    const profile = state.sshProfiles.find(item => item.id === id);
    const button = modalRoot.querySelector('[data-action="confirm-delete-ssh-profile"]');
    const errorNotice = document.getElementById("remove-ssh-profile-error");
    if (!profile || !button) return;
    button.disabled = true;
    button.textContent = "Removing…";
    if (errorNotice) {
      errorNotice.hidden = true;
      errorNotice.textContent = "";
    }
    try {
      await api(`/api/v1/ssh-profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
      state.sshProfiles = state.sshProfiles.filter(item => item.id !== profile.id);
      closeModal();
      toast("SSH profile removed");
      renderSSHProfileSettings();
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw error;
      if (errorNotice) {
        errorNotice.textContent = error.message;
        errorNotice.hidden = false;
      }
      button.disabled = false;
      button.textContent = "Remove";
    }
  }

  function environmentFrom(value) {
    const result = {};
    String(value || "").split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`Environment line ${index + 1} must use KEY=value`);
      const key = line.slice(0, separator).trim();
      const item = line.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Environment line ${index + 1} has an invalid variable name`);
      result[key] = item;
    });
    return result;
  }

  function listFrom(value) {
    return [...new Set(String(value || "").split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
  }
  function connectionName(id) { return state.connections.find(item => item.id === id)?.name || id; }
  function debounce(fn, delay) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
  }

  document.addEventListener("click", async event => {
    if (!event.target.closest(".log-menu-field")) closeLogMenus();
    if (!event.target.closest(".connection-action-menu")) closeConnectionMenus();
    if (!event.target.closest(".topology-context-menu")) closeTopologyContextMenu();
    const nav = event.target.closest("[data-nav]");
    if (nav) { navigate(nav.dataset.nav); return; }
    const topology = event.target.closest("[data-topology]");
    if (topology) {
      const request = JSON.parse(decodeURIComponent(topology.dataset.topology));
      navigate(`/topology?${new URLSearchParams(request).toString()}`);
      return;
    }
    const workload = event.target.closest("[data-workload]");
    if (workload && !event.target.closest("[data-action]")) {
      const request = JSON.parse(decodeURIComponent(workload.dataset.workload));
      navigate(`/activity?${new URLSearchParams(request).toString()}`);
      return;
    }
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action !== "toggle-connection-menu") closeConnectionMenus();
    try {
      switch (action) {
        case "add-connection":
          await Promise.all([state.settings ? Promise.resolve(state.settings) : loadSettings(), state.sshProfilesLoaded ? Promise.resolve(state.sshProfiles) : loadSSHProfiles()]);
          showAddConnection();
          break;
        case "add-connection-kind":
          await Promise.all([state.settings ? Promise.resolve(state.settings) : loadSettings(), state.sshProfilesLoaded ? Promise.resolve(state.sshProfiles) : loadSSHProfiles()]);
          showAddConnection(target.dataset.kind || "kubernetes");
          break;
        case "filter-connections":
          state.connectionFilter = target.dataset.filter || "all";
          drawConnections();
          break;
        case "toggle-connection-menu":
          toggleConnectionMenu(target.closest(".connection-action-menu"));
          break;
        case "edit-connection": {
          const connection = state.connections.find(item => item.id === target.dataset.id);
          if (connection) showEditConnection(connection);
          break;
        }
        case "save-connection-edit":
          await saveConnectionEdit(target.dataset.id);
          break;
        case "view-connection-workloads":
          state.filters.connection = target.dataset.id ? [target.dataset.id] : [];
          state.filters.namespace = [];
          state.filters.status = "";
          state.filters.search = "";
          state.workloadBrowseMode = "auto";
          navigate("/workloads");
          break;
        case "switch-add-kind": showAddConnection(target.dataset.kind); break;
        case "settings-tab":
          state.settingsTab = target.dataset.tab === "ssh" ? "ssh" : "general";
          if (state.settingsTab === "ssh") renderSSHProfileSettings();
          else await renderSettings();
          break;
        case "manage-ssh-profiles":
          closeModal();
          state.settingsTab = "ssh";
          navigate("/settings");
          break;
        case "add-ssh-profile": showSSHProfileModal(); break;
        case "save-ssh-profile": await saveSSHProfile(); break;
        case "save-inline-ssh-profile": await saveInlineSSHProfile(); break;
        case "cancel-inline-ssh": {
          const select = document.getElementById("ssh-profile-select");
          if (select && state.sshProfiles.length) {
            select.value = state.sshProfiles[0].id;
            updateSSHProfileSelection();
            updateDockerConnectionName();
          }
          break;
        }
        case "test-ssh-profile": {
          target.disabled = true;
          target.textContent = "Testing…";
          try {
            const response = await api(`/api/v1/ssh-profiles/${encodeURIComponent(target.dataset.id)}/test`, { method: "POST" });
            toast(response.message || "SSH profile is ready");
          } finally {
            target.disabled = false;
            target.textContent = "Test";
          }
          break;
        }
        case "delete-ssh-profile": {
          const profile = state.sshProfiles.find(item => item.id === target.dataset.id);
          if (profile) showDeleteSSHProfileConfirmation(profile);
          break;
        }
        case "confirm-delete-ssh-profile": await deleteSSHProfile(target.dataset.id); break;
        case "test-draft-connection": await testDraftConnection(); break;
        case "test-agent-ssh": await testAgentSSH(); break;
        case "submit-connection": await submitConnection(); break;
        case "close-modal": closeModal(); break;
        case "backdrop": if (event.target === target) closeModal(); break;
        case "refresh-workloads":
          refreshWorkloads(state.filters.connection);
          break;
        case "load-workload-metrics":
          loadWorkloadMetrics(state.workloadRenderID, state.filters.connection, true);
          break;
        case "show-workload-list":
          state.workloadBrowseMode = "list";
          updateWorkloadView(true);
          break;
        case "show-workload-overview":
          state.filters.search = "";
          state.filters.namespace = [];
          state.workloadBrowseMode = "auto";
          syncWorkloadFilterControls();
          updateWorkloadView(true);
          break;
        case "open-workload-group":
          state.filters.connection = target.dataset.connection ? [target.dataset.connection] : [];
          state.filters.namespace = target.dataset.namespace ? [target.dataset.namespace] : [];
          state.filters.search = target.dataset.search || "";
          state.workloadBrowseMode = target.dataset.level === "connection" ? "auto" : "list";
          syncWorkloadFilterControls();
          updateWorkloadView(true);
          break;
        case "clear-filters":
          state.filters = { search: "", connection: [], namespace: [], status: "" };
          state.workloadBrowseMode = "auto";
          syncWorkloadFilterControls();
          updateWorkloadView(true);
          break;
        case "open-connections": navigate("/connections"); break;
        case "back-workloads": navigate("/workloads"); break;
        case "filter-workloads-from-activity":
          state.filters = {
            search: target.dataset.search || "",
            connection: target.dataset.connection ? [target.dataset.connection] : [],
            namespace: target.dataset.namespace ? [target.dataset.namespace] : [],
            status: "",
          };
          navigate("/workloads");
          break;
        case "filter-workloads-from-topology":
          state.filters = { search: "", connection: target.dataset.connection ? [target.dataset.connection] : [], namespace: [], status: "" };
          navigate("/workloads");
          break;
        case "refresh-topology":
          await refreshTopology({ connection_id: target.dataset.connection || "", project: target.dataset.project || "", focus: target.dataset.focus || "" });
          break;
        case "restart-docker-container":
          showRestartDockerContainerConfirmation(target.dataset.connection || "", target.dataset.container || "", target.dataset.name || "Container");
          break;
        case "delete-docker-container":
          showDeleteDockerContainerConfirmation(target.dataset.connection || "", target.dataset.container || "", target.dataset.name || "Container");
          break;
        case "restart-compose-project":
          showRestartComposeProjectConfirmation(target.dataset.connection || "", target.dataset.project || "");
          break;
        case "confirm-restart-docker-container":
          await performDockerRuntimeAction(target, {
            connectionID: target.dataset.connection || "",
            path: `/api/v1/connections/${encodeURIComponent(target.dataset.connection || "")}/docker/containers/${encodeURIComponent(target.dataset.container || "")}/restart`,
            request: { method: "POST" },
            pendingLabel: "Restarting…",
            successMessage: () => `${target.dataset.name || "Container"} restarted`,
          });
          break;
        case "confirm-delete-docker-container":
          await performDockerRuntimeAction(target, {
            connectionID: target.dataset.connection || "",
            path: `/api/v1/connections/${encodeURIComponent(target.dataset.connection || "")}/docker/containers/${encodeURIComponent(target.dataset.container || "")}?force=true`,
            request: { method: "DELETE" },
            pendingLabel: "Deleting…",
            removeContainerID: target.dataset.container || "",
            successMessage: () => `${target.dataset.name || "Container"} deleted`,
          });
          break;
        case "confirm-restart-compose-project":
          await performDockerRuntimeAction(target, {
            connectionID: target.dataset.connection || "",
            path: `/api/v1/connections/${encodeURIComponent(target.dataset.connection || "")}/docker/compose/restart`,
            request: { method: "POST", body: JSON.stringify({ project: target.dataset.project || "" }) },
            pendingLabel: "Restarting…",
            successMessage: response => `${target.dataset.project || "Compose project"} restarted · ${response?.containers || 0} container${response?.containers === 1 ? "" : "s"}`,
          });
          break;
        case "toggle-topology-node":
          toggleTopologyNode(target.closest(".topology-node"));
          break;
        case "toggle-all-topology-nodes":
          toggleAllTopologyNodes();
          break;
        case "open-topology-project":
          closeTopologyContextMenu();
          navigate(`/topology?${new URLSearchParams({ connection_id: target.dataset.connection || "", project: target.dataset.project || "" }).toString()}`);
          break;
        case "open-topology-connected":
          closeTopologyContextMenu();
          navigate(`/topology?${new URLSearchParams({ connection_id: target.dataset.connection || "", project: target.dataset.project || "", focus: target.dataset.focus || "" }).toString()}`);
          break;
        case "open-topology-logs": {
          const request = JSON.parse(decodeURIComponent(target.dataset.request || ""));
          closeTopologyContextMenu();
          navigate(`/activity?${new URLSearchParams(request).toString()}`);
          break;
        }
        case "toggle-topology-context-node": {
          const node = document.getElementById(target.dataset.node || "");
          closeTopologyContextMenu();
          toggleTopologyNode(node);
          break;
        }
        case "set-all-topology-nodes": {
          const expanded = target.dataset.expanded === "true";
          closeTopologyContextMenu();
          setAllTopologyNodes(expanded);
          break;
        }
        case "filter-topology-node-workloads":
          closeTopologyContextMenu();
          state.filters = {
            search: target.dataset.search || "",
            connection: target.dataset.connection ? [target.dataset.connection] : [],
            namespace: [],
            status: "",
          };
          state.workloadBrowseMode = "list";
          navigate("/workloads");
          break;
        case "copy-topology-node-name":
          await navigator.clipboard.writeText(target.dataset.value || "");
          closeTopologyContextMenu();
          toast("Copied");
          break;
        case "zoom-topology":
          applyTopologyZoom(state.topologyZoom + Number(target.dataset.zoom || 0));
          break;
        case "reset-topology-zoom":
          applyTopologyZoom(1);
          break;
        case "show-full-topology":
          navigate(`/topology?${new URLSearchParams({ connection_id: target.dataset.connection || "", project: target.dataset.project || "" }).toString()}`);
          break;
        case "show-activity-view": {
          const request = JSON.parse(decodeURIComponent(target.dataset.request));
          navigate(`/activity?${new URLSearchParams(request).toString()}`);
          break;
        }
        case "show-metrics-view": {
          const request = JSON.parse(decodeURIComponent(target.dataset.request));
          const query = new URLSearchParams({ ...request, view: "metrics" });
          navigate(`/activity?${query.toString()}`);
          break;
        }
        case "show-topology-view": {
          const request = JSON.parse(decodeURIComponent(target.dataset.topologyRequest));
          navigate(`/topology?${new URLSearchParams(request).toString()}`);
          break;
        }
        case "reconnect-stream": if (state.stream) startActivityStream(state.stream.request); break;
        case "clear-stream": if (state.stream) {
          state.stream.records = [];
          state.stream.seen.clear();
          state.stream.renderedCount = 0;
          state.stream.matchedCount = 0;
          state.stream.matchIndexes = [];
          state.stream.visibleIndexes = [];
          state.stream.activeMatch = -1;
          state.stream.selectedKey = "";
          state.stream.jumpHistory = [];
          state.stream.jumpIndex = -1;
          state.stream.renderedVisibleMax = -1;
          scheduleActivityRender(true);
        } break;
        case "previous-log-match": navigateLogMatch(-1); break;
        case "next-log-match": navigateLogMatch(1); break;
        case "log-jump-back": moveLogJump(-1); break;
        case "log-jump-forward": moveLogJump(1); break;
        case "jump-log-match": jumpToLogIndex(Number(target.dataset.index)); break;
        case "select-log-record": selectLogRecord(Number(target.dataset.index)); break;
        case "format-log-record": formatSelectedLogRecord(Number(target.dataset.index), target.dataset.format); break;
        case "copy-log-record": await copyLogRecord(Number(target.dataset.index)); break;
        case "toggle-log-entry": toggleLogEntry(Number(target.dataset.index)); break;
        case "focus-log-pod":
          if (state.stream) applyLogScope(state.stream.request, target.dataset.pod || "", "");
          break;
        case "focus-log-source":
          if (state.stream) applyLogScope(state.stream.request, target.dataset.pod || "", target.dataset.container || "");
          break;
        case "toggle-log-menu":
          toggleLogMenu(target.closest(".log-menu-field"), undefined, true);
          break;
        case "clear-log-menu-search": {
          const field = target.closest(".log-menu-field");
          const search = field?.querySelector("[data-log-menu-search]");
          if (search) {
            search.value = "";
            filterLogMenuOptions(field, "");
            search.focus();
          }
          break;
        }
        case "select-fixed-choice":
          selectFixedChoice(target);
          break;
        case "select-workload-filter": {
          const field = target.closest(".workload-filter-menu");
          const filter = target.dataset.filter || "";
          const input = field?.querySelector("input[type=hidden]");
          if (!field || !input || !["connection", "namespace", "status"].includes(filter)) break;
          input.value = target.dataset.value || "";
          updateWorkloadFilterMenu(filter, input.value);
          closeLogMenus(true);
          input.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
        case "toggle-workload-filter-option": {
          const field = target.closest(".workload-filter-menu");
          if (!field || field.dataset.multiple !== "true") break;
          const options = [...field.querySelectorAll(".log-menu-option")];
          if (!target.dataset.value) {
            for (const option of options) {
              const selected = !option.dataset.value;
              option.classList.toggle("selected", selected);
              option.setAttribute("aria-selected", String(selected));
            }
          } else {
            target.classList.toggle("selected");
            target.setAttribute("aria-selected", String(target.classList.contains("selected")));
            const allOption = options.find(option => !option.dataset.value);
            allOption?.classList.remove("selected");
            allOption?.setAttribute("aria-selected", "false");
            if (!options.some(option => option.dataset.value && option.classList.contains("selected"))) {
              allOption?.classList.add("selected");
              allOption?.setAttribute("aria-selected", "true");
            }
          }
          updateWorkloadFilterDraftSummary(field);
          break;
        }
        case "clear-workload-filter-draft": {
          const field = target.closest(".workload-filter-menu");
          for (const option of field?.querySelectorAll(".log-menu-option") || []) {
            const selected = !option.dataset.value;
            option.classList.toggle("selected", selected);
            option.setAttribute("aria-selected", String(selected));
          }
          updateWorkloadFilterDraftSummary(field);
          break;
        }
        case "apply-workload-filter": {
          const field = target.closest(".workload-filter-menu");
          const input = field?.querySelector("input[type=hidden]");
          const filter = field?.dataset.workloadFilter || "";
          if (!field || !input || !["connection", "namespace"].includes(filter)) break;
          const values = [...field.querySelectorAll(".log-menu-option.selected")]
            .map(option => option.dataset.value)
            .filter(Boolean);
          input.value = JSON.stringify(values);
          updateWorkloadFilterMenu(filter, values);
          closeLogMenus(true);
          input.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        }
        case "select-log-format":
          selectLogFormat(target.dataset.value || "auto");
          break;
        case "select-log-target": {
          const input = document.getElementById(`stream-${target.dataset.target}`);
          if (input) input.value = target.dataset.value || "";
          closeLogMenus();
          if (state.stream) applyLogScope(state.stream.request);
          break;
        }
        case "reset-log-scope":
          if (state.stream) applyLogScope(state.stream.request, "", "");
          break;
        case "toggle-log-filters": setLogToolPanel("filters"); break;
        case "toggle-log-filter-picker": toggleLogFilterPicker(); break;
        case "add-log-filter": showLogFilter(target.dataset.filter || ""); break;
        case "remove-log-filter": removeLogFilter(target.dataset.filter || ""); break;
        case "toggle-log-inspector": setLogInspector(); break;
        case "toggle-log-formatter": setLogToolPanel("formatter"); break;
        case "toggle-log-shortcuts": setLogToolPanel("shortcuts"); break;
        case "clear-log-filters": clearLogFilters(); break;
        case "reset-log-formatter": resetLogFormatter(); break;
        case "test-connection": {
          target.disabled = true;
          target.textContent = "Testing…";
          const result = await api(`/api/v1/connections/${encodeURIComponent(target.dataset.id)}/test`, { method: "POST" });
          toast(result.message || `Connected${result.details?.server_version ? ` · ${result.details.server_version}` : ""}`);
          target.disabled = false;
          target.textContent = "Test";
          break;
        }
        case "delete-connection": {
          const connection = state.connections.find(item => item.id === target.dataset.id);
          if (connection) showDeleteConnectionConfirmation(connection);
          break;
        }
        case "confirm-delete-connection": await deleteConnection(target.dataset.id); break;
        case "deploy-agent": {
          if (!state.settings) await loadSettings();
          const connection = state.connections.find(item => item.id === target.dataset.id);
          if (connection) showAgentModal(connection);
          break;
        }
        case "submit-agent": await submitAgent(target.dataset.id); break;
        case "copy-code": {
          await navigator.clipboard.writeText(document.getElementById(target.dataset.target)?.textContent || "");
          toast("Copied");
          break;
        }
        case "finish-agent-setup": {
          closeModal();
          toast("Agent connection created");
          await renderConnections();
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof AuthenticationRequired)) toast(error.message, "error");
      if (action === "test-connection") {
        target.disabled = false;
        target.textContent = "Test";
      }
    }
  });

  document.addEventListener("dblclick", event => {
    const node = event.target.closest?.("[data-topology-node]");
    if (!node || event.target.closest("button, a, input, select, textarea")) return;
    event.preventDefault();
    openTopologyNodeView(node);
  });

  document.addEventListener("contextmenu", event => {
    const node = event.target.closest?.("[data-topology-node]");
    if (!node) {
      closeTopologyContextMenu();
      return;
    }
    event.preventDefault();
    showTopologyContextMenu(node, event.clientX, event.clientY);
  });

  document.addEventListener("scroll", () => closeTopologyContextMenu(), true);
  window.addEventListener("resize", () => closeTopologyContextMenu());

  document.addEventListener("keydown", event => {
    const topologyMenu = event.target.closest?.(".topology-context-menu");
    if (topologyMenu) {
      const items = [...topologyMenu.querySelectorAll('[role="menuitem"]')];
      const item = event.target.closest('[role="menuitem"]');
      const itemIndex = items.indexOf(item);
      if (event.key === "Escape") {
        event.preventDefault();
        closeTopologyContextMenu(true);
        return;
      }
      if (item && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        let nextIndex = itemIndex;
        if (event.key === "ArrowDown") nextIndex = (itemIndex + 1) % items.length;
        if (event.key === "ArrowUp") nextIndex = (itemIndex - 1 + items.length) % items.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = items.length - 1;
        items[nextIndex]?.focus();
        return;
      }
    }
    const topologyNode = event.target.closest?.("[data-topology-node]");
    if (topologyNode && !event.target.closest(".topology-context-menu")) {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const bounds = topologyNode.getBoundingClientRect();
        showTopologyContextMenu(topologyNode, bounds.left + Math.min(36, bounds.width / 2), bounds.top + Math.min(44, bounds.height), true);
        return;
      }
      if (event.target === topologyNode && event.key === "Enter") {
        event.preventDefault();
        openTopologyNodeView(topologyNode);
        return;
      }
    }
    if (event.key === "Escape" && modalRoot.childElementCount) {
      closeModal();
      return;
    }
    const connectionMenuField = event.target.closest?.(".connection-action-menu");
    if (connectionMenuField) {
      const menu = connectionMenuField.querySelector(".connection-menu");
      const items = [...connectionMenuField.querySelectorAll('[role="menuitem"]')];
      const item = event.target.closest('[role="menuitem"]');
      const itemIndex = items.indexOf(item);
      if (event.key === "Escape" && menu && !menu.hidden) {
        event.preventDefault();
        closeConnectionMenus(true);
        return;
      }
      if (event.target.matches(".connection-menu-trigger") && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        toggleConnectionMenu(connectionMenuField, true);
        if (event.key === "ArrowUp") requestAnimationFrame(() => items.at(-1)?.focus());
        return;
      }
      if (item && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        let nextIndex = itemIndex;
        if (event.key === "ArrowDown") nextIndex = (itemIndex + 1) % items.length;
        if (event.key === "ArrowUp") nextIndex = (itemIndex - 1 + items.length) % items.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = items.length - 1;
        items[nextIndex]?.focus();
        return;
      }
    }
    if (event.key === "Escape" && document.querySelector(".connection-menu:not([hidden])")) {
      event.preventDefault();
      closeConnectionMenus();
      return;
    }
    const logMenuField = event.target.closest?.(".log-menu-field");
    if (logMenuField) {
      const menu = logMenuField.querySelector(".log-menu");
      const options = [...logMenuField.querySelectorAll(".log-menu-option")].filter(item => !item.hidden);
      const option = event.target.closest(".log-menu-option");
      const optionIndex = options.indexOf(option);
      const menuSearch = event.target.closest("[data-log-menu-search]");
      if (event.key === "Escape" && menu && !menu.hidden) {
        event.preventDefault();
        closeLogMenus(true);
        return;
      }
      if (menuSearch && ["ArrowDown", "ArrowUp"].includes(event.key) && options.length) {
        event.preventDefault();
        options[event.key === "ArrowDown" ? 0 : options.length - 1]?.focus();
        return;
      }
      if (menuSearch && event.key === "Enter" && options.length) {
        event.preventDefault();
        options[0].click();
        return;
      }
      if (event.target.matches(".log-menu-trigger") && event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        toggleLogMenu(logMenuField, true);
        focusLogMenuSearch(logMenuField, event.key);
        return;
      }
      if (event.target.matches(".log-menu-trigger") && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        toggleLogMenu(logMenuField, true);
        const selected = options.find(item => item.classList.contains("selected"));
        (selected || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
        return;
      }
      if (option && options.length && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        let nextIndex = optionIndex;
        if (event.key === "ArrowDown") nextIndex = (optionIndex + 1) % options.length;
        if (event.key === "ArrowUp") nextIndex = (optionIndex - 1 + options.length) % options.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = options.length - 1;
        options[nextIndex]?.focus();
        return;
      }
    }
    if (event.key === "Escape" && document.querySelector(".log-menu:not([hidden])")) {
      event.preventDefault();
      closeLogMenus();
      return;
    }
    const workload = event.target.closest?.("[data-workload]");
    const nativeControl = event.target.closest?.("button, a, input, select, textarea, [contenteditable='true']");
    if (workload && !nativeControl && (event.key === "Enter" || event.key === " ")) workload.click();
    const row = event.target.closest?.(".stream-row");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      selectLogRecord(Number(row.dataset.index));
      return;
    }
    if (!state.stream || routeInfo().path !== "/activity") return;
    const editing = event.target.matches?.("input, textarea, select, [contenteditable='true']");
    const search = document.getElementById("stream-search");
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      search?.focus();
      search?.select();
      return;
    }
    if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      moveLogJump(-1);
      return;
    }
    if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      moveLogJump(1);
      return;
    }
    if (event.target === search && event.key === "Enter") {
      event.preventDefault();
      navigateLogMatch(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.target === search && event.key === "Escape") {
      event.preventDefault();
      search.value = "";
      scheduleActivityRender(true);
      return;
    }
    if (!editing && event.key === "/") {
      event.preventDefault();
      search?.focus();
      return;
    }
    if (!editing && event.key === "?") {
      event.preventDefault();
      setLogToolPanel("shortcuts");
      return;
    }
    if (!editing && event.key === "End") {
      event.preventDefault();
      const follow = document.getElementById("stream-follow");
      if (follow) follow.checked = true;
      scrollLogToLatest();
    }
  });

  window.addEventListener("hashchange", renderRoute);
  renderRoute();
})();
