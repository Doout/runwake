  registerActionHandler("personal workflows", [
    "open-command-palette",
    "execute-command",
    "new-investigation",
    "confirm-new-investigation",
    "activate-investigation",
    "close-investigation",
    "delete-investigation",
    "export-investigation",
    "confirm-export-investigation",
    "pin-selected-record",
    "pin-latest-metric",
    "configure-handoffs",
    "save-handoffs",
    "export-diagnostics",
    "check-for-update",
    "open-release",
    "open-handoff",
    "confirm-open-handoff",
    "save-workload-view",
    "confirm-save-workload-view",
    "save-activity-view",
    "confirm-save-activity-view",
    "apply-saved-view",
    "rename-saved-view",
    "confirm-rename-saved-view",
    "delete-saved-view",
    "reset-saved-views",
    "manage-saved-views"
  ], async (action, { target, event }) => {
    switch (action) {
        case "open-command-palette": showCommandPalette(); break;
        case "execute-command": executeCommand(target.dataset.commandId || ""); break;
        case "new-investigation": showNewInvestigationModal(); break;
        case "confirm-new-investigation": {
          const name = document.getElementById("new-investigation-name")?.value.trim();
          if (!name) return toast("Enter an investigation name.", "error");
          startInvestigation(name);
          closeModal();
          if (state.route?.path === "/investigations") renderInvestigations();
          break;
        }
        case "activate-investigation":
          {
            const selected = state.personal.sessions.find(item => item.id === target.dataset.id);
            if (selected?.readOnly) {
              state.viewingSessionID = selected.id;
              renderInvestigations();
              break;
            }
          }
          state.personal.sessions.forEach(session => {
            if (session.status === "active" && session.id !== target.dataset.id) personal.closeSession(state.personal, session.id);
          });
          {
            const session = state.personal.sessions.find(item => item.id === target.dataset.id);
            if (session) {
              session.status = "active";
              session.closedAt = "";
              session.updatedAt = new Date().toISOString();
            }
          }
          state.personal.activeSessionId = target.dataset.id || "";
          savePersonalState("Investigation activated");
          renderInvestigations();
          break;
        case "close-investigation":
          personal.closeSession(state.personal, target.dataset.id || "");
          savePersonalState("Investigation finished");
          renderInvestigations();
          break;
        case "delete-investigation":
          personal.removeSession(state.personal, target.dataset.id || "");
          savePersonalState("Investigation deleted");
          renderInvestigations();
          break;
        case "export-investigation": exportInvestigation(target.dataset.id || ""); break;
        case "confirm-export-investigation": confirmExportInvestigation(target.dataset.id || ""); break;
        case "pin-selected-record": pinSelectedRecord(); break;
        case "pin-latest-metric": pinLatestMetric(); break;
        case "configure-handoffs": showHandoffModal(); break;
        case "save-handoffs": saveHandoffs(); break;
        case "export-diagnostics": exportDiagnostics(); break;
        case "check-for-update": await checkForUpdate(target); break;
        case "open-release": {
          const release = new URL(target.dataset.url || "", "https://github.com");
          if (release.protocol === "https:" && release.hostname === "github.com") window.open(release.href, "_blank", "noopener,noreferrer");
          break;
        }
        case "open-handoff": previewHandoff(target.dataset.id || "", Number(target.dataset.index)); break;
        case "confirm-open-handoff": openHandoff(target.dataset.url || ""); break;
        case "save-workload-view": showSaveWorkloadViewModal(); break;
        case "confirm-save-workload-view": saveCurrentWorkloadView(); break;
        case "save-activity-view": showSaveActivityViewModal(); break;
        case "confirm-save-activity-view": saveCurrentActivityView(); break;
        case "apply-saved-view": applySavedView(target.dataset.id || ""); break;
        case "rename-saved-view": showRenameSavedViewModal(target.dataset.id || ""); break;
        case "confirm-rename-saved-view": {
          const name = document.getElementById("saved-view-name")?.value.trim();
          if (!name) return toast("Enter a view name.", "error");
          personal.renameView(state.personal, target.dataset.id || "", name);
          savePersonalState("Saved view renamed");
          showSavedViewsModal();
          break;
        }
        case "delete-saved-view": deleteSavedView(target.dataset.id || ""); break;
        case "reset-saved-views":
          state.personal.views = [];
          savePersonalState("Saved views cleared");
          showSavedViewsModal();
          break;
        case "manage-saved-views": showSavedViewsModal(); break;
      default:
        return;
    }
  });
