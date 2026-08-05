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
    return `<button type="button" class="log-result ${matchIndex === stream.activeMatch ? "active" : ""}" data-action="jump-log-match" data-index="${index}"><span><time>${html(formatTime(structured?.timestamp || record.timestamp))}</time><small>${html(String(level).toUpperCase())}</small></span><strong>${html(label)}</strong></button>`;
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
      <button type="button" class="log-focus-choice" data-action="focus-log-pod" data-pod="${html(record.pod)}">Only this pod</button>
      ${record.container ? `<button type="button" class="log-focus-choice" data-action="focus-log-source" data-pod="${html(record.pod)}" data-container="${html(record.container)}">Only this source</button>` : ""}
    </div>` : "";
    target.innerHTML = `
      <div class="log-record-meta"><span>${html(formatTime(record.timestamp, true))}</span><span>${html(origin || record.type || "record")}</span></div>
      ${correlations.length ? `<div class="log-correlation"><span>Correlation</span>${correlations.map(item => `<code>${html(item.key)}=${html(item.value)}</code>`).join("")}</div>` : ""}
      ${handoffs.length ? `<div class="log-handoff-actions"><span>Open in</span>${handoffs.map(item => `<button type="button" class="btn ghost small" data-action="open-handoff" data-id="${html(item.id)}" data-index="${index}">${html(item.name)}</button>`).join("")}</div>` : ""}
      ${focusActions}
      <div class="log-record-actions">
        <span>Render this record as</span>
        ${["inherit", "raw", "json", "logfmt", "stack"].map(mode => `<button type="button" class="log-format-choice ${selectedFormat === mode ? "active" : ""}" data-action="format-log-record" data-format="${mode}" data-index="${index}">${mode === "inherit" ? "Default" : mode === "logfmt" ? "Key/value" : mode === "stack" ? "Stack trace" : mode.toUpperCase()}</button>`).join("")}
      </div>
      <div class="log-record-raw-heading"><span>Raw record</span><button type="button" class="btn ghost small" data-action="copy-log-record" data-index="${index}">Copy</button></div>
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
