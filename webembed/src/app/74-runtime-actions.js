  registerActionHandler("runtime operations", [
    "restart-docker-container",
    "delete-docker-container",
    "restart-compose-project",
    "confirm-restart-docker-container",
    "confirm-delete-docker-container",
    "confirm-restart-compose-project"
  ], async (action, { target, event }) => {
    switch (action) {
        case "restart-docker-container":
          showRestartDockerContainerConfirmation(target.dataset.connection || "", target.dataset.container || "", target.dataset.name || "Container");
          break;
        case "delete-docker-container":
          showDeleteDockerContainerConfirmation(target.dataset.connection || "", target.dataset.container || "", target.dataset.name || "Container");
          break;
        case "restart-compose-project":
          showRestartComposeProjectConfirmation(target.dataset.connection || "", target.dataset.project || "");
          break;
        case "confirm-restart-docker-container":
          await performDockerRuntimeAction(target, {
            connectionID: target.dataset.connection || "",
            path: `/api/v1/connections/${encodeURIComponent(target.dataset.connection || "")}/docker/containers/${encodeURIComponent(target.dataset.container || "")}/restart`,
            request: { method: "POST" },
            pendingLabel: "Restarting…",
            successMessage: () => `${target.dataset.name || "Container"} restarted`,
          });
          break;
        case "confirm-delete-docker-container":
          await performDockerRuntimeAction(target, {
            connectionID: target.dataset.connection || "",
            path: `/api/v1/connections/${encodeURIComponent(target.dataset.connection || "")}/docker/containers/${encodeURIComponent(target.dataset.container || "")}?force=true`,
            request: { method: "DELETE" },
            pendingLabel: "Deleting…",
            removeContainerID: target.dataset.container || "",
            successMessage: () => `${target.dataset.name || "Container"} deleted`,
          });
          break;
        case "confirm-restart-compose-project":
          await performDockerRuntimeAction(target, {
            connectionID: target.dataset.connection || "",
            path: `/api/v1/connections/${encodeURIComponent(target.dataset.connection || "")}/docker/compose/restart`,
            request: { method: "POST", body: JSON.stringify({ project: target.dataset.project || "" }) },
            pendingLabel: "Restarting…",
            successMessage: response => `${target.dataset.project || "Compose project"} restarted · ${response?.containers || 0} container${response?.containers === 1 ? "" : "s"}`,
          });
          break;
      default:
        return;
    }
  });
