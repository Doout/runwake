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
    return `<div class="empty"><div class="empty-inner"><div class="empty-symbol" aria-hidden="true">◇</div><h2>${html(title)}</h2><p>${html(copy)}</p>${button ? `<button type="button" class="btn primary" data-action="${html(action)}">${html(button)}</button>` : ""}</div></div>`;
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
