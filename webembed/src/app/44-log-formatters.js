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
