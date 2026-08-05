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
