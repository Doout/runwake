  registerActionHandler("workloads", [
    "clear-workload-selection",
    "restart-selected-containers",
    "delete-selected-containers",
    "confirm-restart-selected-containers",
    "confirm-delete-selected-containers",
    "open-selected-logs",
    "refresh-workloads",
    "load-workload-metrics",
    "show-workload-list",
    "show-workload-overview",
    "open-workload-group",
    "clear-filters",
    "open-connections",
    "back-workloads",
    "filter-workloads-from-activity",
    "filter-workloads-from-topology",
    "refresh-topology"
  ], async (action, { target, event }) => {
    switch (action) {
        case "clear-workload-selection":
          state.selectedWorkloads.clear();
          updateWorkloadSelectionBar();
          break;
        case "restart-selected-containers":
          showSelectedDockerContainersConfirmation("restart");
          break;
        case "delete-selected-containers":
          showSelectedDockerContainersConfirmation("delete");
          break;
        case "confirm-restart-selected-containers":
          await performSelectedDockerRuntimeAction(target, "restart");
          break;
        case "confirm-delete-selected-containers":
          await performSelectedDockerRuntimeAction(target, "delete");
          break;
        case "open-selected-logs": openSelectedLogs(); break;
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
      default:
        return;
    }
  });
