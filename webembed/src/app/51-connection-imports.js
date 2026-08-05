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
