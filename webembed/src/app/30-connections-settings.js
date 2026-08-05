
  async function renderConnections() {
    loadingPage("connections", "Connections");
    await Promise.all([loadConnections(), state.settings ? Promise.resolve() : loadSettings()]);
    drawConnections();
  }

  function drawConnections() {
    const remoteAgents = remoteAgentsAvailable();
    const availableConnections = remoteAgents ? state.connections : state.connections.filter(item => item.mode !== "agent");
    const filter = !remoteAgents && state.connectionFilter === "agents" ? "all" : state.connectionFilter || "all";
    state.connectionFilter = filter;
    const filtered = availableConnections.filter(item => {
      if (filter === "kubernetes") return item.kind === "kubernetes" && item.mode !== "agent";
      if (filter === "docker") return item.kind === "docker" && item.mode !== "agent";
      if (filter === "agents") return remoteAgents && item.mode === "agent";
      return true;
    });
    const attention = availableConnections.filter(item => ["bad", "warn"].includes(connectionStatusClass(item.status?.state))).length;
    shell(`<section class="page connections-page">
      <header class="page-header"><div><h1 class="page-title">Connections</h1></div><div class="header-actions"><button type="button" class="btn primary" data-action="add-connection">Add connection</button></div></header>
      ${availableConnections.length ? `
        <div class="connection-status-strip" aria-label="Connection overview">
          <span><strong>${availableConnections.length}</strong> configured</span>
          <span class="${attention ? "warn" : ""}"><strong>${attention}</strong> need attention</span>
        </div>
        <section class="connection-registry">
          <div class="connection-toolbar">
            <div class="segmented-control" aria-label="Filter connections">
              ${connectionFilterButton("all", "All")}
              ${connectionFilterButton("kubernetes", "Kubernetes")}
              ${connectionFilterButton("docker", "Docker")}
              ${connectionFilterButton("agents", "Agents", !remoteAgents)}
            </div>
          </div>
          <div class="connection-registry-head" aria-hidden="true"><span>Runtime</span><span>Route</span><span>State</span><span>Last contact</span><span>Actions</span></div>
          <div class="connection-registry-body">${filtered.length ? filtered.map(connectionRegistryRow).join("") : `<div class="connection-filter-empty">No connections match this view.</div>`}</div>
        </section>` : connectionOnboarding()}
    </section>`, "connections");
  }

  function connectionFilterButton(value, label, disabled = false) {
    return `<button type="button" class="${state.connectionFilter === value ? "active" : ""}" data-action="filter-connections" data-filter="${value}" ${disabled ? 'disabled title="Coming soon"' : ""}>${label}${disabled ? `<span class="control-note">Coming soon</span>` : ""}</button>`;
  }

  function connectionOnboarding() {
    return `<section class="connection-onboarding">
      <div class="connection-onboarding-copy"><h2>Connect your first runtime</h2></div>
      <div class="connection-choice-list">
        ${connectionChoice("K", "Kubernetes", "Kubeconfig, OpenShift, EKS, GKE, or AKS", "kubernetes")}
        ${connectionChoice("D", "Docker", "Local socket, SSH host, or remote Engine API", "docker")}
        ${connectionChoice("A", "Remote agent", "Kubernetes and Docker", "agent", true)}
      </div>
    </section>`;
  }

  function connectionChoice(symbol, title, copy, kind, disabled = false) {
    return `<button type="button" class="connection-choice ${disabled ? "is-disabled" : ""}" data-action="add-connection-kind" data-kind="${kind}" ${disabled ? 'disabled title="Coming soon"' : ""}>
      <span class="connection-choice-symbol">${symbol}</span><span><strong>${title}</strong><small>${copy}</small></span>${disabled ? `<span class="control-note">Coming soon</span>` : `<span class="connection-choice-arrow">→</span>`}
    </button>`;
  }

  function connectionRegistryRow(item) {
    const status = item.status || { state: "configured" };
    const scope = connectionScope(item);
    const route = item.mode === "agent"
      ? ((item.deployment?.mode === "temporary" || item.agent?.run_mode === "temporary") ? "Temporary agent" : item.ssh ? "SSH-managed agent" : "Remote agent")
      : item.ssh && item.http_proxy ? "SSH + HTTP proxy" : item.ssh ? "SSH" : item.http_proxy ? "HTTP proxy" : "Direct";
    const access = item.kind === "docker"
      ? (item.access_mode === "manage" ? "Manage containers" : "View only")
      : "View only";
    const kindLabel = item.kind === "kubernetes" ? "Kubernetes" : "Docker";
    const symbol = item.kind === "kubernetes" ? "K" : "D";
    const contact = item.mode === "agent" ? (status.last_seen ? relativeTime(status.last_seen) : "Waiting") : "On demand";
    const menuID = `connection-actions-${item.id}`;
    return `<article class="connection-registry-row">
      <div class="connection-runtime"><span class="connection-mark" aria-hidden="true">${symbol}</span><span><strong>${html(item.name)}</strong><small>${html(kindLabel)} · ${html(route)} · ${html(access)}</small></span></div>
      <div class="connection-route" title="${html(scope)}"><strong>${html(scope)}</strong>${status.message ? `<small>${html(status.message)}</small>` : ""}</div>
      <span class="status ${connectionStatusClass(status.state)}">${html(status.state || "configured")}</span>
      <span class="connection-contact">${html(contact)}</span>
      <div class="connection-row-actions">
        <div class="connection-action-menu">
          <button type="button" class="connection-menu-trigger" data-action="toggle-connection-menu" aria-label="Actions for ${html(item.name)}" aria-haspopup="menu" aria-controls="${html(menuID)}" aria-expanded="false">
            <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="4" cy="10" r="1.4"></circle><circle cx="10" cy="10" r="1.4"></circle><circle cx="16" cy="10" r="1.4"></circle></svg>
          </button>
          <div id="${html(menuID)}" class="connection-menu" role="menu" aria-label="${html(item.name)} actions" hidden>
            <button type="button" role="menuitem" data-action="edit-connection" data-id="${html(item.id)}">Edit</button>
            <button type="button" role="menuitem" data-action="view-connection-workloads" data-id="${html(item.id)}">View workloads</button>
            <button type="button" role="menuitem" data-action="test-connection" data-id="${html(item.id)}">Test</button>
            <div class="connection-menu-separator" role="separator"></div>
            <button type="button" class="danger" role="menuitem" data-action="delete-connection" data-id="${html(item.id)}">Delete</button>
          </div>
        </div>
      </div>
    </article>`;
  }

  function closeConnectionMenus(restoreFocus = false) {
    let closedWorkloadMenu = false;
    document.querySelectorAll(".connection-action-menu").forEach(field => {
      const menu = field.querySelector(".connection-menu");
      const trigger = field.querySelector(".connection-menu-trigger");
      if (!menu || menu.hidden) return;
      if (field.classList.contains("workload-action-menu")) {
        closedWorkloadMenu = true;
        state.workloadPendingMenuFocus = restoreFocus && state.workloadViewPending ? menu.id : "";
      }
      menu.hidden = true;
      field.classList.remove("opens-up");
      field.classList.remove("aligns-right");
      trigger?.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger?.focus();
    });
    if (closedWorkloadMenu) flushPendingWorkloadView();
  }

  function workloadActionMenuOpen() {
    return Boolean(document.querySelector("#workload-content .workload-action-menu .connection-menu:not([hidden])"));
  }

  function flushPendingWorkloadView() {
    if (!state.workloadViewPending) return;
    queueMicrotask(() => {
      if (!state.workloadViewPending || state.route?.path !== "/workloads" || state.workloadScrollActive || workloadActionMenuOpen()) return;
      const focusMenuID = state.workloadPendingMenuFocus;
      state.workloadPendingMenuFocus = "";
      state.workloadViewPending = false;
      updateWorkloadView();
      if (!focusMenuID) return;
      const trigger = [...document.querySelectorAll(".workload-action-menu .connection-menu-trigger")]
        .find(item => item.getAttribute("aria-controls") === focusMenuID);
      trigger?.focus();
    });
  }

  function toggleConnectionMenu(field, focusFirst = false) {
    if (!field) return;
    const menu = field.querySelector(".connection-menu");
    const trigger = field.querySelector(".connection-menu-trigger");
    if (!menu || !trigger) return;
    const open = menu.hidden;
    closeConnectionMenus();
    if (!open) return;
    const bounds = field.getBoundingClientRect();
    const roomBelow = window.innerHeight - bounds.bottom;
    field.classList.toggle("opens-up", roomBelow < 210 && bounds.top > roomBelow);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    if (focusFirst) requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus());
  }

  function connectionScope(item) {
    if (item.mode === "agent") {
      if (item.ssh?.host) return `${item.kind === "docker" ? "Docker" : "Kubernetes"} on ${sshTarget(item.ssh)}`;
      const namespaces = item.deployment?.namespaces || item.agent?.namespaces || [];
      return namespaces.length ? namespaces.join(", ") : "All permitted namespaces";
    }
    if (item.ssh?.host) {
      const remote = sshTarget(item.ssh);
      const target = item.kind === "docker" ? `${remote} · ${item.docker?.endpoint || "/var/run/docker.sock"}` : `${remote} · ${item.kubernetes?.kubeconfig_path || "~/.kube/config"}`;
      return item.http_proxy?.display_url ? `${target} · via ${item.http_proxy.display_url}` : target;
    }
    if (item.kind === "docker") {
      const target = item.docker?.endpoint || "Docker Engine";
      return item.http_proxy?.display_url ? `${target} · via ${item.http_proxy.display_url}` : target;
    }
    const source = item.kubernetes?.kubeconfig_source === "stored" ? "Stored kubeconfig" : item.kubernetes?.kubeconfig_path || "Kubeconfig";
    const target = item.kubernetes?.context ? `${source} · ${item.kubernetes.context}` : source;
    return item.http_proxy?.display_url ? `${target} · via ${item.http_proxy.display_url}` : target;
  }

  function sshTarget(value) {
    const user = value?.user ? `${value.user}@` : "";
    const port = value?.port && value.port !== 22 ? `:${value.port}` : "";
    return `${user}${value?.host || "SSH host"}${port}`;
  }

  function connectionStatusClass(value) {
    value = String(value || "").toLowerCase();
    if (/connected|ready/.test(value)) return "good";
    if (/error|failed/.test(value)) return "bad";
    if (/connecting|expir|offline|disconnected/.test(value)) return "warn";
    return "info";
  }

  async function renderSettings() {
    loadingPage("settings", "Settings");
    await Promise.all([loadSettings(), loadSSHProfiles()]);
    if (state.settingsTab === "ssh") {
      renderSSHProfileSettings();
      return;
    }
    const settings = state.settings;
    shell(`<section class="page settings-page">
      <header class="page-header">
        <div><h1 class="page-title">Settings</h1></div>
        <div class="header-actions"><button id="settings-save" class="btn primary" type="submit" form="settings-form" disabled>Saved</button></div>
      </header>
      ${settingsTabs("general")}
      <form id="settings-form" class="settings-instrument">
        <section class="settings-group">
          <div class="settings-group-heading">
            <div><h2>Live defaults</h2><p>Changes apply to new views.</p></div>
          </div>
          <div class="settings-row-list">
            <label class="settings-row">
              <span><strong>Initial log window</strong><small>Lines requested when a live log workbench opens.</small></span>
              <div class="field-with-unit"><input class="field" name="default_tail_lines" type="number" min="0" max="100000" value="${html(settings.default_tail_lines ?? 200)}"><span>lines</span></div>
            </label>
            <label class="settings-row">
              <span><strong>Workload overview refresh</strong><small>How often CPU and memory refresh on the workload list.</small></span>
              <div class="field-with-unit"><input class="field" name="overview_metrics_interval_seconds" type="number" min="10" max="3600" value="${html(settings.overview_metrics_interval_seconds ?? 30)}"><span>seconds</span></div>
            </label>
            <label class="settings-row">
              <span><strong>Open workload metrics</strong><small>Metric cadence while any workload is selected.</small></span>
              <div class="field-with-unit"><input class="field" name="selected_metrics_interval_seconds" type="number" min="1" max="300" value="${html(settings.selected_metrics_interval_seconds ?? 2)}"><span>seconds</span></div>
            </label>
          </div>
        </section>

        <section class="settings-group">
          <div class="settings-group-heading"><div><h2>Application</h2><p>Release checks run only when requested.</p></div></div>
          <div class="settings-row-list">
            <div class="settings-row update-row"><span><strong>Runwake v${html(state.meta?.version || "development")}</strong><small id="update-status">Check GitHub Releases for a newer signed build.</small></span><button type="button" class="btn" data-action="check-for-update">Check for update</button></div>
            <div class="settings-row"><span><strong>Diagnostics</strong><small>Export connection type, stream retry events, version, and status. Credentials and log content are excluded.</small></span><button type="button" class="btn" data-action="export-diagnostics">Export</button></div>
          </div>
        </section>

        <details class="settings-group settings-group-disclosure">
          <summary>
            <span><strong>Legacy Kubernetes over SSH</strong><small>External commands are used only for Kubernetes connections routed through an SSH host.</small></span>
            <span class="settings-group-summary"><span class="settings-policy-label">${settings.exec_plugin_policy === "deny" ? "Never run" : settings.exec_plugin_policy === "allow" ? "Any helper" : "Known helpers"}</span><span class="settings-chevron">›</span></span>
          </summary>
          <div class="settings-group-body">
            <div class="settings-security-layout">
              <label>Default remote kubectl executable<input class="field mono" name="kubectl_path" value="${html(settings.kubectl_path || "kubectl")}"><span class="hint">Used only on SSH hosts; direct connections call the Kubernetes API.</span></label>
              <fieldset class="policy-choices">
                <legend>Credential helper policy</legend>
                ${settingsPolicyChoice("deny", "Never run", "Static tokens and certificates only.", settings.exec_plugin_policy)}
                ${settingsPolicyChoice("allowlist", "Known helpers", "Run only commands named below.", settings.exec_plugin_policy)}
                ${settingsPolicyChoice("allow", "Any helper", "Trust every command in a kubeconfig.", settings.exec_plugin_policy)}
              </fieldset>
              <label id="exec-allowlist-field">Allowed commands<input class="field mono" name="exec_plugin_allowlist" value="${html((settings.exec_plugin_allowlist || []).join(", "))}"><span class="hint">For example: aws, gke-gcloud-auth-plugin, kubelogin, oc.</span></label>
            </div>
          </div>
        </details>
      </form>
    </section>`, "settings");
    const form = document.getElementById("settings-form");
    form.addEventListener("submit", saveSettings);
    const markDirty = () => {
      const button = document.getElementById("settings-save");
      if (!button) return;
      button.disabled = false;
      button.textContent = "Save changes";
    };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    document.querySelectorAll('[name="exec_plugin_policy"]').forEach(input => input.addEventListener("change", updateExecAllowlistVisibility));
    updateExecAllowlistVisibility();
  }

  function settingsTabs(active) {
    return `<nav class="view-tabs settings-tabs" aria-label="Settings sections">
      <button type="button" class="view-tab ${active === "general" ? "active" : ""}" data-action="settings-tab" data-tab="general">General</button>
      <button type="button" class="view-tab ${active === "ssh" ? "active" : ""}" data-action="settings-tab" data-tab="ssh">SSH profiles <span class="tab-count">${state.sshProfiles.length}</span></button>
    </nav>`;
  }

  async function checkForUpdate(button) {
    const status = document.getElementById("update-status");
    if (button) { button.disabled = true; button.textContent = "Checking…"; }
    try {
      const result = await api("/api/v1/update");
      const available = personal.compareVersions(result.latest, result.current) > 0;
      if (status) status.innerHTML = available
        ? `Version ${html(result.latest)} is available. <button type="button" class="table-text-action" data-action="open-release" data-url="${html(result.url)}">View release</button>`
        : `Version ${html(result.current)} is current. Latest release: ${html(result.latest)}.`;
    } catch (error) {
      if (status) status.textContent = `Update check failed: ${error.message}`;
    } finally {
      if (button) { button.disabled = false; button.textContent = "Check again"; }
    }
  }

  function renderSSHProfileSettings() {
    const profiles = state.sshProfiles;
    shell(`<section class="page settings-page">
      <header class="page-header">
        <div><h1 class="page-title">Settings</h1></div>
        <div class="header-actions"><button type="button" class="btn primary" data-action="add-ssh-profile">New profile</button></div>
      </header>
      ${settingsTabs("ssh")}
      <section class="ssh-profile-registry" aria-label="Saved SSH profiles">
        <div class="ssh-profile-registry-head">
          <div><h2>SSH profiles</h2></div>
          <span>${profiles.length} saved</span>
        </div>
        ${profiles.length ? `<div class="ssh-profile-list">${profiles.map(sshProfileRow).join("")}</div>` : `
          <div class="ssh-profile-empty">
            <span class="ssh-profile-empty-mark" aria-hidden="true">SSH</span>
            <div><strong>No SSH profiles yet</strong><p>Create one here or while adding a connection.</p></div>
            <button type="button" class="btn" data-action="add-ssh-profile">Create profile</button>
          </div>`}
      </section>
    </section>`, "settings");
  }

  function sshProfileRow(profile) {
    const auth = profile.has_private_key ? "Stored key" : "SSH agent or default key";
    const verification = profile.host_key_policy === "strict" ? "Known host required" : "Trust first use";
    return `<article class="ssh-profile-row">
      <span class="ssh-profile-mark" aria-hidden="true">S</span>
      <div class="ssh-profile-identity"><strong>${html(profile.name)}</strong><small class="mono">${html(sshProfileTarget(profile))}</small></div>
      <div class="ssh-profile-meta"><span>${auth}</span><span>${verification}</span>${profile.proxy_jump ? `<span>via ${html(profile.proxy_jump)}</span>` : ""}</div>
      <div class="ssh-profile-actions"><button type="button" class="btn small" data-action="test-ssh-profile" data-id="${html(profile.id)}">Test</button><button type="button" class="btn small danger" data-action="delete-ssh-profile" data-id="${html(profile.id)}">Remove</button></div>
    </article>`;
  }

  function sshProfileTarget(profile) {
    const user = profile?.user ? `${profile.user}@` : "";
    const port = profile?.port && profile.port !== 22 ? `:${profile.port}` : "";
    return `${user}${profile?.host || "SSH host"}${port}`;
  }

  function showSSHProfileModal() {
    showModal(`<div class="modal-header"><div><h2 class="modal-title">New SSH profile</h2></div><button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body"><form id="ssh-profile-form">${sshProfileEditorFields()}</form></div>
      <div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="button" class="btn primary" data-action="save-ssh-profile">Save</button></div>`);
    document.querySelector('#ssh-profile-form [name="name"]')?.focus();
  }

  function sshProfilePayload(data, prefix = "") {
    return {
      name: String(data.get(`${prefix}name`) || "").trim(),
      host: String(data.get(`${prefix}host`) || "").trim(),
      port: Number(data.get(`${prefix}port`) || 22),
      user: String(data.get(`${prefix}user`) || "").trim(),
      private_key: String(data.get(`${prefix}private_key`) || "").trim(),
      known_hosts_path: String(data.get(`${prefix}known_hosts_path`) || "").trim(),
      host_key_policy: String(data.get(`${prefix}host_key_policy`) || "accept-new"),
      proxy_jump: String(data.get(`${prefix}proxy_jump`) || "").trim(),
    };
  }

  async function saveSSHProfile() {
    const form = document.getElementById("ssh-profile-form");
    if (!form?.reportValidity()) return;
    const button = modalRoot.querySelector('[data-action="save-ssh-profile"]');
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const profile = await api("/api/v1/ssh-profiles", { method: "POST", body: JSON.stringify(sshProfilePayload(new FormData(form))) });
      state.sshProfiles.push(profile);
      state.sshProfiles.sort((a, b) => a.name.localeCompare(b.name));
      closeModal();
      toast("SSH profile saved");
      if (state.route?.path === "/settings") renderSSHProfileSettings();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Save";
    }
  }

  async function saveInlineSSHProfile() {
    const fieldset = document.getElementById("ssh-inline-create");
    if (!fieldset) return;
    const controls = [...fieldset.querySelectorAll("input, textarea, select")];
    if (!controls.every(control => control.reportValidity())) return;
    const button = fieldset.querySelector('[data-action="save-inline-ssh-profile"]');
    const status = document.getElementById("ssh-profile-save-state");
    button.disabled = true;
    button.textContent = "Saving…";
    status.textContent = "Encrypting credentials…";
    try {
      const data = new FormData(document.getElementById("connection-form"));
      const profile = await api("/api/v1/ssh-profiles", { method: "POST", body: JSON.stringify(sshProfilePayload(data, "ssh_profile_")) });
      state.sshProfiles.push(profile);
      state.sshProfiles.sort((a, b) => a.name.localeCompare(b.name));
      const select = document.getElementById("ssh-profile-select");
      const createOption = select.querySelector('option[value="__new__"]');
      createOption.insertAdjacentHTML("beforebegin", `<option value="${html(profile.id)}">${html(profile.name)} — ${html(sshProfileTarget(profile))}</option>`);
      createOption.textContent = "New SSH profile…";
      select.value = profile.id;
      updateSSHProfileSelection();
      updateDockerConnectionName();
      invalidateConnectionTest();
      toast("SSH profile saved and selected");
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
      button.textContent = "Save profile";
    }
  }

  function settingsPolicyChoice(value, title, copy, selected) {
    return `<label class="policy-choice"><input type="radio" name="exec_plugin_policy" value="${value}" ${selected === value ? "checked" : ""}><span><strong>${title}</strong><small>${copy}</small></span></label>`;
  }

  function updateExecAllowlistVisibility() {
    const field = document.getElementById("exec-allowlist-field");
    const policy = document.querySelector('[name="exec_plugin_policy"]:checked')?.value;
    if (field) field.hidden = policy !== "allowlist";
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = document.getElementById("settings-save");
    button.disabled = true;
    button.textContent = "Saving…";
    let saved = false;
    try {
      const settings = {
        public_url: String(state.settings?.public_url || "").trim(),
        default_agent_image: String(state.settings?.default_agent_image || "").trim(),
        default_tail_lines: Number(data.get("default_tail_lines") || 0),
        overview_metrics_interval_seconds: Number(data.get("overview_metrics_interval_seconds") || 30),
        selected_metrics_interval_seconds: Number(data.get("selected_metrics_interval_seconds") || 2),
        kubectl_path: String(data.get("kubectl_path") || "kubectl").trim(),
        exec_plugin_policy: String(data.get("exec_plugin_policy") || "allowlist"),
        exec_plugin_allowlist: listFrom(data.get("exec_plugin_allowlist")),
      };
      state.settings = await api("/api/v1/settings", { method: "PUT", body: JSON.stringify(settings) });
      toast("Settings saved");
      saved = true;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.textContent = saved ? "Saved" : "Save changes";
      button.disabled = saved;
    }
  }
