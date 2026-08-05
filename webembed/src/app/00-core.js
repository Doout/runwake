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
  const personal = window.RunwakePersonal;
  const navigation = window.RunwakeNavigation;

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
    personal: personal?.load() || { sessions: [], views: [], handoffs: [], diagnostics: [], activeSessionId: "" },
    selectedWorkloads: new Set(),
    pendingActivityView: null,
    viewingSessionID: "",
    authenticated: true,
  };

  const WORKLOAD_STREAM_RENDER_MS = 100;
  const WORKLOAD_ROW_HEIGHT = 69;
  const WORKLOAD_ROW_HEIGHT_NARROW = 104;
  const WORKLOAD_OVERSCAN = 8;
  const WORKLOAD_AUTO_METRICS_LIMIT = 2000;
  const WORKLOAD_OVERVIEW_THRESHOLD = 500;
  const WORKLOAD_FILTER_DESKTOP_MEDIA = window.matchMedia("(min-width: 651px)");
  const INVESTIGATION_ACTIONS = new Set([
    "new-investigation",
    "confirm-new-investigation",
    "activate-investigation",
    "close-investigation",
    "delete-investigation",
    "export-investigation",
    "confirm-export-investigation",
    "pin-selected-record",
    "pin-latest-metric",
  ]);
  const actionHandlerRegistry = new Map();

  function registerActionHandler(domain, actions, handler) {
    for (const action of actions) {
      if (actionHandlerRegistry.has(action)) throw new Error(`Duplicate UI action registration: ${action}`);
      actionHandlerRegistry.set(action, { domain, handler });
    }
  }

  async function dispatchAction(action, context) {
    const registration = actionHandlerRegistry.get(action);
    if (!registration) return false;
    await registration.handler(action, context);
    return true;
  }

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

  function savePersonalState(message = "") {
    if (!personal) return false;
    const result = personal.save(state.personal);
    state.personal = result.store;
    if (!result.ok) {
      toast(result.error || "Local workflow data could not be saved.", "error");
      return false;
    }
    if (message) toast(message);
    return true;
  }

  function activeInvestigation() {
    return investigationsAvailable() ? personal?.activeSession(state.personal) || null : null;
  }

  function routeInfo() {
    return navigation.parseRoute(location.hash);
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
          ${investigationsAvailable() ? navButton("investigations", "◎", "Investigations", active) : ""}
          ${navButton("connections", "↔", "Connections", active)}
          ${navButton("settings", "⚙", "Settings", active)}
        </nav>
        <div class="sidebar-foot">
          ${activeInvestigation() ? `<button type="button" class="sidebar-session" data-nav="/investigations"><span aria-hidden="true"></span><strong>${html(activeInvestigation().name)}</strong><small>${activeInvestigation().evidence.length} pinned</small></button>` : ""}
          <button type="button" class="sidebar-command" data-action="open-command-palette"><span>Commands</span><kbd>⌘K</kbd></button>
          <span>${version}</span>
        </div>
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

  function investigationsAvailable() {
    return Boolean(state.meta?.features?.investigations);
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
      if (route.path === "/investigations") {
        if (!investigationsAvailable()) return navigate("/workloads");
        return renderInvestigations();
      }
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
