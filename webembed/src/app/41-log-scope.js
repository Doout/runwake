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
        <button type="button" class="btn ghost small" data-action="reset-log-scope" ${profile.selectedPod || profile.selectedContainer ? "" : "hidden"}>Reset</button>
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
