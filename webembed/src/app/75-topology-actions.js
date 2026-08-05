  registerActionHandler("topology", [
    "toggle-topology-node",
    "toggle-all-topology-nodes",
    "open-topology-project",
    "open-topology-connected",
    "open-topology-logs",
    "toggle-topology-context-node",
    "set-all-topology-nodes",
    "filter-topology-node-workloads",
    "copy-topology-node-name",
    "zoom-topology",
    "reset-topology-zoom",
    "show-full-topology"
  ], async (action, { target, event }) => {
    switch (action) {
        case "toggle-topology-node":
          toggleTopologyNode(target.closest(".topology-node"));
          break;
        case "toggle-all-topology-nodes":
          toggleAllTopologyNodes();
          break;
        case "open-topology-project":
          closeTopologyContextMenu();
          navigate(`/topology?${new URLSearchParams({ connection_id: target.dataset.connection || "", project: target.dataset.project || "" }).toString()}`);
          break;
        case "open-topology-connected":
          closeTopologyContextMenu();
          navigate(`/topology?${new URLSearchParams({ connection_id: target.dataset.connection || "", project: target.dataset.project || "", focus: target.dataset.focus || "" }).toString()}`);
          break;
        case "open-topology-logs": {
          const request = JSON.parse(decodeURIComponent(target.dataset.request || ""));
          closeTopologyContextMenu();
          navigate(`/activity?${new URLSearchParams(request).toString()}`);
          break;
        }
        case "toggle-topology-context-node": {
          const node = document.getElementById(target.dataset.node || "");
          closeTopologyContextMenu();
          toggleTopologyNode(node);
          break;
        }
        case "set-all-topology-nodes": {
          const expanded = target.dataset.expanded === "true";
          closeTopologyContextMenu();
          setAllTopologyNodes(expanded);
          break;
        }
        case "filter-topology-node-workloads":
          closeTopologyContextMenu();
          state.filters = {
            search: target.dataset.search || "",
            connection: target.dataset.connection ? [target.dataset.connection] : [],
            namespace: [],
            status: "",
          };
          state.workloadBrowseMode = "list";
          navigate("/workloads");
          break;
        case "copy-topology-node-name":
          await navigator.clipboard.writeText(target.dataset.value || "");
          closeTopologyContextMenu();
          toast("Copied");
          break;
        case "zoom-topology":
          applyTopologyZoom(state.topologyZoom + Number(target.dataset.zoom || 0));
          break;
        case "reset-topology-zoom":
          applyTopologyZoom(1);
          break;
        case "show-full-topology":
          navigate(`/topology?${new URLSearchParams({ connection_id: target.dataset.connection || "", project: target.dataset.project || "" }).toString()}`);
          break;
      default:
        return;
    }
  });
