/* Runwake personal-workflow primitives. No network or server persistence. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RunwakePersonal = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const STORE_KEY = "runwake.personal.v1";
  const STORE_VERSION = 1;
  const MAX_SESSIONS = 20;
  const MAX_EVIDENCE = 500;
  const MAX_DIAGNOSTICS = 200;
  const MAX_STRING = 128 * 1024;
  const PLACEHOLDERS = new Set(["connection", "namespace", "workload", "kind", "pod", "container", "trace_id", "start", "end"]);
  const DEFAULT_REDACTIONS = [
    { name: "Authorization header", source: "(authorization\\s*[:=]\\s*)(?:bearer\\s+)?[^\\s,;]+", flags: "gi", replacement: "$1[REDACTED]" },
    { name: "Cookie", source: "((?:set-)?cookie\\s*[:=]\\s*)[^\\r\\n]+", flags: "gi", replacement: "$1[REDACTED]" },
    { name: "Credential field", source: "((?:token|password|passwd|secret|api[_-]?key|client[_-]?secret)\\s*[:=]\\s*)[^\\s,;}&]+", flags: "gi", replacement: "$1[REDACTED]" },
    { name: "JWT", source: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{8,}\\b", flags: "g", replacement: "[REDACTED_JWT]" },
  ];
  const DEFAULT_HANDOFFS = [
    { id: "grafana", name: "Grafana", template: "", enabled: false },
    { id: "loki", name: "Loki", template: "", enabled: false },
    { id: "tempo", name: "Tempo", template: "", enabled: false },
    { id: "prometheus", name: "Prometheus", template: "", enabled: false },
  ];

  function id(prefix) {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${random}`;
  }

  function emptyStore() {
    return { version: STORE_VERSION, activeSessionId: "", sessions: [], views: [], recents: [], handoffs: DEFAULT_HANDOFFS.map(item => ({ ...item })), diagnostics: [] };
  }

  function normalizeStore(value) {
    if (!value || value.version !== STORE_VERSION) return emptyStore();
    const handoffs = Array.isArray(value.handoffs) ? value.handoffs : [];
    const byID = new Map(handoffs.map(item => [item.id, item]));
    return {
      version: STORE_VERSION,
      activeSessionId: typeof value.activeSessionId === "string" ? value.activeSessionId : "",
      sessions: Array.isArray(value.sessions) ? value.sessions.slice(0, MAX_SESSIONS).map(normalizeSession).filter(Boolean) : [],
      views: Array.isArray(value.views) ? value.views.slice(0, 100).map(normalizeView).filter(Boolean) : [],
      recents: Array.isArray(value.recents) ? value.recents.slice(0, 20).map(normalizeRecent).filter(Boolean) : [],
      handoffs: DEFAULT_HANDOFFS.map(item => normalizeHandoff(byID.get(item.id) || item)).concat(handoffs.filter(item => !DEFAULT_HANDOFFS.some(base => base.id === item.id)).map(normalizeHandoff).filter(Boolean)).slice(0, 30),
      diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics.slice(-MAX_DIAGNOSTICS).map(sanitizeDiagnostic) : [],
    };
  }

  function load(storage) {
    try {
      const raw = (storage || globalThis.localStorage)?.getItem(STORE_KEY);
      return raw ? normalizeStore(JSON.parse(raw)) : emptyStore();
    } catch {
      return emptyStore();
    }
  }

  function save(store, storage) {
    const normalized = normalizeStore(store);
    try {
      (storage || globalThis.localStorage)?.setItem(STORE_KEY, JSON.stringify(normalized));
      return { ok: true, store: normalized };
    } catch (error) {
      return { ok: false, store: normalized, error: error?.message || "Local storage is unavailable." };
    }
  }

  function normalizeSession(value) {
    if (!value || typeof value.id !== "string") return null;
    return {
      id: value.id,
      name: cleanString(value.name || "Investigation", 160),
      status: value.status === "closed" ? "closed" : "active",
      createdAt: validDate(value.createdAt),
      updatedAt: validDate(value.updatedAt),
      closedAt: value.closedAt ? validDate(value.closedAt) : "",
      scope: sanitizeValue(value.scope || {}),
      notes: cleanString(value.notes || "", MAX_STRING),
      readOnly: Boolean(value.readOnly),
      evidence: Array.isArray(value.evidence) ? value.evidence.slice(-MAX_EVIDENCE).map(normalizeEvidence).filter(Boolean) : [],
    };
  }

  function normalizeEvidence(value) {
    if (!value || typeof value.kind !== "string") return null;
    return { id: typeof value.id === "string" ? value.id : id("evidence"), kind: cleanString(value.kind, 40), pinnedAt: validDate(value.pinnedAt), payload: sanitizeValue(value.payload || {}) };
  }

  function createSession(store, scope, name) {
    const now = new Date().toISOString();
    const session = { id: id("session"), name: cleanString(name || scope?.name || "Investigation", 160), status: "active", createdAt: now, updatedAt: now, closedAt: "", scope: sanitizeValue(scope || {}), notes: "", evidence: [] };
    store.sessions = [session, ...(store.sessions || []).filter(item => item.id !== session.id)].slice(0, MAX_SESSIONS);
    store.activeSessionId = session.id;
    return session;
  }

  function activeSession(store) {
    return (store.sessions || []).find(item => item.id === store.activeSessionId && item.status === "active") || null;
  }

  function addEvidence(store, kind, payload) {
    const session = activeSession(store);
    if (!session) throw new Error("Start an investigation before pinning evidence.");
    const evidence = normalizeEvidence({ id: id("evidence"), kind, pinnedAt: new Date().toISOString(), payload });
    session.evidence = [...session.evidence, evidence].slice(-MAX_EVIDENCE);
    session.updatedAt = new Date().toISOString();
    return evidence;
  }

  function updateSession(store, sessionID, changes) {
    const session = (store.sessions || []).find(item => item.id === sessionID);
    if (!session) throw new Error("Investigation not found.");
    if (Object.hasOwn(changes || {}, "name")) session.name = cleanString(changes.name || "Investigation", 160);
    if (Object.hasOwn(changes || {}, "notes")) session.notes = cleanString(changes.notes || "", MAX_STRING);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  function closeSession(store, sessionID) {
    const session = (store.sessions || []).find(item => item.id === sessionID);
    if (!session) throw new Error("Investigation not found.");
    session.status = "closed";
    session.readOnly = true;
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    if (store.activeSessionId === sessionID) store.activeSessionId = "";
    return session;
  }

  function removeSession(store, sessionID) {
    store.sessions = (store.sessions || []).filter(item => item.id !== sessionID);
    if (store.activeSessionId === sessionID) store.activeSessionId = "";
  }

  function redactionRules(customPatterns) {
    const custom = (customPatterns || []).map((source, index) => ({ name: `Custom ${index + 1}`, source: String(source), flags: "gi", replacement: "[REDACTED]" }));
    return [...DEFAULT_REDACTIONS, ...custom].map(rule => ({ ...rule, expression: new RegExp(rule.source, rule.flags) }));
  }

  function redactValue(value, customPatterns, stats) {
    const counts = stats || {};
    const rules = redactionRules(customPatterns);
    function visit(input) {
      if (typeof input === "string") {
        let output = input;
        for (const rule of rules) {
          rule.expression.lastIndex = 0;
          const before = output;
          output = output.replace(rule.expression, rule.replacement);
          if (output !== before) counts[rule.name] = (counts[rule.name] || 0) + 1;
        }
        return output;
      }
      if (Array.isArray(input)) return input.map(visit);
      if (input && typeof input === "object") {
        const output = {};
        for (const [key, item] of Object.entries(input)) {
          if (/^(token|password|passwd|secret|api[_-]?key|client[_-]?secret|authorization|cookie)$/i.test(key)) {
            output[key] = "[REDACTED]";
            counts["Credential field"] = (counts["Credential field"] || 0) + 1;
          } else output[key] = visit(item);
        }
        return output;
      }
      return input;
    }
    return { value: visit(value), counts };
  }

  function exportBundle(session, customPatterns) {
    if (!session) throw new Error("Investigation not found.");
    const bundle = { format: "runwake-investigation", version: 1, exportedAt: new Date().toISOString(), investigation: normalizeSession(session) };
    return redactValue(bundle, customPatterns, {});
  }

  function importBundle(store, value) {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || parsed.format !== "runwake-investigation" || parsed.version !== 1) throw new Error("This is not a supported Runwake investigation bundle.");
    const session = normalizeSession(parsed.investigation);
    if (!session) throw new Error("The investigation bundle is incomplete.");
    session.id = id("session");
    session.name = `${session.name} · imported`;
    session.status = "closed";
    session.closedAt = session.closedAt || new Date().toISOString();
    store.sessions = [session, ...(store.sessions || [])].slice(0, MAX_SESSIONS);
    return session;
  }

  function normalizeView(value) {
    if (!value || typeof value.id !== "string") return null;
    return { id: value.id, name: cleanString(value.name || "Saved view", 120), kind: ["workloads", "activity"].includes(value.kind) ? value.kind : "workloads", createdAt: validDate(value.createdAt), updatedAt: validDate(value.updatedAt), state: sanitizeValue(value.state || {}) };
  }

  function saveView(store, kind, name, viewState) {
    const now = new Date().toISOString();
    const view = normalizeView({ id: id("view"), name, kind, createdAt: now, updatedAt: now, state: viewState });
    store.views = [view, ...(store.views || [])].slice(0, 100);
    return view;
  }

  function removeView(store, viewID) {
    store.views = (store.views || []).filter(item => item.id !== viewID);
  }

  function renameView(store, viewID, name) {
    const view = (store.views || []).find(item => item.id === viewID);
    if (!view) throw new Error("Saved view not found.");
    view.name = cleanString(name || "Saved view", 120);
    view.updatedAt = new Date().toISOString();
    return view;
  }

  function normalizeRecent(value) {
    if (!value || typeof value.key !== "string") return null;
    return { key: cleanString(value.key, 500), label: cleanString(value.label || "Recent target", 160), detail: cleanString(value.detail || "", 240), route: cleanString(value.route || "/workloads", 8192), openedAt: validDate(value.openedAt) };
  }

  function addRecent(store, value) {
    const recent = normalizeRecent({ ...value, openedAt: new Date().toISOString() });
    if (!recent) return null;
    store.recents = [recent, ...(store.recents || []).filter(item => item.key !== recent.key)].slice(0, 20);
    return recent;
  }

  function normalizeHandoff(value) {
    if (!value || typeof value.id !== "string") return null;
    return { id: cleanString(value.id, 80), name: cleanString(value.name || "Integration", 100), template: cleanString(value.template || "", 4096), enabled: Boolean(value.enabled && value.template) };
  }

  function validateHandoff(template) {
    if (!template) return { ok: false, error: "Enter an HTTP or HTTPS URL template." };
    const placeholders = [...String(template).matchAll(/\{([a-z_]+)\}/g)].map(match => match[1]);
    const unknown = placeholders.find(name => !PLACEHOLDERS.has(name));
    if (unknown) return { ok: false, error: `Unknown placeholder {${unknown}}.` };
    const probe = String(template).replace(/\{[a-z_]+\}/g, "value");
    try {
      const url = new URL(probe);
      if (!/^https?:$/.test(url.protocol)) return { ok: false, error: "Only HTTP and HTTPS templates are supported." };
    } catch {
      return { ok: false, error: "Enter a valid absolute URL template." };
    }
    return { ok: true, placeholders };
  }

  function resolveHandoff(template, context) {
    const validation = validateHandoff(template);
    if (!validation.ok) throw new Error(validation.error);
    return String(template).replace(/\{([a-z_]+)\}/g, (_, name) => encodeURIComponent(String(context?.[name] || "")));
  }

  function correlationIDs(value) {
    const output = new Map();
    function visit(input) {
      if (Array.isArray(input)) return input.forEach(visit);
      if (!input || typeof input !== "object") return;
      for (const [key, item] of Object.entries(input)) {
        if (/^(trace[_-]?id|correlation[_-]?id|request[_-]?id|transaction[_-]?id)$/i.test(key) && ["string", "number"].includes(typeof item)) output.set(String(item), key);
        else if (item && typeof item === "object") visit(item);
      }
    }
    visit(value);
    return [...output].map(([value, key]) => ({ key, value }));
  }

  function addDiagnostic(store, entry) {
    store.diagnostics = [...(store.diagnostics || []), sanitizeDiagnostic({ timestamp: new Date().toISOString(), ...entry })].slice(-MAX_DIAGNOSTICS);
  }

  function diagnosticsBundle(store, context) {
    return { format: "runwake-diagnostics", version: 1, exportedAt: new Date().toISOString(), context: sanitizeDiagnostic(context || {}), events: (store.diagnostics || []).map(sanitizeDiagnostic) };
  }

  function sanitizeDiagnostic(value) {
    const allowed = ["timestamp", "type", "route", "connectionKind", "connectionID", "attempt", "delayMs", "status", "message", "version", "online", "source"];
    const output = {};
    for (const key of allowed) if (value?.[key] !== undefined) output[key] = cleanString(value[key], key === "message" ? 1000 : 200);
    return output;
  }

  function reconnectDelay(attempt, randomValue) {
    const jitter = Number.isFinite(randomValue) ? randomValue : Math.random();
    const base = Math.min(30000, 1000 * (2 ** Math.min(5, Math.max(0, attempt - 1))));
    return Math.round(base * (0.8 + jitter * 0.4));
  }

  function compareVersions(left, right) {
    const parse = value => String(value || "0").replace(/^v/, "").split(".").slice(0, 3).map(item => Number(item.replace(/\D.*$/, "")) || 0);
    const a = parse(left), b = parse(right);
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    return 0;
  }

  function downloadJSON(filename, value, documentObject, urlObject) {
    const doc = documentObject || globalThis.document;
    const urls = urlObject || globalThis.URL;
    const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
    const href = urls.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = href;
    link.download = filename;
    link.click();
    setTimeout(() => urls.revokeObjectURL(href), 0);
  }

  function cleanString(value, limit) {
    return String(value ?? "").slice(0, limit || MAX_STRING);
  }

  function sanitizeValue(value, depth) {
    const level = Number(depth || 0);
    if (level > 12) return "[TRUNCATED]";
    if (typeof value === "string") return cleanString(value, MAX_STRING);
    if (["number", "boolean"].includes(typeof value) || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 2000).map(item => sanitizeValue(item, level + 1));
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 500)) output[cleanString(key, 200)] = sanitizeValue(item, level + 1);
      return output;
    }
    return cleanString(value, MAX_STRING);
  }

  function validDate(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  return {
    STORE_KEY, STORE_VERSION, DEFAULT_REDACTIONS, PLACEHOLDERS,
    emptyStore, normalizeStore, load, save,
    createSession, activeSession, addEvidence, updateSession, closeSession, removeSession, exportBundle, importBundle, redactValue,
    saveView, removeView, renameView, addRecent,
    validateHandoff, resolveHandoff, correlationIDs,
    addDiagnostic, diagnosticsBundle, reconnectDelay, compareVersions, downloadJSON,
  };
});
