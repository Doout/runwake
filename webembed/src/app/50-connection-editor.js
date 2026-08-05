  function showAddConnection(kind = "kubernetes") {
    if (kind === "agent" && !remoteAgentsAvailable()) {
      toast("Remote agents are coming soon");
      kind = "kubernetes";
    }
    const settings = state.settings || { exec_plugin_policy: "allowlist", exec_plugin_allowlist: [] };
    const direct = kind !== "agent";
    showModal(`
      <div class="modal-header"><div><h2 class="modal-title">${direct ? "Add connection" : "Create remote agent"}</h2></div><button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="tabs"><button type="button" class="tab ${kind === "kubernetes" ? "active" : ""}" data-action="switch-add-kind" data-kind="kubernetes">Kubernetes</button><button type="button" class="tab ${kind === "docker" ? "active" : ""}" data-action="switch-add-kind" data-kind="docker">Docker</button><button type="button" class="tab ${kind === "agent" ? "active" : ""}" data-action="switch-add-kind" data-kind="agent" ${remoteAgentsAvailable() ? "" : 'disabled title="Coming soon"'}>Remote agent${remoteAgentsAvailable() ? "" : `<span class="control-note">Coming soon</span>`}</button></div>
        <form id="connection-form">
          <input type="hidden" name="kind" value="${kind}">
          ${kind === "kubernetes" ? kubernetesForm(settings) : kind === "docker" ? dockerForm() : remoteAgentForm(settings)}
        </form>
      </div>
      <div class="modal-footer connection-footer">
        ${direct ? `<div id="connection-test-state" class="connection-test-state idle"><span></span><strong>Not tested</strong></div>` : `<div id="connection-test-state" class="connection-test-state idle" hidden><span></span><strong></strong></div>`}
        <div class="connection-footer-actions">
          <button type="button" class="btn" data-action="close-modal">Cancel</button>
          ${direct ? `<button type="button" class="btn" data-action="test-draft-connection">Test</button><span id="add-connection-gate" class="button-gate locked" tabindex="0" data-tooltip="Test the connection successfully before adding it."><button type="button" class="btn primary" data-action="submit-connection" disabled>Add</button></span>` : `<button type="button" class="btn" data-action="test-agent-ssh" hidden>Test</button><span id="add-connection-gate" class="button-gate"><button type="button" class="btn primary" data-action="submit-connection">Create setup</button></span>`}
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
