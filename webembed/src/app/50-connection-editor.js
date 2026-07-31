  function showAddConnection(kind = "kubernetes") {
    if (kind === "agent" && !remoteAgentsAvailable()) {
      toast("Remote agents are coming soon");
      kind = "kubernetes";
    }
    const settings = state.settings || { exec_plugin_policy: "allowlist", exec_plugin_allowlist: [] };
    const direct = kind !== "agent";
    showModal(`
      <div class="modal-header"><div><h2 class="modal-title">${direct ? "Add connection" : "Create remote agent"}</h2></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="tabs"><button class="tab ${kind === "kubernetes" ? "active" : ""}" data-action="switch-add-kind" data-kind="kubernetes">Kubernetes</button><button class="tab ${kind === "docker" ? "active" : ""}" data-action="switch-add-kind" data-kind="docker">Docker</button><button class="tab ${kind === "agent" ? "active" : ""}" data-action="switch-add-kind" data-kind="agent" ${remoteAgentsAvailable() ? "" : 'disabled title="Coming soon"'}>Remote agent${remoteAgentsAvailable() ? "" : `<span class="control-note">Coming soon</span>`}</button></div>
        <form id="connection-form">
          <input type="hidden" name="kind" value="${kind}">
          ${kind === "kubernetes" ? kubernetesForm(settings) : kind === "docker" ? dockerForm() : remoteAgentForm(settings)}
        </form>
      </div>
      <div class="modal-footer connection-footer">
        ${direct ? `<div id="connection-test-state" class="connection-test-state idle"><span></span><strong>Not tested</strong></div>` : `<div id="connection-test-state" class="connection-test-state idle" hidden><span></span><strong></strong></div>`}
        <div class="connection-footer-actions">
          <button class="btn" data-action="close-modal">Cancel</button>
          ${direct ? `<button class="btn" data-action="test-draft-connection">Test</button><span id="add-connection-gate" class="button-gate locked" tabindex="0" data-tooltip="Test the connection successfully before adding it."><button class="btn primary" data-action="submit-connection" disabled>Add</button></span>` : `<button class="btn" data-action="test-agent-ssh" hidden>Test</button><span id="add-connection-gate" class="button-gate"><button class="btn primary" data-action="submit-connection">Create setup</button></span>`}
        </div>
      </div>`, "wide connection-modal");
    document.getElementById("kube-source")?.addEventListener("change", updateKubeSourceFields);
    document.getElementById("kube-transport")?.addEventListener("change", updateKubeTransportFields);
    document.getElementById("http-proxy-mode")?.addEventListener("change", event => {
      updateHTTPProxyFields();
      if (event.target.value === "http") requestAnimationFrame(() => document.querySelector('[name="http_proxy_url"]')?.focus());
    });
    document.getElementById("kube-platform")?.addEventListener("change", updateKubePlatformFields);
    document.querySelector('[name="kubeconfig"]')?.addEventListener("input", inferKubeconfigMetadata);
    document.getElementById("oc-login-command")?.addEventListener("input", updateOpenShiftLogin);
    for (const id of ["openshift-server-input", "openshift-auth-method", "openshift-token-input", "openshift-username-input", "openshift-password-input", "openshift-insecure-input"]) {
      document.getElementById(id)?.addEventListener("input", () => updateOpenShiftManual());
      document.getElementById(id)?.addEventListener("change", () => updateOpenShiftManual());
    }
    document.getElementById("cloud-credential-command")?.addEventListener("input", applyCloudCommandToFields);
    document.getElementById("cloud-import-button")?.addEventListener("click", importCloudKubeconfig);
    document.querySelector('[name="name"]')?.addEventListener("input", event => {
      delete event.target.dataset.openshiftAutofilled;
      delete event.target.dataset.cloudAutofilled;
      delete event.target.dataset.kubeconfigAutofilled;
      delete event.target.dataset.dockerAutofilled;
    });
    document.querySelector('[name="context"]')?.addEventListener("input", event => delete event.target.dataset.computed);
    document.getElementById("kubeconfig-file")?.addEventListener("change", readKubeconfigFile);
    document.querySelector('[name="endpoint"]')?.addEventListener("input", updateDockerConnectionName);
    document.getElementById("ssh-profile-select")?.addEventListener("change", () => {
      updateSSHProfileSelection();
      updateDockerConnectionName();
    });
    document.getElementById("docker-transport")?.addEventListener("change", updateDockerTransportFields);
    document.getElementById("namespace-mode")?.addEventListener("change", updateNamespaceField);
    document.getElementById("remote-agent-kind")?.addEventListener("change", updateRemoteAgentFields);
    document.getElementById("remote-agent-mode")?.addEventListener("change", updateRemoteAgentFields);
    document.getElementById("remote-agent-namespace-mode")?.addEventListener("change", updateRemoteAgentFields);
    document.getElementById("remote-agent-setup-method")?.addEventListener("change", updateRemoteAgentFields);
    const connectionForm = document.getElementById("connection-form");
    connectionForm.dataset.testPassed = direct ? "false" : "not-required";
    connectionForm.addEventListener("input", invalidateConnectionTest);
    connectionForm.addEventListener("change", invalidateConnectionTest);
    updateKubeSourceFields();
    updateKubeTransportFields();
    updateKubePlatformFields();
    updateNamespaceField();
    updateRemoteAgentFields();
    updateDockerTransportFields();
    updateHTTPProxyFields();
    updateSSHProfileSelection();
    updateDockerConnectionName();
    modalRoot.querySelector(`[data-action="switch-add-kind"][data-kind="${kind}"]`)?.focus();
  }

  function kubernetesForm(settings) {
    return `<div class="form-grid">
      <label class="full">Cluster setup<select id="kube-platform"><option value="kubernetes">Kubernetes kubeconfig</option><option value="openshift">Red Hat OpenShift</option><option value="eks">Amazon EKS</option><option value="gke">Google GKE</option><option value="aks">Microsoft Azure AKS</option></select></label>
      <label class="full">Connection name<input class="field" name="name" placeholder="Production cluster" required></label>
      <div class="full" id="kube-standard-fields">
        <label>Runtime access<select id="kube-transport" name="transport"><option value="direct">From this computer</option><option value="ssh">From an SSH profile</option></select></label>
        ${sshFields()}
        ${httpProxyControl()}
        <label>Kubeconfig source<select id="kube-source" name="kubeconfig_source"><option value="path">Path on this computer</option><option value="upload">Paste or upload a copy</option></select></label>
        <label id="kube-path-field">Kubeconfig path<input class="field mono" name="kubeconfig_path" placeholder="~/.kube/config"><span id="kube-path-hint" class="hint">The path, referenced CA files, client certificates, and exec commands must exist on this computer.</span></label>
        <div id="kube-upload-field" hidden><label>Kubeconfig content<textarea class="mono" name="kubeconfig" placeholder="apiVersion: v1…"></textarea><span class="hint">Referenced files must exist on the Runwake host. Flatten kubeconfigs that reference local-only files before uploading.</span></label><div class="file-input-row"><input id="kubeconfig-file" type="file" accept=".yaml,.yml,.config,text/yaml,application/yaml"></div></div>
      </div>
      <div class="full" id="openshift-login-fields" hidden>
        <label>OpenShift login command <span class="optional-label">Optional</span><textarea id="oc-login-command" class="mono compact-textarea" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="oc login --token=sha256~… --server=https://api.cluster.example:6443"></textarea></label>
        <div class="form-grid provider-fields">
          <label class="full">API server<input id="openshift-server-input" class="field mono" type="url" placeholder="https://api.cluster.example:6443"></label>
          <label>Authentication<select id="openshift-auth-method"><option value="token">Bearer token</option><option value="password">Username and password</option></select></label>
          <label id="openshift-token-field">Token<input id="openshift-token-input" class="field mono" type="password" autocomplete="off" placeholder="sha256~…"></label>
          <label id="openshift-username-field" hidden>Username<input id="openshift-username-input" class="field" autocomplete="username"></label>
          <label id="openshift-password-field" hidden>Password<input id="openshift-password-input" class="field" type="password" autocomplete="current-password"></label>
          <label class="choice full-choice full"><input id="openshift-insecure-input" type="checkbox"><span><span class="choice-title">Skip TLS certificate verification</span><span class="choice-copy">Use only when the cluster uses a certificate this computer cannot verify.</span></span></label>
        </div>
        <div id="openshift-login-status" class="notice info openshift-login-status">Waiting for an <span class="mono">oc login</span> command.</div>
        <div class="openshift-preview" id="openshift-preview" hidden>
          <div><span>Server</span><strong id="openshift-server"></strong></div>
          <div><span>Authentication</span><strong id="openshift-auth"></strong></div>
        </div>
      </div>
      <div class="full" id="cloud-login-fields" hidden>
        <label><span id="cloud-command-label">Cloud credential command</span> <span class="optional-label">Optional</span><textarea id="cloud-credential-command" class="mono compact-textarea" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
        <div id="cloud-provider-fields" class="form-grid provider-fields"></div>
        <div class="cloud-import-row"><button id="cloud-import-button" class="btn small" type="button">Import kubeconfig</button><span id="cloud-cli-requirement" class="hint"></span></div>
        <div id="cloud-import-status" class="notice info cloud-import-status">Paste the provider credential command, then import it.</div>
        <div class="openshift-preview" id="cloud-preview" hidden>
          <div><span>Cluster</span><strong id="cloud-cluster"></strong></div>
          <div><span>Credential helper</span><strong id="cloud-auth"></strong></div>
        </div>
      </div>
      <label>Namespace scope<select id="namespace-mode" name="namespace_mode"><option value="all">All permitted namespaces</option><option value="selected">Selected namespaces</option></select></label>
      <label id="namespace-field" hidden>Namespaces<input class="field" name="namespaces" placeholder="payments, platform"></label>
    </div>
    <details id="kube-advanced-options" class="kube-overrides">
      <summary>
        <span class="kube-overrides-copy"><strong>Cluster access overrides</strong><small>Context and legacy SSH connection options</small></span>
        <span class="kube-overrides-toggle"><span class="kube-overrides-action"><span class="when-closed">Configure</span><span class="when-open">Hide</span></span><span class="kube-overrides-chevron" aria-hidden="true">›</span></span>
      </summary>
      <div class="kube-overrides-body">
        <div class="form-grid">
          <label class="full">Context override<input class="field mono" name="context" placeholder="production"></label>
          <label id="kube-kubectl-field" hidden>Remote kubectl executable<input class="field mono" name="kubectl_path" placeholder="${html(settings.kubectl_path || "kubectl")}"></label>
          <label id="kube-exec-policy-field" hidden>Exec credential plugins<select name="exec_policy"><option value="deny" ${settings.exec_plugin_policy === "deny" ? "selected" : ""}>Deny</option><option value="allowlist" ${settings.exec_plugin_policy === "allowlist" ? "selected" : ""}>Allow listed commands</option><option value="allow" ${settings.exec_plugin_policy === "allow" ? "selected" : ""}>Allow all kubeconfig exec commands</option></select></label>
          <label id="kube-exec-allowlist-field" class="full" hidden>Allowed exec commands<input class="field mono" name="exec_allowlist" value="${html((settings.exec_plugin_allowlist || []).join(", "))}"><span class="hint">Examples include aws, oc, az, gcloud, kubelogin, and custom organization login tools.</span></label>
          <label id="kube-environment-field" class="full" hidden>Environment overrides<textarea class="mono" name="environment" placeholder="AWS_PROFILE=production&#10;AZURE_CONFIG_DIR=/runwake/azure"></textarea><span class="hint">Passed to kubectl and credential plugins on the SSH host.</span></label>
        </div>
      </div>
    </details>`;
  }

  function dockerForm() {
    return `<div class="form-grid">
      <label>Connection name<input class="field" name="name" placeholder="Local Docker" required></label>
      <label>Runtime access<select id="docker-transport" name="transport"><option value="local">Local socket</option><option value="ssh">From an SSH profile</option><option value="api">Remote Engine API</option></select><span id="runtime-access-hint" class="hint" hidden></span></label>
      ${sshFields()}
      ${httpProxyControl()}
      <label id="docker-endpoint-field" class="full">Engine endpoint<input class="field mono" name="endpoint" value="unix:///var/run/docker.sock" required><span id="docker-endpoint-hint" class="hint" hidden></span></label>
      <fieldset class="runtime-permission full">
        <legend>Docker permissions</legend>
        <div class="runtime-permission-options">
          <label class="choice"><input type="radio" name="access_mode" value="read_only" checked><span><span class="choice-title">View only</span><span class="choice-copy">Inspect containers, logs, events, and metrics without changing workloads.</span></span></label>
          <label class="choice"><input type="radio" name="access_mode" value="manage"><span><span class="choice-title">Manage containers</span><span class="choice-copy">Restart or delete containers, and restart Compose projects.</span></span></label>
        </div>
        <p class="runtime-permission-note">Runwake enforces this choice in its interface and API. The Docker endpoint itself remains privileged.</p>
      </fieldset>
    </div>
    <details id="docker-tls-options" class="disclosure" hidden><summary>TLS client authentication</summary>
      <div class="form-grid">
        <label class="full">Server name<input class="field mono" name="tls_server_name" placeholder="docker.example.com"></label>
        <label class="full">CA certificate<textarea class="mono" name="tls_ca" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label>
        <label>Client certificate<textarea class="mono" name="tls_cert" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label>
        <label>Client private key<textarea class="mono" name="tls_key" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></label>
      </div>
    </details>`;
  }

  function remoteAgentForm(settings) {
    return `<div class="form-grid">
      <label>Connection name<input class="field" name="name" placeholder="Production agent" required></label>
      <label>Target<select id="remote-agent-kind" name="agent_kind"><option value="kubernetes">Kubernetes cluster</option><option value="docker">Docker host</option></select></label>
      <label class="full">Setup method<select id="remote-agent-setup-method" name="setup_method"><option value="instructions">Generate setup instructions</option><option value="ssh">Install over SSH</option></select></label>
      ${sshFields()}
      <label id="remote-agent-kubeconfig-field" class="full" hidden>Remote kubeconfig path<input class="field mono" name="remote_kubeconfig_path" value="~/.kube/config"><span class="hint">Path on the SSH host.</span></label>
      <label id="remote-agent-kubectl-field" hidden>Remote kubectl executable<input class="field mono" name="remote_kubectl_path" value="kubectl"></label>
      <label id="remote-agent-docker-socket-field" class="full" hidden>Remote Docker socket<input class="field mono" name="docker_socket_path" value="/var/run/docker.sock"></label>
      <label>Run mode<select id="remote-agent-mode" name="mode"><option value="persistent">Persistent</option><option value="temporary">Temporary</option></select></label>
      <label id="remote-agent-ttl-field" hidden>Lifetime in minutes<input class="field" name="ttl_minutes" type="number" min="1" value="30"></label>
      <label class="full">Runwake server URL<input class="field mono" name="server_url" type="url" value="${html(settings.public_url || "")}" placeholder="https://runwake.example.com" required><span class="hint">Must be reachable from the target.</span></label>
      <label class="full">Agent image<input class="field mono" name="image" value="${html(settings.default_agent_image || "")}" placeholder="registry.example.com/runwake-agent:0.1.0" required></label>
      <label id="remote-agent-namespace-field">Agent namespace<input class="field mono" name="agent_namespace" value="runwake-system"></label>
      <label id="remote-agent-scope-field">Workload namespace scope<select id="remote-agent-namespace-mode" name="namespace_mode"><option value="all">All permitted namespaces</option><option value="selected">Selected namespaces</option></select></label>
      <label id="remote-agent-namespaces-field" class="full" hidden>Namespaces<input class="field" name="namespaces" placeholder="payments, platform"></label>
    </div>
    <div id="remote-agent-docker-warning" class="notice mt-16" hidden>Docker agents require privileged socket access.</div>`;
  }

  function sshFields() {
    const options = state.sshProfiles.map(profile => `<option value="${html(profile.id)}">${html(profile.name)} — ${html(sshProfileTarget(profile))}</option>`).join("");
    return `<section id="ssh-fields" class="full ssh-profile-picker" hidden>
      <div class="ssh-profile-picker-main">
        <label>SSH profile<select id="ssh-profile-select" name="ssh_profile_id">${options}<option value="__new__">${state.sshProfiles.length ? "New SSH profile…" : "Create your first SSH profile"}</option></select></label>
        <div id="ssh-profile-summary" class="ssh-profile-summary"></div>
      </div>
      <fieldset id="ssh-inline-create" class="ssh-inline-create" ${state.sshProfiles.length ? "hidden disabled" : ""}>
        <div class="ssh-inline-heading"><div><strong>New SSH profile</strong></div><button class="btn ghost small" type="button" data-action="cancel-inline-ssh" ${state.sshProfiles.length ? "" : "hidden"}>Cancel</button></div>
        ${sshProfileEditorFields("ssh_profile_", true)}
      </fieldset>
    </section>`;
  }

  function httpProxyControl() {
    return `<section id="http-proxy-control" class="full http-proxy-control">
      <label>HTTP proxy<select id="http-proxy-mode" name="http_proxy_mode"><option value="none">No proxy</option><option value="http">Use an HTTP proxy</option></select><span id="http-proxy-hint" class="hint" hidden></span></label>
      <fieldset id="http-proxy-fields" class="http-proxy-fields" hidden disabled>
        <label>Proxy URL<input class="field mono" name="http_proxy_url" autocomplete="off" placeholder="http://proxy.example.com:8080" required></label>
        <label>Bypass proxy <span class="optional-label">Optional</span><input class="field mono" name="http_proxy_no_proxy" placeholder="localhost, 127.0.0.1, .svc"><span class="hint">Hosts, domains, IP ranges, or ports that should connect directly.</span></label>
      </fieldset>
    </section>`;
  }

  function sshProfileEditorFields(prefix = "", inline = false) {
    return `<div class="ssh-profile-editor-grid">
      <label>Profile name<input class="field" name="${prefix}name" placeholder="Production bastion" required></label>
      <label>Host<input class="field mono" name="${prefix}host" autocomplete="off" placeholder="server.example.com" required></label>
      <label>User <span class="optional-label">Optional</span><input class="field mono" name="${prefix}user" autocomplete="username" placeholder="ubuntu"></label>
      <label>Port<input class="field" name="${prefix}port" type="number" min="1" max="65535" value="22" required></label>
    </div>
    ${inline ? `<div class="ssh-inline-actions"><span id="ssh-profile-save-state" class="hint">Test the full runtime after saving.</span><button class="btn small" type="button" data-action="save-inline-ssh-profile">Save profile</button></div>` : ""}
    <details class="ssh-profile-details">
      <summary><span><strong>Authentication and routing</strong><small>Default keys, host verification, and jump host</small></span><span class="settings-chevron">›</span></summary>
      <div class="ssh-profile-details-body">
        <label>Private key <span class="optional-label">Optional</span><textarea class="mono compact-textarea" name="${prefix}private_key" autocomplete="off" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea><span class="hint">Leave blank to use your SSH agent, SSH config, or default keys.</span></label>
        <div class="ssh-profile-editor-grid">
          <label>Host verification<select name="${prefix}host_key_policy"><option value="accept-new">Trust new hosts; reject changes</option><option value="strict">Require a known-host entry</option></select></label>
          <label>Known hosts file <span class="optional-label">Optional</span><input class="field mono" name="${prefix}known_hosts_path" placeholder="~/.ssh/known_hosts"></label>
          <label class="full">Jump host <span class="optional-label">Optional</span><input class="field mono" name="${prefix}proxy_jump" placeholder="bastion.example.com"></label>
        </div>
      </div>
    </details>`;
  }

  function updateSSHProfileSelection() {
    const picker = document.getElementById("ssh-fields");
    const select = document.getElementById("ssh-profile-select");
    const creator = document.getElementById("ssh-inline-create");
    const summary = document.getElementById("ssh-profile-summary");
    if (!picker || !select || !creator || !summary) return;
    const creating = select.value === "__new__";
    creator.hidden = !creating;
    creator.disabled = picker.hidden || !creating;
    const profile = state.sshProfiles.find(item => item.id === select.value);
    summary.hidden = !profile;
    summary.innerHTML = profile ? `<span><strong>${html(sshProfileTarget(profile))}</strong><small>${profile.has_private_key ? "Stored key" : "SSH agent or default key"}${profile.proxy_jump ? ` · via ${html(profile.proxy_jump)}` : ""}</small></span><button class="btn ghost small" type="button" data-action="manage-ssh-profiles">Manage</button>` : "";
  }

  function updateRemoteAgentFields() {
    const kind = document.getElementById("remote-agent-kind")?.value;
    const mode = document.getElementById("remote-agent-mode")?.value;
    const namespaceMode = document.getElementById("remote-agent-namespace-mode")?.value;
    const setupMethod = document.getElementById("remote-agent-setup-method")?.value;
    const useSSH = setupMethod === "ssh";
    for (const id of ["remote-agent-namespace-field", "remote-agent-scope-field"]) {
      const field = document.getElementById(id);
      if (field) field.hidden = kind !== "kubernetes";
    }
    const namespaces = document.getElementById("remote-agent-namespaces-field");
    if (namespaces) namespaces.hidden = kind !== "kubernetes" || namespaceMode !== "selected";
    const ttl = document.getElementById("remote-agent-ttl-field");
    if (ttl) ttl.hidden = mode !== "temporary";
    setSSHFieldsVisible(useSSH);
    const kubeconfig = document.getElementById("remote-agent-kubeconfig-field");
    const kubectl = document.getElementById("remote-agent-kubectl-field");
    const dockerSocket = document.getElementById("remote-agent-docker-socket-field");
    const dockerWarning = document.getElementById("remote-agent-docker-warning");
    if (kubeconfig) kubeconfig.hidden = !useSSH || kind !== "kubernetes";
    if (kubectl) kubectl.hidden = !useSSH || kind !== "kubernetes";
    if (dockerSocket) dockerSocket.hidden = !useSSH || kind !== "docker";
    if (dockerWarning) dockerWarning.hidden = kind !== "docker";
    const form = document.getElementById("connection-form");
    const test = modalRoot.querySelector('[data-action="test-agent-ssh"]');
    const submit = modalRoot.querySelector('[data-action="submit-connection"]');
    const gate = document.getElementById("add-connection-gate");
    const testState = document.getElementById("connection-test-state");
    if (!form || !test || !submit || !gate) return;
    test.hidden = !useSSH;
    if (testState) testState.hidden = !useSSH;
    submit.textContent = useSSH ? "Install" : "Create setup";
    submit.disabled = useSSH;
    form.dataset.testPassed = useSSH ? "false" : "not-required";
    gate.classList.toggle("locked", useSSH);
    gate.toggleAttribute("tabindex", useSSH);
    gate.tabIndex = useSSH ? 0 : -1;
    if (useSSH) {
      gate.dataset.tooltip = "Test the SSH target successfully before installing.";
      updateConnectionTestState("idle", "Not tested");
    } else {
      gate.removeAttribute("data-tooltip");
      gate.removeAttribute("tabindex");
    }
  }

  function updateKubeSourceFields() {
    const value = document.getElementById("kube-source")?.value;
    const path = document.getElementById("kube-path-field");
    const upload = document.getElementById("kube-upload-field");
    if (path) path.hidden = value !== "path";
    if (upload) upload.hidden = value !== "upload";
  }

  function updateKubeTransportFields() {
    const useSSH = document.getElementById("kube-transport")?.value === "ssh";
    if (!document.getElementById("kube-transport")) return;
    setSSHFieldsVisible(useSSH);
    const accessHint = document.getElementById("runtime-access-hint");
    if (accessHint) accessHint.textContent = useSSH ? "kubectl runs on the selected SSH host." : "Runwake connects directly to the Kubernetes API; kubectl is not required.";
    for (const id of ["kube-kubectl-field", "kube-exec-policy-field", "kube-exec-allowlist-field", "kube-environment-field"]) {
      const field = document.getElementById(id);
      if (field) field.hidden = !useSSH;
    }
    const source = document.getElementById("kube-source");
    const path = document.querySelector('[name="kubeconfig_path"]');
    const hint = document.getElementById("kube-path-hint");
    if (source) {
      if (useSSH) source.value = "path";
      source.disabled = useSSH;
      const pathOption = source.querySelector('option[value="path"]');
      if (pathOption) pathOption.textContent = useSSH ? "Path on the SSH host" : "Path on this computer";
    }
    if (path && useSSH && (!path.value || path.value === "~/.kube/config")) path.value = "~/.kube/config";
    if (hint) hint.textContent = useSSH
      ? "The path, referenced files, kubectl, and credential helpers must exist on the SSH host."
      : "The path and any referenced CA or client-certificate files must exist on this computer.";
    updateHTTPProxyFields();
    updateKubeSourceFields();
  }

  function updateDockerTransportFields() {
    const transport = document.getElementById("docker-transport")?.value;
    if (!transport) return;
    const useSSH = transport === "ssh";
    setSSHFieldsVisible(useSSH);
    const accessHint = document.getElementById("runtime-access-hint");
    if (accessHint) {
      accessHint.hidden = transport === "local";
      accessHint.textContent = useSSH
        ? "Docker commands run on the selected SSH host."
        : transport === "api" ? "Runwake connects from this computer." : "";
    }
    const proxyControl = document.getElementById("http-proxy-control");
    const proxyMode = document.getElementById("http-proxy-mode");
    if (proxyControl) proxyControl.hidden = transport === "local";
    if (proxyMode) proxyMode.disabled = transport === "local";
    const endpoint = document.querySelector('[name="endpoint"]');
    const hint = document.getElementById("docker-endpoint-hint");
    const tls = document.getElementById("docker-tls-options");
    if (endpoint) {
      const defaults = ["unix:///var/run/docker.sock", "/var/run/docker.sock", "tcp://docker.example.com:2376"];
      if (!endpoint.value || defaults.includes(endpoint.value)) {
        endpoint.value = useSSH ? "/var/run/docker.sock" : transport === "api" ? "tcp://docker.example.com:2376" : "unix:///var/run/docker.sock";
      }
    }
    if (hint) {
      hint.hidden = transport === "local";
      hint.textContent = useSSH
        ? "Socket path or Engine API reachable from the SSH host. Requires the Docker CLI."
        : transport === "api" ? "HTTP or TLS Docker Engine endpoint." : "";
    }
    if (tls) tls.hidden = transport !== "api";
    updateHTTPProxyFields();
    updateDockerConnectionName();
  }

  function updateHTTPProxyFields() {
    const control = document.getElementById("http-proxy-control");
    const mode = document.getElementById("http-proxy-mode");
    const fields = document.getElementById("http-proxy-fields");
    const hint = document.getElementById("http-proxy-hint");
    if (!control || !mode || !fields) return;
    const enabled = !control.hidden && !mode.disabled && mode.value === "http";
    fields.hidden = !enabled;
    fields.disabled = !enabled;
    const useSSH = document.getElementById("kube-transport")?.value === "ssh" || document.getElementById("docker-transport")?.value === "ssh";
    if (hint) {
      hint.hidden = !enabled;
      hint.textContent = useSSH ? "Must be reachable from the selected SSH host." : "Must be reachable from this computer.";
    }
  }

  function setSSHFieldsVisible(visible) {
    const fields = document.getElementById("ssh-fields");
    if (!fields) return;
    fields.hidden = !visible;
    const select = document.getElementById("ssh-profile-select");
    if (select) select.required = visible;
    updateSSHProfileSelection();
  }

  function updateKubePlatformFields() {
    const platform = document.getElementById("kube-platform")?.value || "kubernetes";
    const openshift = platform === "openshift";
    const cloud = ["eks", "gke", "aks"].includes(platform);
    const name = document.querySelector('[name="name"]');
    const context = document.querySelector('[name="context"]');
    if (name && ((openshift && (name.dataset.cloudAutofilled === "true" || name.dataset.kubeconfigAutofilled === "true")) || (cloud && (name.dataset.openshiftAutofilled === "true" || name.dataset.kubeconfigAutofilled === "true")) || (!openshift && !cloud && (name.dataset.cloudAutofilled === "true" || name.dataset.openshiftAutofilled === "true")))) {
      name.value = "";
      delete name.dataset.cloudAutofilled;
      delete name.dataset.openshiftAutofilled;
      delete name.dataset.kubeconfigAutofilled;
    }
    if (!openshift && context?.value === "runwake-openshift") context.value = "";
    if (cloud && context?.dataset.computed === "true") {
      context.value = "";
      delete context.dataset.computed;
    }
    const standard = document.getElementById("kube-standard-fields");
    const login = document.getElementById("openshift-login-fields");
    const cloudLogin = document.getElementById("cloud-login-fields");
    const advanced = document.getElementById("kube-advanced-options");
    const source = document.getElementById("kube-source");
    const transport = document.getElementById("kube-transport");
    if (standard) standard.hidden = openshift || cloud;
    if (login) login.hidden = !openshift;
    if (cloudLogin) cloudLogin.hidden = !cloud;
    if (advanced) advanced.hidden = openshift || cloud;
    if (source && (openshift || cloud)) {
      if (transport) transport.value = "direct";
      updateKubeTransportFields();
      source.value = "upload";
      if (openshift) updateOpenShiftLogin();
      if (cloud) updateCloudImportFields(platform);
    } else {
      updateKubeSourceFields();
    }
  }

  function updateCloudImportFields(provider) {
    const options = {
      eks: {
        label: "AWS credential command",
        placeholder: "aws eks update-kubeconfig --region us-east-1 --name production",
        requirement: "Requires a signed-in AWS CLI.",
      },
      gke: {
        label: "Google Cloud credential command",
        placeholder: "gcloud container clusters get-credentials production --location us-central1 --project my-project",
        requirement: "Requires a signed-in gcloud CLI.",
      },
      aks: {
        label: "Azure credential command",
        placeholder: "az aks get-credentials --resource-group platform --name production",
        requirement: "Requires a signed-in Azure CLI.",
      },
    };
    const option = options[provider];
    const command = document.getElementById("cloud-credential-command");
    if (command) {
      if (command.dataset.provider && command.dataset.provider !== provider) command.value = "";
      command.dataset.provider = provider;
      command.placeholder = option.placeholder;
    }
    document.getElementById("cloud-command-label").textContent = option.label;
    document.getElementById("cloud-cli-requirement").textContent = option.requirement;
    renderCloudProviderFields(provider);
    const status = document.getElementById("cloud-import-status");
    if (status) {
      status.className = "notice info cloud-import-status";
      status.textContent = "Paste the provider credential command, then import it.";
    }
    const preview = document.getElementById("cloud-preview");
    if (preview) preview.hidden = true;
    const kubeconfig = document.querySelector('[name="kubeconfig"]');
    if (kubeconfig) kubeconfig.value = "";
  }

  function renderCloudProviderFields(provider) {
    const fields = document.getElementById("cloud-provider-fields");
    if (!fields) return;
    if (provider === "eks") {
      fields.innerHTML = `
        <label>Cluster name<input id="cloud-cluster-name-input" class="field" placeholder="production"></label>
        <label>AWS region<input id="cloud-region-input" class="field mono" placeholder="us-east-1"></label>
        <label>AWS profile <span class="optional-label">Optional</span><input id="cloud-profile-input" class="field mono" placeholder="production"></label>
        <label>Authentication role ARN <span class="optional-label">Optional</span><input id="cloud-role-input" class="field mono" placeholder="arn:aws:iam::…:role/…"></label>`;
    } else if (provider === "gke") {
      fields.innerHTML = `
        <label>Cluster name<input id="cloud-cluster-name-input" class="field" placeholder="production"></label>
        <label>Location<input id="cloud-location-input" class="field mono" placeholder="us-central1"></label>
        <label>Google Cloud project<input id="cloud-project-input" class="field mono" placeholder="my-project"></label>
        <label>Google account <span class="optional-label">Optional</span><input id="cloud-account-input" class="field mono" type="email" placeholder="operator@example.com"></label>`;
    } else {
      fields.innerHTML = `
        <label>Cluster name<input id="cloud-cluster-name-input" class="field" placeholder="production"></label>
        <label>Resource group<input id="cloud-resource-group-input" class="field" placeholder="platform"></label>
        <label>Azure subscription <span class="optional-label">Optional</span><input id="cloud-subscription-input" class="field mono" placeholder="name or subscription ID"></label>
        <label class="choice full-choice"><input id="cloud-admin-input" type="checkbox"><span><span class="choice-title">Use cluster administrator credentials</span><span class="choice-copy">Prefer normal user credentials unless break-glass access is required.</span></span></label>`;
    }
    fields.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", updateCloudCommandFromFields);
      input.addEventListener("change", updateCloudCommandFromFields);
    });
  }

  function updateCloudCommandFromFields() {
    const provider = document.getElementById("kube-platform")?.value;
    const cluster = cloudFieldValue("cloud-cluster-name-input");
    updateComputedConnectionName(cloudProviderName(provider), cluster, "cloudAutofilled");
    const parts = [];
    if (provider === "eks" && cluster) {
      parts.push("aws", "eks", "update-kubeconfig");
      addCommandOption(parts, "--region", cloudFieldValue("cloud-region-input"));
      addCommandOption(parts, "--name", cluster);
      addCommandOption(parts, "--profile", cloudFieldValue("cloud-profile-input"));
      addCommandOption(parts, "--role-arn", cloudFieldValue("cloud-role-input"));
    } else if (provider === "gke" && cluster) {
      parts.push("gcloud", "container", "clusters", "get-credentials", cluster);
      addCommandOption(parts, "--location", cloudFieldValue("cloud-location-input"));
      addCommandOption(parts, "--project", cloudFieldValue("cloud-project-input"));
      addCommandOption(parts, "--account", cloudFieldValue("cloud-account-input"));
    } else if (provider === "aks" && cluster && cloudFieldValue("cloud-resource-group-input")) {
      parts.push("az", "aks", "get-credentials");
      addCommandOption(parts, "--resource-group", cloudFieldValue("cloud-resource-group-input"));
      addCommandOption(parts, "--name", cluster);
      addCommandOption(parts, "--subscription", cloudFieldValue("cloud-subscription-input"));
      if (document.getElementById("cloud-admin-input")?.checked) parts.push("--admin");
    }
    const command = document.getElementById("cloud-credential-command");
    if (command) command.value = parts.map(commandShellQuote).join(" ");
    resetCloudImport(parts.length ? "Command ready. Import it to retrieve the cluster kubeconfig." : "Fill the required cluster fields or paste a credential command.");
  }

  function applyCloudCommandToFields() {
    const provider = document.getElementById("kube-platform")?.value;
    if (!["eks", "gke", "aks"].includes(provider)) return;
    const command = document.getElementById("cloud-credential-command")?.value.trim();
    if (!command) {
      resetCloudImport("Fill the required cluster fields or paste a credential command.");
      return;
    }
    try {
      const args = shellWords(command);
      if (provider === "eks") {
        requireCommandPrefix(args, ["aws", "eks", "update-kubeconfig"]);
        setCloudField("cloud-cluster-name-input", commandOption(args, "--name"));
        setCloudField("cloud-region-input", commandOption(args, "--region"));
        setCloudField("cloud-profile-input", commandOption(args, "--profile"));
        setCloudField("cloud-role-input", commandOption(args, "--role-arn"));
      } else if (provider === "gke") {
        requireCommandPrefix(args, ["gcloud", "container", "clusters", "get-credentials"]);
        setCloudField("cloud-cluster-name-input", args[4] && !args[4].startsWith("-") ? args[4] : "");
        setCloudField("cloud-location-input", commandOption(args, "--location", "--region", "--zone", "-z"));
        setCloudField("cloud-project-input", commandOption(args, "--project"));
        setCloudField("cloud-account-input", commandOption(args, "--account"));
      } else {
        requireCommandPrefix(args, ["az", "aks", "get-credentials"]);
        setCloudField("cloud-cluster-name-input", commandOption(args, "--name", "-n"));
        setCloudField("cloud-resource-group-input", commandOption(args, "--resource-group", "-g"));
        setCloudField("cloud-subscription-input", commandOption(args, "--subscription"));
        const admin = document.getElementById("cloud-admin-input");
        if (admin) admin.checked = args.includes("--admin") || args.includes("-a");
      }
      resetCloudImport("Fields filled from the command. Review them, then import the kubeconfig.");
    } catch (error) {
      const status = document.getElementById("cloud-import-status");
      status.className = "notice error cloud-import-status";
      status.textContent = error.message;
    }
  }

  function resetCloudImport(message) {
    const kubeconfig = document.querySelector('[name="kubeconfig"]');
    if (kubeconfig) kubeconfig.value = "";
    const preview = document.getElementById("cloud-preview");
    if (preview) preview.hidden = true;
    const status = document.getElementById("cloud-import-status");
    if (status) {
      status.className = "notice info cloud-import-status";
      status.textContent = message;
    }
  }

  function cloudFieldValue(id) {
    return document.getElementById(id)?.value.trim() || "";
  }

  function setCloudField(id, value) {
    const field = document.getElementById(id);
    if (field) field.value = value || "";
  }

  function addCommandOption(parts, option, value) {
    if (value) parts.push(option, value);
  }

  function requireCommandPrefix(args, prefix) {
    if (!prefix.every((part, index) => args[index]?.toLowerCase() === part)) {
      throw new Error(`Paste a ${prefix.join(" ")} command for this provider.`);
    }
  }

  function commandOption(args, ...names) {
    for (let index = 0; index < args.length; index += 1) {
      for (const name of names) {
        if (args[index] === name) return args[index + 1] || "";
        if (args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
      }
    }
    return "";
  }

  async function importCloudKubeconfig() {
    invalidateConnectionTest();
    const provider = document.getElementById("kube-platform")?.value;
    const command = document.getElementById("cloud-credential-command")?.value.trim();
    const button = document.getElementById("cloud-import-button");
    const status = document.getElementById("cloud-import-status");
    const preview = document.getElementById("cloud-preview");
    if (!command) {
      status.className = "notice error cloud-import-status";
      status.textContent = "Fill the cluster fields or paste a cloud credential command first.";
      return;
    }
    button.disabled = true;
    button.textContent = "Importing…";
    status.className = "notice info cloud-import-status";
    status.textContent = "Contacting the cloud provider and generating a temporary kubeconfig…";
    try {
      const response = await api("/api/v1/kubernetes/import-cloud", {
        method: "POST",
        body: JSON.stringify({ provider, command }),
      });
      document.getElementById("kube-source").value = "upload";
      document.querySelector('[name="kubeconfig"]').value = response.kubeconfig;
      document.querySelector('[name="context"]').value = "";
      const name = document.querySelector('[name="name"]');
      if (!name.value || name.dataset.cloudAutofilled === "true" || name.dataset.openshiftAutofilled === "true" || name.dataset.kubeconfigAutofilled === "true") {
        name.value = `${cloudProviderName(provider)} · ${response.name}`;
        name.dataset.cloudAutofilled = "true";
        delete name.dataset.openshiftAutofilled;
      }
      const policy = document.querySelector('[name="exec_policy"]');
      if (policy) policy.value = "allowlist";
      const allowlist = document.querySelector('[name="exec_allowlist"]');
      if (allowlist) allowlist.value = (response.exec_allowlist || []).join(", ");
      const environment = document.querySelector('[name="environment"]');
      if (environment && response.environment) {
        environment.value = Object.entries(response.environment).map(([key, value]) => `${key}=${value}`).join("\n");
      }
      document.getElementById("cloud-cluster").textContent = response.name;
      document.getElementById("cloud-auth").textContent = (response.exec_allowlist || []).join(", ") || "Embedded credentials";
      if (preview) preview.hidden = false;
      status.className = "notice info cloud-import-status";
      status.textContent = "Kubeconfig imported. Keep the cloud CLI session signed in so its credential helper can refresh tokens.";
    } catch (error) {
      if (preview) preview.hidden = true;
      status.className = "notice error cloud-import-status";
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Import kubeconfig";
    }
  }

  function cloudProviderName(provider) {
    return { eks: "Amazon EKS", gke: "Google GKE", aks: "Azure AKS" }[provider] || "Kubernetes";
  }

  function updateOpenShiftLogin() {
    if (document.getElementById("kube-platform")?.value !== "openshift") return;
    const command = document.getElementById("oc-login-command")?.value || "";
    try {
      const parsed = parseOCLogin(command);
      if (!parsed) {
        updateOpenShiftManual(true);
        return;
      }
      document.getElementById("openshift-server-input").value = parsed.server;
      document.getElementById("openshift-auth-method").value = parsed.token ? "token" : "password";
      document.getElementById("openshift-token-input").value = parsed.token;
      document.getElementById("openshift-username-input").value = parsed.username;
      document.getElementById("openshift-password-input").value = parsed.password;
      document.getElementById("openshift-insecure-input").checked = parsed.insecure;
      updateOpenShiftManual(true);
    } catch (error) {
      const preview = document.getElementById("openshift-preview");
      const kubeconfig = document.querySelector('[name="kubeconfig"]');
      const status = document.getElementById("openshift-login-status");
      if (preview) preview.hidden = true;
      if (kubeconfig) kubeconfig.value = "";
      if (status) {
        status.className = "notice error openshift-login-status";
        status.textContent = error.message;
      }
    }
  }

  function updateOpenShiftManual(preserveCommand = false) {
    if (document.getElementById("kube-platform")?.value !== "openshift") return;
    const method = document.getElementById("openshift-auth-method")?.value || "token";
    const tokenField = document.getElementById("openshift-token-field");
    const usernameField = document.getElementById("openshift-username-field");
    const passwordField = document.getElementById("openshift-password-field");
    if (tokenField) tokenField.hidden = method !== "token";
    if (usernameField) usernameField.hidden = method !== "password";
    if (passwordField) passwordField.hidden = method !== "password";
    const login = {
      server: document.getElementById("openshift-server-input")?.value.trim() || "",
      token: method === "token" ? document.getElementById("openshift-token-input")?.value.trim() || "" : "",
      username: method === "password" ? document.getElementById("openshift-username-input")?.value.trim() || "" : "",
      password: method === "password" ? document.getElementById("openshift-password-input")?.value || "" : "",
      insecure: Boolean(document.getElementById("openshift-insecure-input")?.checked),
      certificateAuthority: "",
    };
    const status = document.getElementById("openshift-login-status");
    const preview = document.getElementById("openshift-preview");
    const kubeconfig = document.querySelector('[name="kubeconfig"]');
    if (!login.server || (method === "token" ? !login.token : !(login.username && login.password))) {
      if (preview) preview.hidden = true;
      if (kubeconfig) kubeconfig.value = "";
      status.className = "notice info openshift-login-status";
      status.textContent = "Enter the API server and authentication details, or paste an oc login command.";
      return;
    }
    let serverURL;
    try {
      serverURL = new URL(login.server);
      if (!["https:", "http:"].includes(serverURL.protocol)) throw new Error();
    } catch {
      if (preview) preview.hidden = true;
      if (kubeconfig) kubeconfig.value = "";
      status.className = "notice error openshift-login-status";
      status.textContent = "Enter a valid HTTP or HTTPS OpenShift API server URL.";
      return;
    }
    login.server = serverURL.toString().replace(/\/$/, "");
    document.getElementById("openshift-server-input").value = login.server;
    document.getElementById("kube-source").value = "upload";
    if (kubeconfig) kubeconfig.value = openShiftKubeconfig(login);
    document.querySelector('[name="context"]').value = "runwake-openshift";
    const name = document.querySelector('[name="name"]');
    if (name && (!name.value || name.dataset.openshiftAutofilled === "true" || name.dataset.cloudAutofilled === "true" || name.dataset.kubeconfigAutofilled === "true")) {
      name.value = openShiftConnectionName(login.server);
      name.dataset.openshiftAutofilled = "true";
      delete name.dataset.cloudAutofilled;
      delete name.dataset.kubeconfigAutofilled;
    }
    if (!preserveCommand) document.getElementById("oc-login-command").value = openShiftLoginCommand(login);
    document.getElementById("openshift-server").textContent = login.server;
    document.getElementById("openshift-auth").textContent = login.token ? "Bearer token" : `Username · ${login.username}`;
    if (preview) preview.hidden = false;
    const lifetime = openShiftCredentialMessage(login);
    status.className = `notice ${lifetime.kind} openshift-login-status`;
    status.textContent = lifetime.message;
  }

  function openShiftLoginCommand(login) {
    const parts = ["oc", "login", "--server", login.server];
    if (login.token) parts.push("--token", login.token);
    else parts.push("--username", login.username, "--password", login.password);
    if (login.insecure) parts.push("--insecure-skip-tls-verify=true");
    return parts.map(commandShellQuote).join(" ");
  }

  function parseOCLogin(command) {
    const value = String(command || "").trim();
    if (!value) return null;
    const args = shellWords(value);
    const loginIndex = args.findIndex((item, index) => item === "login" && index > 0 && /(^|[/\\])oc(?:\.exe)?$/i.test(args[index - 1]));
    if (loginIndex < 0) throw new Error("Paste a complete oc login command.");
    const result = { server: "", token: "", username: "", password: "", insecure: false, certificateAuthority: "" };
    const options = {
      "--server": "server",
      "-s": "server",
      "--token": "token",
      "-u": "username",
      "--username": "username",
      "-p": "password",
      "--password": "password",
      "--certificate-authority": "certificateAuthority",
      "--ca": "certificateAuthority",
    };
    for (let index = loginIndex + 1; index < args.length; index += 1) {
      const argument = args[index];
      if (/^https?:\/\//i.test(argument) && !result.server) {
        result.server = argument;
        continue;
      }
      const equals = argument.match(/^(--[a-z-]+)=(.*)$/i);
      const option = equals ? equals[1] : argument;
      const key = options[option];
      if (key) {
        const optionValue = equals ? equals[2] : args[++index];
        if (!optionValue) throw new Error(`${option} needs a value.`);
        result[key] = optionValue;
        continue;
      }
      if (option === "--insecure-skip-tls-verify" || option === "--insecure-skip-tls-verify=true") {
        result.insecure = !equals || equals[2] !== "false";
      }
    }
    if (!result.server) throw new Error("The oc login command does not include an OpenShift server.");
    let serverURL;
    try {
      serverURL = new URL(result.server);
    } catch {
      throw new Error("The OpenShift server URL is not valid.");
    }
    if (!["https:", "http:"].includes(serverURL.protocol)) throw new Error("The OpenShift server must use HTTP or HTTPS.");
    result.server = serverURL.toString().replace(/\/$/, "");
    if (!result.token && !(result.username && result.password)) {
      throw new Error("The command must include a token or both username and password.");
    }
    return result;
  }

  function shellWords(command) {
    const words = [];
    let current = "";
    let quote = "";
    let escaped = false;
    for (const character of command.replace(/\\\r?\n/g, " ")) {
      if (escaped) {
        current += character;
        escaped = false;
      } else if (character === "\\" && quote !== "'") {
        escaped = true;
      } else if (quote) {
        if (character === quote) quote = "";
        else current += character;
      } else if (character === "'" || character === '"') {
        quote = character;
      } else if (/\s/.test(character)) {
        if (current) {
          words.push(current);
          current = "";
        }
      } else {
        current += character;
      }
    }
    if (escaped || quote) throw new Error("The command has an unfinished quote or escape.");
    if (current) words.push(current);
    return words;
  }

  function commandShellQuote(value) {
    const text = String(value);
    if (/^[A-Za-z0-9_./:@~+=,-]+$/.test(text)) return text;
    return `'${text.replaceAll("'", `'\\''`)}'`;
  }

  function openShiftKubeconfig(login) {
    const clusterTLS = login.insecure
      ? "    insecure-skip-tls-verify: true"
      : login.certificateAuthority
        ? `    certificate-authority: ${JSON.stringify(login.certificateAuthority)}`
        : "";
    const credentials = login.token
      ? `    token: ${JSON.stringify(login.token)}`
      : `    username: ${JSON.stringify(login.username)}\n    password: ${JSON.stringify(login.password)}`;
    return `apiVersion: v1
kind: Config
clusters:
- name: runwake-openshift
  cluster:
    server: ${JSON.stringify(login.server)}
${clusterTLS}
users:
- name: runwake-openshift
  user:
${credentials}
contexts:
- name: runwake-openshift
  context:
    cluster: runwake-openshift
    user: runwake-openshift
current-context: runwake-openshift
`;
  }

  function openShiftConnectionName(server) {
    try {
      return `OpenShift · ${new URL(server).hostname}`;
    } catch {
      return "OpenShift cluster";
    }
  }

  function openShiftCredentialMessage(login) {
    if (!login.token) {
      return { kind: "info", message: "Username and password detected." };
    }
    const expiry = jwtExpiry(login.token);
    if (!expiry) {
      return { kind: "warning", message: "Token detected. Its expiry cannot be verified and it may be short-lived; this connection will stop working when the token expires." };
    }
    const remaining = expiry.getTime() - Date.now();
    if (remaining <= 0) {
      return { kind: "error", message: `This token appears to have expired ${formatTime(expiry.toISOString(), true)}.` };
    }
    const shortLived = remaining < 24 * 60 * 60 * 1000;
    return {
      kind: shortLived ? "warning" : "info",
      message: `Token expiry detected: ${formatTime(expiry.toISOString(), true)}${shortLived ? ". This is a short-lived token." : "."}`,
    };
  }

  function jwtExpiry(token) {
    const pieces = String(token).split(".");
    if (pieces.length !== 3) return null;
    try {
      const base64 = pieces[1].replaceAll("-", "+").replaceAll("_", "/");
      const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
      if (!Number.isFinite(payload.exp)) return null;
      return new Date(payload.exp * 1000);
    } catch {
      return null;
    }
  }
  function updateNamespaceField() {
    const field = document.getElementById("namespace-field");
    if (field) field.hidden = document.getElementById("namespace-mode")?.value !== "selected";
  }
  async function readKubeconfigFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const textarea = document.querySelector('[name="kubeconfig"]');
    if (textarea) {
      textarea.value = await file.text();
      inferKubeconfigMetadata();
    }
  }

  function inferKubeconfigMetadata() {
    if (document.getElementById("kube-platform")?.value !== "kubernetes") return;
    const content = document.querySelector('[name="kubeconfig"]')?.value || "";
    const match = content.match(/^\s*current-context\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m);
    if (!match) return;
    const currentContext = match[1].trim();
    const context = document.querySelector('[name="context"]');
    if (context && (!context.value || context.dataset.computed === "true")) {
      context.value = currentContext;
      context.dataset.computed = "true";
    }
    const friendly = currentContext.split(/[/:]/).filter(Boolean).at(-1) || currentContext;
    updateComputedConnectionName("Kubernetes", friendly, "kubeconfigAutofilled");
  }

  function updateComputedConnectionName(provider, target, marker) {
    if (!target) return;
    const name = document.querySelector('[name="name"]');
    if (!name) return;
    const autoMarkers = ["openshiftAutofilled", "cloudAutofilled", "kubeconfigAutofilled", "dockerAutofilled"];
    const wasComputed = autoMarkers.some(key => name.dataset[key] === "true");
    if (!name.value || wasComputed) {
      name.value = `${provider} · ${target}`;
      for (const key of autoMarkers) delete name.dataset[key];
      name.dataset[marker] = "true";
    }
  }

  function updateDockerConnectionName() {
    const endpoint = document.querySelector('[name="endpoint"]')?.value.trim();
    if (!endpoint) return;
    let target = "Local";
    if (document.getElementById("docker-transport")?.value === "ssh") {
      const profileID = document.getElementById("ssh-profile-select")?.value;
      target = state.sshProfiles.find(item => item.id === profileID)?.host || "SSH host";
    } else if (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://")) {
      try {
        target = new URL(endpoint.replace(/^tcp:/, "http:")).hostname || "Docker";
      } catch {
        target = endpoint;
      }
    }
    updateComputedConnectionName("Docker", target, "dockerAutofilled");
  }

  function invalidateConnectionTest() {
    const form = document.getElementById("connection-form");
    if (!form || form.dataset.testPassed === "not-required") return;
    form.dataset.testPassed = "false";
    const add = modalRoot.querySelector('[data-action="submit-connection"]');
    if (add) add.disabled = true;
    const gate = document.getElementById("add-connection-gate");
    if (gate) {
      const agentSSH = form.querySelector('[name="kind"]')?.value === "agent";
      gate.classList.add("locked");
      gate.tabIndex = 0;
      gate.dataset.tooltip = agentSSH ? "Test the SSH target successfully before installing." : "Test the connection successfully before adding it.";
    }
    updateConnectionTestState("idle", "Ready to test");
  }

  function updateConnectionTestState(stateName, message) {
    const status = document.getElementById("connection-test-state");
    if (!status) return;
    status.className = `connection-test-state ${stateName}`;
    status.querySelector("strong").textContent = message;
  }

  function cloudKubeconfigReady(kind, data) {
    const platform = document.getElementById("kube-platform")?.value;
    if (kind !== "kubernetes" || !["eks", "gke", "aks"].includes(platform) || String(data.get("kubeconfig") || "").trim()) return true;
    const status = document.getElementById("cloud-import-status");
    status.className = "notice error cloud-import-status";
    status.textContent = "Import the cloud kubeconfig before testing the connection.";
    return false;
  }

  function directConnectionPayload(data, skipTest) {
    const kind = String(data.get("kind"));
    const payload = { name: String(data.get("name") || "").trim(), kind, skip_test: skipTest };
    const useSSH = String(data.get("transport")) === "ssh";
    if (kind === "kubernetes") {
      payload.kubernetes = {
        kubeconfig_source: String(data.get("kubeconfig_source") || "path"),
        kubeconfig_path: String(data.get("kubeconfig_path") || "").trim(),
        kubeconfig: String(data.get("kubeconfig") || ""),
        context: String(data.get("context") || "").trim(),
        kubectl_path: String(data.get("kubectl_path") || "").trim(),
        namespace_mode: String(data.get("namespace_mode") || "all"),
        namespaces: listFrom(data.get("namespaces")),
        exec_policy: String(data.get("exec_policy") || "allowlist"),
        exec_allowlist: listFrom(data.get("exec_allowlist")),
        environment: environmentFrom(data.get("environment")),
      };
    } else {
      payload.access_mode = String(data.get("access_mode") || "read_only");
      let endpoint = String(data.get("endpoint") || "").trim();
      if (useSSH && endpoint.startsWith("/")) endpoint = `unix://${endpoint}`;
      payload.docker = {
        endpoint,
        tls_server_name: String(data.get("tls_server_name") || "").trim(),
        tls_ca: String(data.get("tls_ca") || ""),
        tls_cert: String(data.get("tls_cert") || ""),
        tls_key: String(data.get("tls_key") || ""),
      };
    }
    if (useSSH) payload.ssh_profile_id = selectedSSHProfileID(data);
    if (String(data.get("http_proxy_mode") || "none") === "http") {
      payload.http_proxy = {
        url: String(data.get("http_proxy_url") || "").trim(),
        no_proxy: listFrom(data.get("http_proxy_no_proxy")),
      };
    }
    return payload;
  }

  function selectedSSHProfileID(data) {
    const id = String(data.get("ssh_profile_id") || "").trim();
    if (!id || id === "__new__") throw new Error("Save and select an SSH profile first.");
    return id;
  }

  async function testDraftConnection() {
    const form = document.getElementById("connection-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const kind = String(data.get("kind"));
    if (kind === "agent" || !cloudKubeconfigReady(kind, data)) return;
    let payload;
    try {
      payload = directConnectionPayload(data, false);
    } catch (error) {
      updateConnectionTestState("bad", error.message);
      return;
    }
    const test = modalRoot.querySelector('[data-action="test-draft-connection"]');
    const add = modalRoot.querySelector('[data-action="submit-connection"]');
    test.disabled = true;
    test.textContent = "Testing…";
    add.disabled = true;
    updateConnectionTestState("testing", "Testing connection…");
    try {
      const response = await api("/api/v1/connections/test", { method: "POST", body: JSON.stringify(payload) });
      form.dataset.testPassed = "true";
      const detail = response.details?.server_version ? ` · ${response.details.server_version}` : "";
      updateConnectionTestState("good", `${response.message || "Connection successful"}${detail}`);
      const gate = document.getElementById("add-connection-gate");
      gate.classList.remove("locked");
      gate.removeAttribute("data-tooltip");
      gate.removeAttribute("tabindex");
      add.disabled = false;
    } catch (error) {
      form.dataset.testPassed = "false";
      updateConnectionTestState("bad", error.message);
    } finally {
      test.disabled = false;
      test.textContent = "Test";
    }
  }

  async function testAgentSSH() {
    const form = document.getElementById("connection-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    if (String(data.get("setup_method")) !== "ssh") return;
    const test = modalRoot.querySelector('[data-action="test-agent-ssh"]');
    const install = modalRoot.querySelector('[data-action="submit-connection"]');
    let profileID;
    try {
      profileID = selectedSSHProfileID(data);
    } catch (error) {
      updateConnectionTestState("bad", error.message);
      return;
    }
    const payload = {
      ssh_profile_id: profileID,
      kind: String(data.get("agent_kind") || "kubernetes"),
      remote_kubeconfig_path: String(data.get("remote_kubeconfig_path") || "").trim(),
      remote_kubectl_path: String(data.get("remote_kubectl_path") || "").trim(),
      docker_socket_path: String(data.get("docker_socket_path") || "").trim(),
    };
    test.disabled = true;
    test.textContent = "Testing…";
    install.disabled = true;
    updateConnectionTestState("testing", "Testing SSH target…");
    try {
      const response = await api("/api/v1/ssh/test", { method: "POST", body: JSON.stringify(payload) });
      form.dataset.testPassed = "true";
      const detail = response.details?.server_version ? ` · ${response.details.server_version}` : "";
      updateConnectionTestState("good", `${response.message || "SSH target is ready"}${detail}`);
      const gate = document.getElementById("add-connection-gate");
      gate.classList.remove("locked");
      gate.removeAttribute("data-tooltip");
      gate.removeAttribute("tabindex");
      install.disabled = false;
    } catch (error) {
      form.dataset.testPassed = "false";
      updateConnectionTestState("bad", error.message);
    } finally {
      test.disabled = false;
      test.textContent = "Test";
    }
  }

  async function submitConnection() {
    const form = document.getElementById("connection-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const kind = String(data.get("kind"));
    if (kind === "agent") {
      const mode = String(data.get("mode") || "persistent");
      const agentKind = String(data.get("agent_kind") || "kubernetes");
      const setupMethod = String(data.get("setup_method") || "instructions");
      if (setupMethod === "ssh" && form.dataset.testPassed !== "true") return;
      const payload = {
        name: String(data.get("name") || "").trim(),
        kind: agentKind,
        mode,
        server_url: String(data.get("server_url") || "").trim(),
        image: String(data.get("image") || "").trim(),
        namespace: String(data.get("agent_namespace") || "runwake-system").trim(),
        namespaces: agentKind === "kubernetes" && String(data.get("namespace_mode")) === "selected" ? listFrom(data.get("namespaces")) : [],
        ttl_seconds: mode === "temporary" ? Math.max(60, Number(data.get("ttl_minutes") || 30) * 60) : 0,
      };
      if (setupMethod === "ssh") {
        payload.ssh_profile_id = selectedSSHProfileID(data);
        payload.remote_kubeconfig_path = String(data.get("remote_kubeconfig_path") || "").trim();
        payload.remote_kubectl_path = String(data.get("remote_kubectl_path") || "").trim();
        payload.docker_socket_path = String(data.get("docker_socket_path") || "").trim();
      }
      const button = modalRoot.querySelector('[data-action="submit-connection"]');
      button.disabled = true;
      button.textContent = setupMethod === "ssh" ? "Installing…" : "Generating…";
      try {
        const response = await api("/api/v1/agents/enroll", { method: "POST", body: JSON.stringify(payload) });
        if (response.installed) {
          closeModal();
          toast("Agent installed over SSH");
          await renderConnections();
        } else {
          showAgentSetup(response, payload);
        }
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
        button.textContent = setupMethod === "ssh" ? "Install" : "Create setup";
      }
      return;
    }
    if (form.dataset.testPassed !== "true") return;
    const payload = directConnectionPayload(data, true);
    const button = modalRoot.querySelector('[data-action="submit-connection"]');
    button.disabled = true;
    button.textContent = "Adding…";
    try {
      await api("/api/v1/connections", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      toast("Connection added");
      await renderConnections();
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Add";
    }
  }

  function showAgentModal(connection) {
    const settings = state.settings || {};
    showModal(`
      <div class="modal-header"><div><h2 class="modal-title">Deploy remote agent</h2></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body"><form id="agent-form">
        <div class="form-grid">
          <label>Connection name<input class="field" name="name" value="${html(connection.name)} agent" required></label>
          <label>Run mode<select id="agent-mode" name="mode"><option value="persistent">Persistent</option><option value="temporary">Temporary</option></select></label>
          <label class="full">Runwake server URL<input class="field mono" name="server_url" type="url" value="${html(settings.public_url || "")}" placeholder="https://runwake.example.com" required><span class="hint">Must be reachable from this cluster.</span></label>
          <label class="full">Agent image<input class="field mono" name="image" value="${html(settings.default_agent_image || "")}" placeholder="registry.example.com/runwake-agent:0.1.0" required></label>
          <label>Agent namespace<input class="field mono" name="namespace" value="runwake-system" required></label>
          <label>Workload namespace scope<select id="agent-namespace-mode" name="namespace_mode"><option value="all">All permitted namespaces</option><option value="selected">Selected namespaces</option></select></label>
          <label id="agent-namespaces-field" class="full" hidden>Namespaces<input class="field" name="namespaces" placeholder="payments, platform"></label>
          <label id="agent-ttl-field" hidden>Lifetime in minutes<input class="field" name="ttl_minutes" type="number" min="1" value="30"></label>
        </div>
        <div class="form-section"><label class="choice full-choice"><input type="checkbox" name="manual"><span><span class="choice-title">Generate manifest only</span><span class="choice-copy">Return YAML without applying it.</span></span></label></div>
        <div class="notice mt-16">The generated role can read Pods, Pod logs, Events, Deployments, StatefulSets, DaemonSets, Jobs, and Pod metrics when metrics.k8s.io is installed. It cannot read Secrets or modify application resources.</div>
      </form></div>
      <div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="submit-agent" data-id="${html(connection.id)}">Deploy agent</button></div>`, "wide");
    document.getElementById("agent-mode").addEventListener("change", updateAgentTTL);
    document.getElementById("agent-namespace-mode").addEventListener("change", updateAgentNamespaceField);
    updateAgentTTL();
    updateAgentNamespaceField();
  }

  function updateAgentTTL() {
    const field = document.getElementById("agent-ttl-field");
    if (field) field.hidden = document.getElementById("agent-mode")?.value !== "temporary";
  }
  function updateAgentNamespaceField() {
    const field = document.getElementById("agent-namespaces-field");
    if (field) field.hidden = document.getElementById("agent-namespace-mode")?.value !== "selected";
  }

  async function submitAgent(connectionID) {
    const form = document.getElementById("agent-form");
    if (!form?.reportValidity()) return;
    const data = new FormData(form);
    const mode = String(data.get("mode"));
    const payload = {
      name: String(data.get("name") || "").trim(),
      mode,
      server_url: String(data.get("server_url") || "").trim(),
      image: String(data.get("image") || "").trim(),
      namespace: String(data.get("namespace") || "runwake-system").trim(),
      namespaces: String(data.get("namespace_mode")) === "selected" ? listFrom(data.get("namespaces")) : [],
      ttl_seconds: mode === "temporary" ? Math.max(60, Number(data.get("ttl_minutes") || 30) * 60) : 0,
      manual: data.has("manual"),
    };
    const button = modalRoot.querySelector('[data-action="submit-agent"]');
    button.disabled = true;
    button.textContent = payload.manual ? "Generating…" : "Deploying…";
    try {
      const response = await api(`/api/v1/connections/${encodeURIComponent(connectionID)}/agent`, { method: "POST", body: JSON.stringify(payload) });
      if (response.manifest) {
        showKubernetesAgentSetup(response.manifest, response.teardown_manifest || "");
      } else {
        closeModal();
        toast("Agent resources applied");
        await renderConnections();
      }
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Deploy agent";
    }
  }

  function showKubernetesAgentSetup(installManifest, teardownManifest) {
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Kubernetes agent setup</h2><p class="modal-copy">The credential is embedded in the Secret and is shown only in this response. Store the removal manifest with your operational notes.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="code-section"><div class="section-head"><h3 class="section-title">Install</h3><button class="btn small" data-action="copy-code" data-target="agent-install-manifest">Copy</button></div><pre id="agent-install-manifest" class="code-block"></pre></div>
        ${teardownManifest ? `<div class="code-section"><div class="section-head"><h3 class="section-title">Remove</h3><button class="btn small" data-action="copy-code" data-target="agent-remove-manifest">Copy</button></div><pre id="agent-remove-manifest" class="code-block"></pre></div>` : ""}
      </div>
      <div class="modal-footer"><button class="btn primary" data-action="finish-agent-setup">Done</button></div>`, "wide");
    document.getElementById("agent-install-manifest").textContent = installManifest;
    if (teardownManifest) document.getElementById("agent-remove-manifest").textContent = teardownManifest;
  }

  function shellQuote(value) {
    return `'${String(value).replaceAll("'", `'"'"'`)}'`;
  }

  function showAgentSetup(response, request) {
    if (request.kind === "kubernetes") {
      showKubernetesAgentSetup(response.apply_manifest || "", response.teardown_manifest || "");
      return;
    }
    const environment = response.environment || {};
    const containerName = `runwake-agent-${String(response.connection?.id || "remote").slice(-8)}`;
    const flags = response.mode === "temporary" ? `--rm --name ${containerName}` : `-d --restart unless-stopped --name ${containerName}`;
    const continuation = " \\\n  ";
    const envFlags = Object.entries(environment).map(([key, value]) => `-e ${key}=${shellQuote(value)}`).join(continuation);
    const command = [
      `docker run ${flags}`,
      "--read-only --cap-drop ALL --security-opt no-new-privileges",
      `--group-add "$(stat -c '%g' /var/run/docker.sock)"`,
      "-v /var/run/docker.sock:/var/run/docker.sock",
      envFlags,
      shellQuote(request.image),
    ].filter(Boolean).join(continuation);
    const removeCommand = response.mode === "temporary" ? `docker stop ${containerName}` : `docker rm -f ${containerName}`;
    const envText = Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n");
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Docker agent setup</h2><p class="modal-copy">Run this on the Docker host. The token is shown once. Docker socket access is highly privileged; use a dedicated host or socket proxy when the trust boundary requires it.</p></div><button class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="code-section"><div class="section-head"><h3 class="section-title">Start</h3><button class="btn small" data-action="copy-code" data-target="docker-agent-command">Copy</button></div><pre id="docker-agent-command" class="code-block"></pre></div>
        <div class="code-section"><div class="section-head"><h3 class="section-title">Remove</h3><button class="btn small" data-action="copy-code" data-target="docker-agent-remove">Copy</button></div><pre id="docker-agent-remove" class="code-block"></pre></div>
        <details class="disclosure"><summary>Environment variables</summary><pre id="docker-agent-environment" class="code-block"></pre></details>
        <div class="notice mt-16">The command maps the Docker socket group into the non-root agent container on Linux. Adjust the group mapping for hosts that expose the socket differently.</div>
      </div>
      <div class="modal-footer"><button class="btn primary" data-action="finish-agent-setup">Done</button></div>`, "wide");
    document.getElementById("docker-agent-command").textContent = command;
    document.getElementById("docker-agent-remove").textContent = removeCommand;
    document.getElementById("docker-agent-environment").textContent = envText;
  }
