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
        <header class="page-header workloads-header">
          <div><h1 class="page-title">Workloads</h1></div>
          <div class="header-actions workload-header-actions">${state.connections.length ? `<button type="button" class="btn workload-header-action" data-action="save-workload-view" aria-label="Save workload view" title="Save workload view"><span class="workload-action-symbol" aria-hidden="true">☆</span><span class="workload-action-label">Save view</span></button>` : ""}<button type="button" id="refresh-workloads" class="btn workload-header-action" data-action="refresh-workloads" aria-label="${html(workloadRefreshTitle())}" title="${html(workloadRefreshTitle())}" ${state.workloadRefreshing ? "disabled" : ""}><span class="workload-action-symbol workload-refresh-symbol" aria-hidden="true">↻</span><span class="workload-action-label">${html(workloadRefreshLabel())}</span></button><button type="button" class="btn primary workload-header-action" data-action="add-connection" aria-label="Add connection" title="Add connection"><span class="workload-action-symbol" aria-hidden="true">＋</span><span class="workload-action-label">Add connection</span></button></div>
        </header>
        <div id="workload-errors">${workloadErrorNotice()}</div>
        <div id="metrics-availability">${metricsAvailability()}</div>
        ${state.connections.length ? `
          <div id="workload-inventory-status">${workloadInventoryStatus()}</div>
          ${savedWorkloadViews()}
          <div class="toolbar">
            <div class="search-wrap"><label class="sr-only" for="workload-search">Search workloads</label><input id="workload-search" class="field" type="search" placeholder="Search name, namespace, image…" value="${html(filters.search)}"></div>
            <details class="workload-filter-disclosure" ${WORKLOAD_FILTER_DESKTOP_MEDIA.matches ? "open" : ""}>
              <summary><span>Filters</span><span class="workload-filter-summary"><span id="workload-filter-count" class="workload-filter-count" ${workloadActiveFilterCount() ? "" : "hidden"}>${html(workloadActiveFilterCount())}</span><span id="workload-filter-copy">${html(workloadFilterSummary())}</span><span class="workload-filter-chevron" aria-hidden="true"></span></span></summary>
              <div class="workload-filter-grid">
                ${renderWorkloadFilterMenu("connection-filter", "connection", "Connection", [{ value: "", label: "All connections" }, ...state.connections.map(connection => ({ value: connection.id, label: connection.name }))], filters.connection, true)}
                ${renderWorkloadFilterMenu("namespace-filter", "namespace", "Namespace", [{ value: "", label: "All namespaces" }, ...namespaces.map(namespace => ({ value: namespace, label: namespace }))], filters.namespace, true)}
                ${renderWorkloadFilterMenu("status-filter", "status", "State", [{ value: "", label: "Any state" }, { value: "good", label: "Ready" }, { value: "warn", label: "Needs attention" }, { value: "bad", label: "Failed" }, { value: "other", label: "Other" }], filters.status)}
                <button id="workload-filter-clear" type="button" class="workload-filter-reset" data-action="clear-filters" ${workloadActiveFilterCount() ? "" : "hidden"}>Clear filters</button>
              </div>
            </details>
          </div>
          <div id="workload-selection-bar">${workloadSelectionBar()}</div>` : ""}
        <div id="workload-content">${workloadContent(filtered)}</div>
      </section>`;
    shell(body, "workloads");
    bindWorkloadControls();
  }

  function savedWorkloadViews() {
    const views = (state.personal.views || []).filter(item => item.kind === "workloads");
    if (!views.length) return "";
    return `<div class="saved-view-strip" aria-label="Saved workload views"><span>Saved views</span><div>${views.map(view => `<button type="button" class="saved-view-button" data-action="apply-saved-view" data-id="${html(view.id)}">${html(view.name)}</button>`).join("")}</div><button type="button" class="btn ghost small" data-action="manage-saved-views">Manage</button></div>`;
  }

  function workloadSelectionBar() {
    const selectedItems = selectedWorkloadItems();
    const selected = selectedItems.length;
    if (!selected) return "";
    const everySelectionIsManageable = selected === state.selectedWorkloads.size
      && selectedItems.every(item => item.platform === "docker" && item.uid && canManageDockerConnection(item.connection_id));
    const includesDocker = selectedItems.some(item => item.platform === "docker");
    const runtimeActions = everySelectionIsManageable
      ? `<button type="button" class="btn small" data-action="restart-selected-containers">Restart ${selected}</button><button type="button" class="btn ghost danger small" data-action="delete-selected-containers">Delete ${selected}</button>`
      : includesDocker ? `<span class="workload-selection-note">Runtime actions require managed Docker containers only.</span>` : "";
    const selectionLabel = selected === 1 ? "workload selected" : "workloads selected";
    return `<div class="workload-selection-bar"><span class="workload-selection-count" role="status" aria-live="polite"><strong>${selected}</strong> ${selectionLabel}</span><div class="workload-selection-actions"><button type="button" class="btn primary small" data-action="open-selected-logs">Open merged logs</button>${runtimeActions}<span class="workload-selection-divider" aria-hidden="true"></span><button type="button" class="btn ghost small" data-action="clear-workload-selection">Clear selection</button></div></div>`;
  }

  function selectedWorkloadItems() {
    return state.workloads.filter(item => state.selectedWorkloads.has(metricKey(item)));
  }

  function updateWorkloadSelectionBar() {
    const target = document.getElementById("workload-selection-bar");
    if (target) target.innerHTML = workloadSelectionBar();
    document.querySelectorAll("[data-select-workload]").forEach(input => {
      input.checked = state.selectedWorkloads.has(input.dataset.selectWorkload);
    });
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
      refresh.querySelector(".workload-action-label")?.replaceChildren(document.createTextNode(workloadRefreshLabel()));
      refresh.title = workloadRefreshTitle();
      refresh.setAttribute("aria-label", workloadRefreshTitle());
    }
    updateWorkloadFilterSummary();
  }

  function workloadActiveFilterCount() {
    return Number(filterValues(state.filters.connection).length > 0)
      + Number(filterValues(state.filters.namespace).length > 0)
      + Number(Boolean(state.filters.status));
  }

  function workloadFilterSummary() {
    const count = workloadActiveFilterCount();
    return count ? `${count} active` : "Refine results";
  }

  function updateWorkloadFilterSummary() {
    const count = workloadActiveFilterCount();
    const badge = document.getElementById("workload-filter-count");
    const copy = document.getElementById("workload-filter-copy");
    const clear = document.getElementById("workload-filter-clear");
    if (badge) {
      badge.textContent = String(count);
      badge.hidden = !count;
    }
    if (copy) copy.textContent = workloadFilterSummary();
    if (clear) clear.hidden = !count;
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
          <thead><tr><th class="workload-select-heading"><span class="sr-only">Select</span></th><th>Workload</th><th>Location</th><th>State</th><th>CPU</th><th>Memory</th><th>Actions</th></tr></thead>
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
    const selectionKey = metricKey(item);
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
      <td class="workload-select-cell"><label class="workload-select-control" title="Select ${html(item.name)}"><input type="checkbox" data-select-workload="${html(selectionKey)}" data-request="${encoded}" aria-label="Select ${html(item.name)}" ${state.selectedWorkloads.has(selectionKey) ? "checked" : ""}></label></td>
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
    return `<tr class="workload-virtual-spacer" aria-hidden="true"><td colspan="7" style="height:${height}px"></td></tr>`;
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
