  registerActionHandler("activity", [
    "show-activity-view",
    "show-metrics-view",
    "show-topology-view",
    "reconnect-stream",
    "clear-stream",
    "previous-log-match",
    "next-log-match",
    "log-jump-back",
    "log-jump-forward",
    "jump-log-match",
    "select-log-record",
    "format-log-record",
    "copy-log-record",
    "toggle-log-entry",
    "focus-log-pod",
    "focus-log-source",
    "toggle-log-menu",
    "clear-log-menu-search",
    "select-fixed-choice",
    "select-workload-filter",
    "toggle-workload-filter-option",
    "clear-workload-filter-draft",
    "apply-workload-filter",
    "select-log-format",
    "select-log-target",
    "reset-log-scope",
    "toggle-log-filters",
    "toggle-log-filter-picker",
    "add-log-filter",
    "remove-log-filter",
    "toggle-log-inspector",
    "toggle-log-formatter",
    "toggle-log-shortcuts",
    "clear-log-filters",
    "reset-log-formatter"
  ], async (action, { target, event }) => {
    switch (action) {
        case "show-activity-view": {
          const request = JSON.parse(decodeURIComponent(target.dataset.request));
          navigate(`/activity?${activityQuery(request).toString()}`);
          break;
        }
        case "show-metrics-view": {
          const request = JSON.parse(decodeURIComponent(target.dataset.request));
          const query = activityQuery(request, { view: "metrics" });
          navigate(`/activity?${query.toString()}`);
          break;
        }
        case "show-topology-view": {
          const request = JSON.parse(decodeURIComponent(target.dataset.topologyRequest));
          navigate(`/topology?${new URLSearchParams(request).toString()}`);
          break;
        }
        case "reconnect-stream": if (state.stream) {
          const container = document.getElementById("stream");
          startActivityStream(state.stream.request, state.stream.records, { liveOnly: true, scrollTop: container?.scrollTop, follow: document.getElementById("stream-follow")?.checked });
        } break;
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
      default:
        return;
    }
  });
