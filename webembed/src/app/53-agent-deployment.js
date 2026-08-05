  function showAgentModal(connection) {
    const settings = state.settings || {};
    showModal(`
      <div class="modal-header"><div><h2 class="modal-title">Deploy remote agent</h2></div><button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
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
      <div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="button" class="btn primary" data-action="submit-agent" data-id="${html(connection.id)}">Deploy agent</button></div>`, "wide");
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
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Kubernetes agent setup</h2><p class="modal-copy">The credential is embedded in the Secret and is shown only in this response. Store the removal manifest with your operational notes.</p></div><button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="code-section"><div class="section-head"><h3 class="section-title">Install</h3><button type="button" class="btn small" data-action="copy-code" data-target="agent-install-manifest">Copy</button></div><pre id="agent-install-manifest" class="code-block"></pre></div>
        ${teardownManifest ? `<div class="code-section"><div class="section-head"><h3 class="section-title">Remove</h3><button type="button" class="btn small" data-action="copy-code" data-target="agent-remove-manifest">Copy</button></div><pre id="agent-remove-manifest" class="code-block"></pre></div>` : ""}
      </div>
      <div class="modal-footer"><button type="button" class="btn primary" data-action="finish-agent-setup">Done</button></div>`, "wide");
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
    showModal(`<div class="modal-header"><div><h2 class="modal-title">Docker agent setup</h2><p class="modal-copy">Run this on the Docker host. The token is shown once. Docker socket access is highly privileged; use a dedicated host or socket proxy when the trust boundary requires it.</p></div><button type="button" class="btn ghost icon-button" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="code-section"><div class="section-head"><h3 class="section-title">Start</h3><button type="button" class="btn small" data-action="copy-code" data-target="docker-agent-command">Copy</button></div><pre id="docker-agent-command" class="code-block"></pre></div>
        <div class="code-section"><div class="section-head"><h3 class="section-title">Remove</h3><button type="button" class="btn small" data-action="copy-code" data-target="docker-agent-remove">Copy</button></div><pre id="docker-agent-remove" class="code-block"></pre></div>
        <details class="disclosure"><summary>Environment variables</summary><pre id="docker-agent-environment" class="code-block"></pre></details>
        <div class="notice mt-16">The command maps the Docker socket group into the non-root agent container on Linux. Adjust the group mapping for hosts that expose the socket differently.</div>
      </div>
      <div class="modal-footer"><button type="button" class="btn primary" data-action="finish-agent-setup">Done</button></div>`, "wide");
    document.getElementById("docker-agent-command").textContent = command;
    document.getElementById("docker-agent-remove").textContent = removeCommand;
    document.getElementById("docker-agent-environment").textContent = envText;
  }
