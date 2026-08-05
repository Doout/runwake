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
