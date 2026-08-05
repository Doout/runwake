
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
        <button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
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
        <button type="button" class="btn" data-action="close-modal">Cancel</button>
        <button type="button" class="btn primary" data-action="save-connection-edit" data-id="${html(connection.id)}">Save</button>
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
        <button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="runtime-action-confirmation">
          <span class="runtime-action-mark" aria-hidden="true">↻</span>
          <div><strong>${html(name)}</strong><p>Traffic may be interrupted while the container restarts. Its restart policy remains unchanged.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button type="button" class="btn primary" data-action="confirm-restart-docker-container" data-connection="${html(connectionID)}" data-container="${html(containerID)}" data-name="${html(name)}">Restart</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "restart-container-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  function showRestartComposeProjectConfirmation(connectionID, project) {
    closeTopologyContextMenu();
    const count = state.workloads.filter(item => item.connection_id === connectionID && composeProjectName(item) === project).length;
    showModal(`<div class="modal-header">
        <div><h2 id="restart-compose-title" class="modal-title">Restart Compose project?</h2><p class="modal-copy">Docker will restart every container currently in this project.</p></div>
        <button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="runtime-action-confirmation">
          <span class="runtime-action-mark" aria-hidden="true">↻</span>
          <div><strong>${html(project)}</strong><p>${count ? `${count} observed container${count === 1 ? "" : "s"} will be restarted.` : "All matching containers reported by Docker will be restarted."} Service traffic may be interrupted.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button type="button" class="btn primary" data-action="confirm-restart-compose-project" data-connection="${html(connectionID)}" data-project="${html(project)}">Restart project</button>
      </div>`, "confirm-modal");
    modalRoot.querySelector(".modal")?.setAttribute("aria-labelledby", "restart-compose-title");
    modalRoot.querySelector("[autofocus]")?.focus();
  }

  function showDeleteDockerContainerConfirmation(connectionID, containerID, name) {
    closeTopologyContextMenu();
    showModal(`<div class="modal-header">
        <div><h2 id="delete-container-title" class="modal-title">Delete container?</h2><p class="modal-copy">This force-removes the container and cannot be undone.</p></div>
        <button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(name)}</strong><p>Docker will stop the container if needed, then remove it. Compose tooling may recreate it later.</p></div>
        </div>
        <div id="docker-action-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button type="button" class="btn destructive" data-action="confirm-delete-docker-container" data-connection="${html(connectionID)}" data-container="${html(containerID)}" data-name="${html(name)}">Delete container</button>
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
        <button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
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
        <button type="button" class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button type="button" class="btn ${deleting ? "destructive" : "primary"}" data-action="confirm-${operation}-selected-containers">${deleting ? "Delete" : "Restart"} ${count} container${count === 1 ? "" : "s"}</button>
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
        <button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(connection.name)}</strong><p>${description}</p></div>
        </div>
        <div id="remove-connection-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button type="button" class="btn destructive" data-action="confirm-delete-connection" data-id="${html(connection.id)}">Remove</button>
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
        <button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="remove-confirmation">
          <span class="remove-confirmation-mark" aria-hidden="true">!</span>
          <div><strong>${html(profile.name)}</strong><p>Existing connections keep their copy. This removes only the reusable profile.</p></div>
        </div>
        <div id="remove-ssh-profile-error" class="notice error remove-error" role="alert" hidden></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-action="close-modal" autofocus>Cancel</button>
        <button type="button" class="btn destructive" data-action="confirm-delete-ssh-profile" data-id="${html(profile.id)}">Remove</button>
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
