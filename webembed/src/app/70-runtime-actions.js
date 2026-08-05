
  function showEditConnection(connection) {
    const dockerAccess = connection.kind === "docker" ? `
      <div class="connection-edit-access">
        <span class="connection-edit-label">Docker permissions</span>
        ${renderFixedChoiceMenu("connection-access-mode", "access_mode", "Docker permissions", [
          { value: "read_only", label: "View only", description: "Inspect workloads without changing them." },
          { value: "manage", label: "Manage containers", description: "Restart or delete containers and restart Compose projects." },
        ], connection.access_mode === "manage" ? "manage" : "read_only")}
        <span class="hint">Runwake enforces this choice. The Docker endpoint itself remains privileged.</span>
      </div>` : "";
    showModal(`<div class="modal-header">
        <div><h2 id="edit-connection-title" class="modal-title">Edit connection</h2></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <form id="edit-connection-form">
          <label>Connection name<input class="field" name="name" value="${html(connection.name)}" required></label>
          ${dockerAccess}
          <div class="connection-edit-route">
            <span>${html(connection.kind === "kubernetes" ? "Kubernetes" : "Docker")}</span>
            <strong title="${html(connectionScope(connection))}">${html(connectionScope(connection))}</strong>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="save-connection-edit" data-id="${html(connection.id)}">Save</button>
      </div>`, "edit-connection-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "edit-connection-title");
    const input = modalRoot.querySelector('[name="name"]');
    input?.focus();
    input?.select();
  }

  async function saveConnectionEdit(id) {
    const form = document.getElementById("edit-connection-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const name = String(data.get("name") || "").trim();
    const accessMode = data.has("access_mode") ? String(data.get("access_mode")) : undefined;
    const button = modalRoot.querySelector('[data-action="save-connection-edit"]');
    if (!button) return;
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await api(`/api/v1/connections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name, ...(accessMode ? { access_mode: accessMode } : {}) }) });
      state.workloads = state.workloads.filter(item => item.connection_id !== id);
      state.workloadCachedConnections.delete(id);
      state.workloadPendingConnections.delete(id);
      state.workloadObservedAt.delete(id);
      closeModal();
      toast("Connection updated");
      await renderConnections();
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw error;
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Save";
    }
  }

  function showRestartDockerContainerConfirmation(connectionID, containerID, name) {
    closeTopologyContextMenu();
    showModal(`<div class="modal-header">
        <div><h2 id="restart-container-title" class="modal-title">Restart container?</h2><p class="modal-copy">Docker will stop and start this container.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="runtime-action-confirmation">
          <span class="runtime-action-mark" aria-hidden="true">↻</span>
          <div><strong>${html(name)}</strong><p>Traffic may be interrupted while the container restarts. Its restart policy remains unchanged.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn primary" data-action="confirm-restart-docker-container" data-connection="${html(connectionID)}" data-container="${html(containerID)}" data-name="${html(name)}">Restart</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "restart-container-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  function showRestartComposeProjectConfirmation(connectionID, project) {
    closeTopologyContextMenu();
    const count = state.workloads.filter(item => item.connection_id === connectionID && composeProjectName(item) === project).length;
    showModal(`<div class="modal-header">
        <div><h2 id="restart-compose-title" class="modal-title">Restart Compose project?</h2><p class="modal-copy">Docker will restart every container currently in this project.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="runtime-action-confirmation">
          <span class="runtime-action-mark" aria-hidden="true">↻</span>
          <div><strong>${html(project)}</strong><p>${count ? `${count} observed container${count === 1 ? "" : "s"} will be restarted.` : "All matching containers reported by Docker will be restarted."} Service traffic may be interrupted.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn primary" data-action="confirm-restart-compose-project" data-connection="${html(connectionID)}" data-project="${html(project)}">Restart project</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "restart-compose-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  function showDeleteDockerContainerConfirmation(connectionID, containerID, name) {
    closeTopologyContextMenu();
    showModal(`<div class="modal-header">
        <div><h2 id="delete-container-title" class="modal-title">Delete container?</h2><p class="modal-copy">This force-removes the container and cannot be undone.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(name)}</strong><p>Docker will stop the container if needed, then remove it. Compose tooling may recreate it later.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn destructive" data-action="confirm-delete-docker-container" data-connection="${html(connectionID)}" data-container="${html(containerID)}" data-name="${html(name)}">Delete container</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "delete-container-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  function selectedDockerRuntimeTargets() {
    return selectedWorkloadItems()
      .filter(item => item.platform === "docker" && item.uid && canManageDockerConnection(item.connection_id))
      .map(item => ({ key: metricKey(item), connectionID: item.connection_id, containerID: item.uid, name: item.name }));
  }

  function showSelectedDockerContainersConfirmation(operation) {
    const selectedItems = selectedWorkloadItems();
    const targets = selectedDockerRuntimeTargets();
    if (!targets.length || targets.length !== selectedItems.length || selectedItems.length !== state.selectedWorkloads.size) {
      toast("Select only containers from Docker connections with Manage containers enabled.", "error");
      return;
    }
    const deleting = operation === "delete";
    const count = targets.length;
    const titleID = `${operation}-selected-containers-title`;
    closeTopologyContextMenu();
    showModal(`<div class="modal-header">
        <div><h2 id="${titleID}" class="modal-title">${deleting ? "Delete" : "Restart"} ${count} container${count === 1 ? "" : "s"}?</h2><p class="modal-copy">${deleting ? "Docker will force-remove every selected container. This cannot be undone." : "Docker will stop and start every selected container."}</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="${deleting ? "remove-confirmation" : "runtime-action-confirmation"}">
          <span class="${deleting ? "remove-confirmation-mark" : "runtime-action-mark"}" aria-hidden="true">${deleting ? "!" : "↻"}</span>
          <div><strong>${count} selected container${count === 1 ? "" : "s"}</strong><p>${deleting ? "Running containers will be stopped first. Compose tooling may recreate them later." : "Traffic may be interrupted while the containers restart. Their restart policies remain unchanged."}</p></div>
        </div>
        <ul class="bulk-runtime-targets" aria-label="Selected containers">${targets.map(target => `<li>${html(target.name)}</li>`).join("")}</ul>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn ${deleting ? "destructive" : "primary"}" data-action="confirm-${operation}-selected-containers">${deleting ? "Delete" : "Restart"} ${count} container${count === 1 ? "" : "s"}</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", titleID);
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  async function performSelectedDockerRuntimeAction(button, operation) {
    if (!button) return;
    const targets = selectedDockerRuntimeTargets();
    if (!targets.length || targets.length !== selectedWorkloadItems().length || targets.length !== state.selectedWorkloads.size) {
      closeModal();
      toast("The selection changed. Select the containers again.", "error");
      return;
    }
    const deleting = operation === "delete";
    const modalButtons = [...modalRoot.querySelectorAll("button")];
    const errorNotice = document.getElementById("docker-action-error");
    modalButtons.forEach(item => { item.disabled = true; });
    if (errorNotice) {
      errorNotice.hidden = true;
      errorNotice.textContent = "";
    }
    const succeeded = [];
    const failed = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      button.textContent = `${deleting ? "Deleting" : "Restarting"} ${index + 1}/${targets.length}…`;
      try {
        const path = `/api/v1/connections/${encodeURIComponent(target.connectionID)}/docker/containers/${encodeURIComponent(target.containerID)}${deleting ? "?force=true" : "/restart"}`;
        await api(path, { method: deleting ? "DELETE" : "POST" });
        succeeded.push(target);
        state.selectedWorkloads.delete(target.key);
        if (deleting) {
          state.workloads = state.workloads.filter(item => item.uid !== target.containerID || item.connection_id !== target.connectionID);
        }
      } catch (error) {
        if (error instanceof AuthenticationRequired) throw error;
        failed.push({ target, error });
      }
    }
    const connectionIDs = [...new Set(succeeded.map(target => target.connectionID))];
    for (const connectionID of connectionIDs) {
      state.workloadCachedConnections.delete(connectionID);
      state.workloadPendingConnections.add(connectionID);
    }
    if (connectionIDs.length && routeInfo().path === "/workloads") refreshWorkloads(connectionIDs);
    if (!failed.length) {
      closeModal();
      toast(`${succeeded.length} container${succeeded.length === 1 ? "" : "s"} ${deleting ? "deleted" : "restarted"}`);
      return;
    }
    updateWorkloadSelectionBar();
    if (errorNotice) {
      errorNotice.textContent = `${failed.length} container${failed.length === 1 ? "" : "s"} failed: ${failed.map(item => `${item.target.name} — ${item.error.message}`).join("; ")}`;
      errorNotice.hidden = false;
    }
    modalButtons.forEach(item => { item.disabled = false; });
    button.textContent = `Retry ${failed.length}`;
    toast(`${succeeded.length} completed · ${failed.length} failed`, "error");
  }

  async function performDockerRuntimeAction(button, options) {
    if (!button) return;
    const errorNotice = document.getElementById("docker-action-error");
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = options.pendingLabel;
    if (errorNotice) {
      errorNotice.hidden = true;
      errorNotice.textContent = "";
    }
    try {
      const response = await api(options.path, options.request);
      if (options.removeContainerID) {
        state.workloads = state.workloads.filter(item => item.uid !== options.removeContainerID || item.connection_id !== options.connectionID);
      }
      state.workloadCachedConnections.delete(options.connectionID);
      state.workloadPendingConnections.add(options.connectionID);
      closeModal();
      toast(options.successMessage(response));
      const route = routeInfo();
      if (route.path === "/workloads") {
        refreshWorkloads([options.connectionID]);
      } else if (route.path === "/topology") {
        await refreshTopology({
          connection_id: route.params.get("connection_id") || "",
          project: route.params.get("project") || "",
          focus: options.removeContainerID ? "" : route.params.get("focus") || "",
        });
      }
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw error;
      if (errorNotice) {
        errorNotice.textContent = error.message;
        errorNotice.hidden = false;
      }
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  function showDeleteConnectionConfirmation(connection) {
    const managesAgent = Boolean(connection.deployment);
    const description = managesAgent
      ? "Runwake will first remove the managed agent resources, then delete this connection."
      : "This removes the saved route. It does not stop or modify the runtime.";
    showModal(`<div class="modal-header">
        <div><h2 id="remove-connection-title" class="modal-title">Remove connection?</h2><p class="modal-copy">This action cannot be undone.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(connection.name)}</strong><p>${description}</p></div>
        </div>
        <div id="remove-connection-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn destructive" data-action="confirm-delete-connection" data-id="${html(connection.id)}">Remove</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "remove-connection-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  async function deleteConnection(id) {
    const connection = state.connections.find(item => item.id === id);
    const button = modalRoot.querySelector('[data-action="confirm-delete-connection"]');
    const errorNotice = document.getElementById("remove-connection-error");
    if (!connection || !button) return;
    button.disabled = true;
    button.textContent = "Removing…";
    if (errorNotice) {
      errorNotice.hidden = true;
      errorNotice.textContent = "";
    }
    try {
      await api(`/api/v1/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
      state.connections = state.connections.filter(item => item.id !== connection.id);
      state.workloads = state.workloads.filter(item => item.connection_id !== connection.id);
      state.workloadCachedConnections.delete(connection.id);
      state.workloadPendingConnections.delete(connection.id);
      state.workloadObservedAt.delete(connection.id);
      closeModal();
      toast("Connection removed");
      await renderConnections();
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw error;
      if (errorNotice) {
        errorNotice.textContent = error.message;
        errorNotice.hidden = false;
      }
      button.disabled = false;
      button.textContent = "Remove";
    }
  }

  function showDeleteSSHProfileConfirmation(profile) {
    showModal(`<div class="modal-header">
        <div><h2 id="remove-ssh-profile-title" class="modal-title">Remove SSH profile?</h2><p class="modal-copy">This action cannot be undone.</p></div>
        <button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(profile.name)}</strong><p>Existing connections keep their copy. This removes only the reusable profile.</p></div>
        </div>
        <div id="remove-ssh-profile-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button class="btn destructive" data-action="confirm-delete-ssh-profile" data-id="${html(profile.id)}">Remove</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "remove-ssh-profile-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  async function deleteSSHProfile(id) {
    const profile = state.sshProfiles.find(item => item.id === id);
    const button = modalRoot.querySelector('[data-action="confirm-delete-ssh-profile"]');
    const errorNotice = document.getElementById("remove-ssh-profile-error");
    if (!profile || !button) return;
    button.disabled = true;
    button.textContent = "Removing…";
    if (errorNotice) {
      errorNotice.hidden = true;
      errorNotice.textContent = "";
    }
    try {
      await api(`/api/v1/ssh-profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
      state.sshProfiles = state.sshProfiles.filter(item => item.id !== profile.id);
      closeModal();
      toast("SSH profile removed");
      renderSSHProfileSettings();
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw error;
      if (errorNotice) {
        errorNotice.textContent = error.message;
        errorNotice.hidden = false;
      }
      button.disabled = false;
      button.textContent = "Remove";
    }
  }

  function environmentFrom(value) {
    const result = {};
    String(value || "").split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`Environment line ${index + 1} must use KEY=value`);
      const key = line.slice(0, separator).trim();
      const item = line.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Environment line ${index + 1} has an invalid variable name`);
      result[key] = item;
    });
    return result;
  }

  function listFrom(value) {
    return [...new Set(String(value || "").split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
  }
  function connectionName(id) { return state.connections.find(item => item.id === id)?.name || id; }
  function debounce(fn, delay) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
  }

  document.addEventListener("click", async event => {
    if (!event.target.closest(".log-menu-field")) closeLogMenus();
    if (!event.target.closest(".connection-action-menu")) closeConnectionMenus();
    if (!event.target.closest(".topology-context-menu")) closeTopologyContextMenu();
    const nav = event.target.closest("[data-nav]");
    if (nav) { navigate(nav.dataset.nav); return; }
    const topology = event.target.closest("[data-topology]");
    if (topology) {
      const request = JSON.parse(decodeURIComponent(topology.dataset.topology));
      navigate(`/topology?${new URLSearchParams(request).toString()}`);
      return;
    }
    const workload = event.target.closest("[data-workload]");
    if (event.target.closest(".workload-select-cell")) return;
    if (workload && !event.target.closest("[data-action], input, button, a, select, textarea")) {
      const request = JSON.parse(decodeURIComponent(workload.dataset.workload));
      navigate(`/activity?${new URLSearchParams(request).toString()}`);
      return;
    }
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action !== "toggle-connection-menu") closeConnectionMenus();
    if (!investigationsAvailable() && INVESTIGATION_ACTIONS.has(action)) return;
    try {
      switch (action) {
        case "add-connection":
          await Promise.all([state.settings ? Promise.resolve(state.settings) : loadSettings(), state.sshProfilesLoaded ? Promise.resolve(state.sshProfiles) : loadSSHProfiles()]);
          showAddConnection();
          break;
        case "add-connection-kind":
          await Promise.all([state.settings ? Promise.resolve(state.settings) : loadSettings(), state.sshProfilesLoaded ? Promise.resolve(state.sshProfiles) : loadSSHProfiles()]);
          showAddConnection(target.dataset.kind || "kubernetes");
          break;
        case "filter-connections":
          state.connectionFilter = target.dataset.filter || "all";
          drawConnections();
          break;
        case "toggle-connection-menu":
          toggleConnectionMenu(target.closest(".connection-action-menu"));
          break;
        case "edit-connection": {
          const connection = state.connections.find(item => item.id === target.dataset.id);
          if (connection) showEditConnection(connection);
          break;
        }
        case "save-connection-edit":
          await saveConnectionEdit(target.dataset.id);
          break;
        case "view-connection-workloads":
          state.filters.connection = target.dataset.id ? [target.dataset.id] : [];
          state.filters.namespace = [];
          state.filters.status = "";
          state.filters.search = "";
          state.workloadBrowseMode = "auto";
          navigate("/workloads");
          break;
        case "switch-add-kind": showAddConnection(target.dataset.kind); break;
        case "settings-tab":
          state.settingsTab = target.dataset.tab === "ssh" ? "ssh" : "general";
          if (state.settingsTab === "ssh") renderSSHProfileSettings();
          else await renderSettings();
          break;
        case "manage-ssh-profiles":
          closeModal();
          state.settingsTab = "ssh";
          navigate("/settings");
          break;
        case "add-ssh-profile": showSSHProfileModal(); break;
        case "save-ssh-profile": await saveSSHProfile(); break;
        case "save-inline-ssh-profile": await saveInlineSSHProfile(); break;
        case "cancel-inline-ssh": {
          const select = document.getElementById("ssh-profile-select");
          if (select && state.sshProfiles.length) {
            select.value = state.sshProfiles[0].id;
            updateSSHProfileSelection();
            updateDockerConnectionName();
          }
          break;
        }
        case "test-ssh-profile": {
          target.disabled = true;
          target.textContent = "Testing…";
          try {
            const response = await api(`/api/v1/ssh-profiles/${encodeURIComponent(target.dataset.id)}/test`, { method: "POST" });
            toast(response.message || "SSH profile is ready");
          } finally {
            target.disabled = false;
            target.textContent = "Test";
          }
          break;
        }
        case "delete-ssh-profile": {
          const profile = state.sshProfiles.find(item => item.id === target.dataset.id);
          if (profile) showDeleteSSHProfileConfirmation(profile);
          break;
        }
        case "confirm-delete-ssh-profile": await deleteSSHProfile(target.dataset.id); break;
        case "test-draft-connection": await testDraftConnection(); break;
        case "test-agent-ssh": await testAgentSSH(); break;
        case "submit-connection": await submitConnection(); break;
        case "close-modal": closeModal(); break;
        case "backdrop": if (event.target === target) closeModal(); break;
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
        case "test-connection": {
          target.disabled = true;
          target.textContent = "Testing…";
          const result = await api(`/api/v1/connections/${encodeURIComponent(target.dataset.id)}/test`, { method: "POST" });
          toast(result.message || `Connected${result.details?.server_version ? ` · ${result.details.server_version}` : ""}`);
          target.disabled = false;
          target.textContent = "Test";
          break;
        }
        case "delete-connection": {
          const connection = state.connections.find(item => item.id === target.dataset.id);
          if (connection) showDeleteConnectionConfirmation(connection);
          break;
        }
        case "confirm-delete-connection": await deleteConnection(target.dataset.id); break;
        case "deploy-agent": {
          if (!state.settings) await loadSettings();
          const connection = state.connections.find(item => item.id === target.dataset.id);
          if (connection) showAgentModal(connection);
          break;
        }
        case "submit-agent": await submitAgent(target.dataset.id); break;
        case "copy-code": {
          await navigator.clipboard.writeText(document.getElementById(target.dataset.target)?.textContent || "");
          toast("Copied");
          break;
        }
        case "finish-agent-setup": {
          closeModal();
          toast("Agent connection created");
          await renderConnections();
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof AuthenticationRequired)) toast(error.message, "error");
      if (action === "test-connection") {
        target.disabled = false;
        target.textContent = "Test";
      }
    }
  });

  document.addEventListener("change", event => {
    const selection = event.target.closest?.("[data-select-workload]");
    if (!selection) return;
    if (selection.checked) {
      if (state.selectedWorkloads.size >= 12) {
        selection.checked = false;
        toast("Select up to 12 workloads at once.", "error");
        return;
      }
      state.selectedWorkloads.add(selection.dataset.selectWorkload);
    } else state.selectedWorkloads.delete(selection.dataset.selectWorkload);
    updateWorkloadSelectionBar();
  });

  document.addEventListener("dblclick", event => {
    const node = event.target.closest?.("[data-topology-node]");
    if (!node || event.target.closest("button, a, input, select, textarea")) return;
    event.preventDefault();
    openTopologyNodeView(node);
  });

  document.addEventListener("contextmenu", event => {
    const node = event.target.closest?.("[data-topology-node]");
    if (!node) {
      closeTopologyContextMenu();
      return;
    }
    event.preventDefault();
    showTopologyContextMenu(node, event.clientX, event.clientY);
  });

  document.addEventListener("scroll", () => closeTopologyContextMenu(), true);
  window.addEventListener("resize", () => closeTopologyContextMenu());

  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showCommandPalette();
      return;
    }
    const topologyMenu = event.target.closest?.(".topology-context-menu");
    if (topologyMenu) {
      const items = [...topologyMenu.querySelectorAll('[role="menuitem"]')];
      const item = event.target.closest('[role="menuitem"]');
      const itemIndex = items.indexOf(item);
      if (event.key === "Escape") {
        event.preventDefault();
        closeTopologyContextMenu(true);
        return;
      }
      if (item && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        let nextIndex = itemIndex;
        if (event.key === "ArrowDown") nextIndex = (itemIndex + 1) % items.length;
        if (event.key === "ArrowUp") nextIndex = (itemIndex - 1 + items.length) % items.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = items.length - 1;
        items[nextIndex]?.focus();
        return;
      }
    }
    const topologyNode = event.target.closest?.("[data-topology-node]");
    if (topologyNode && !event.target.closest(".topology-context-menu")) {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const bounds = topologyNode.getBoundingClientRect();
        showTopologyContextMenu(topologyNode, bounds.left + Math.min(36, bounds.width / 2), bounds.top + Math.min(44, bounds.height), true);
        return;
      }
      if (event.target === topologyNode && event.key === "Enter") {
        event.preventDefault();
        openTopologyNodeView(topologyNode);
        return;
      }
    }
    if (event.key === "Escape" && modalRoot.childElementCount) {
      closeModal();
      return;
    }
    const connectionMenuField = event.target.closest?.(".connection-action-menu");
    if (connectionMenuField) {
      const menu = connectionMenuField.querySelector(".connection-menu");
      const items = [...connectionMenuField.querySelectorAll('[role="menuitem"]')];
      const item = event.target.closest('[role="menuitem"]');
      const itemIndex = items.indexOf(item);
      if (event.key === "Escape" && menu && !menu.hidden) {
        event.preventDefault();
        closeConnectionMenus(true);
        return;
      }
      if (event.target.matches(".connection-menu-trigger") && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        toggleConnectionMenu(connectionMenuField, true);
        if (event.key === "ArrowUp") requestAnimationFrame(() => items.at(-1)?.focus());
        return;
      }
      if (item && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        let nextIndex = itemIndex;
        if (event.key === "ArrowDown") nextIndex = (itemIndex + 1) % items.length;
        if (event.key === "ArrowUp") nextIndex = (itemIndex - 1 + items.length) % items.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = items.length - 1;
        items[nextIndex]?.focus();
        return;
      }
    }
    if (event.key === "Escape" && document.querySelector(".connection-menu:not([hidden])")) {
      event.preventDefault();
      closeConnectionMenus();
      return;
    }
    const logMenuField = event.target.closest?.(".log-menu-field");
    if (logMenuField) {
      const menu = logMenuField.querySelector(".log-menu");
      const options = [...logMenuField.querySelectorAll(".log-menu-option")].filter(item => !item.hidden);
      const option = event.target.closest(".log-menu-option");
      const optionIndex = options.indexOf(option);
      const menuSearch = event.target.closest("[data-log-menu-search]");
      if (event.key === "Escape" && menu && !menu.hidden) {
        event.preventDefault();
        closeLogMenus(true);
        return;
      }
      if (menuSearch && ["ArrowDown", "ArrowUp"].includes(event.key) && options.length) {
        event.preventDefault();
        options[event.key === "ArrowDown" ? 0 : options.length - 1]?.focus();
        return;
      }
      if (menuSearch && event.key === "Enter" && options.length) {
        event.preventDefault();
        options[0].click();
        return;
      }
      if (event.target.matches(".log-menu-trigger") && event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        toggleLogMenu(logMenuField, true);
        focusLogMenuSearch(logMenuField, event.key);
        return;
      }
      if (event.target.matches(".log-menu-trigger") && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        toggleLogMenu(logMenuField, true);
        const selected = options.find(item => item.classList.contains("selected"));
        (selected || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
        return;
      }
      if (option && options.length && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        let nextIndex = optionIndex;
        if (event.key === "ArrowDown") nextIndex = (optionIndex + 1) % options.length;
        if (event.key === "ArrowUp") nextIndex = (optionIndex - 1 + options.length) % options.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = options.length - 1;
        options[nextIndex]?.focus();
        return;
      }
    }
    if (event.key === "Escape" && document.querySelector(".log-menu:not([hidden])")) {
      event.preventDefault();
      closeLogMenus();
      return;
    }
    const workload = event.target.closest?.("[data-workload]");
    const nativeControl = event.target.closest?.("button, a, input, select, textarea, [contenteditable='true']");
    if (workload && !nativeControl && (event.key === "Enter" || event.key === " ")) workload.click();
    const row = event.target.closest?.(".stream-row");
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      selectLogRecord(Number(row.dataset.index));
      return;
    }
    if (!state.stream || routeInfo().path !== "/activity") return;
    const editing = event.target.matches?.("input, textarea, select, [contenteditable='true']");
    const search = document.getElementById("stream-search");
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      search?.focus();
      search?.select();
      return;
    }
    if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      moveLogJump(-1);
      return;
    }
    if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      moveLogJump(1);
      return;
    }
    if (event.target === search && event.key === "Enter") {
      event.preventDefault();
      navigateLogMatch(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.target === search && event.key === "Escape") {
      event.preventDefault();
      search.value = "";
      scheduleActivityRender(true);
      return;
    }
    if (!editing && event.key === "/") {
      event.preventDefault();
      search?.focus();
      return;
    }
    if (!editing && event.key === "?") {
      event.preventDefault();
      setLogToolPanel("shortcuts");
      return;
    }
    if (!editing && event.key === "End") {
      event.preventDefault();
      const follow = document.getElementById("stream-follow");
      if (follow) follow.checked = true;
      scrollLogToLatest();
    }
  });

  window.addEventListener("hashchange", renderRoute);
  WORKLOAD_FILTER_DESKTOP_MEDIA.addEventListener("change", event => {
    const disclosure = document.querySelector(".workload-filter-disclosure");
    if (disclosure) disclosure.open = event.matches;
  });
  renderRoute();
})();
