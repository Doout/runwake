
  function renderTopology(params) {
    const renderID = ++state.topologyRenderID;
    const request = {
      connection_id: params.get("connection_id") || "",
      project: params.get("project") || "",
      focus: params.get("focus") || "",
    };
    if (!request.connection_id || !request.project) {
      navigate("/workloads");
      return;
    }
    const zoomKey = `${request.connection_id}|${request.project}`;
    if (state.topologyZoomKey !== zoomKey) {
      state.topologyZoomKey = zoomKey;
      state.topologyZoom = 1;
    }
    drawTopologyPage(request);
    hydrateTopology(request, renderID);
  }

  function drawTopologyPage(request, loaded = false) {
    const connection = state.connections.find(item => item.id === request.connection_id);
    const model = dockerTopologyModel(request);
    const connectionLabel = connection?.name || request.connection_id;
    const managed = canManageDockerConnection(request.connection_id);
    const activityRequest = topologyActivityRequest(request, model);
    shell(`<section class="page topology-page ${request.focus ? "topology-page-focused" : ""}">
      <header class="page-header topology-header">
        <div>
          <button class="btn ghost small activity-back" data-action="back-workloads">← Workloads</button>
          <h1 class="page-title activity-title">${html(request.focus || request.project)}</h1>
          <div class="activity-meta"><button type="button" class="activity-meta-link" data-action="filter-workloads-from-topology" data-connection="${html(request.connection_id)}" aria-label="Show workloads from ${html(connectionLabel)}">${html(connectionLabel)}</button>${request.focus ? `<span>${html(request.project)}</span>` : ""}<span>Docker Compose</span><span>${managed ? "Manage containers" : "View only"}</span></div>
        </div>
        <div class="topology-header-actions">
          ${request.focus ? `<button class="btn ghost" data-action="show-full-topology" data-connection="${html(request.connection_id)}" data-project="${html(request.project)}">Full project</button>` : ""}
          ${!request.focus && managed ? `<button class="btn" data-action="restart-compose-project" data-connection="${html(request.connection_id)}" data-project="${html(request.project)}">Restart project</button>` : ""}
          <button id="refresh-topology" class="btn" data-action="refresh-topology" data-connection="${html(request.connection_id)}" data-project="${html(request.project)}" data-focus="${html(request.focus)}" ${state.topologyRefreshing ? "disabled" : ""}>${state.topologyRefreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
      </header>
      ${request.focus ? workloadViewTabs(activityRequest, "topology", model?.workloads.find(item => item.name === request.focus)) : ""}
      <div id="topology-content" aria-busy="${state.topologyRefreshing}">${topologyContent(model, request, loaded)}</div>
    </section>`, "workloads");
    bindTopologyCanvas();
  }

  async function hydrateTopology(request, renderID) {
    const hasProject = state.workloads.some(item => item.connection_id === request.connection_id && composeProjectName(item) === request.project);
    const pending = [];
    if (!state.connections.length) pending.push(loadConnections());
    if (!hasProject) pending.push(loadWorkloads(request.connection_id));
    if (!pending.length) return;
    try {
      await Promise.all(pending);
    } catch (error) {
      if (!(error instanceof AuthenticationRequired)) toast(`Topology: ${error.message}`, "error");
      return;
    }
    if (renderID !== state.topologyRenderID || state.route?.path !== "/topology") return;
    drawTopologyPage(request, true);
  }

  async function refreshTopology(request) {
    if (state.topologyRefreshing) return;
    state.topologyRefreshing = true;
    const button = document.getElementById("refresh-topology");
    const content = document.getElementById("topology-content");
    if (button) {
      button.disabled = true;
      button.textContent = "Refreshing…";
    }
    if (content) content.setAttribute("aria-busy", "true");
    try {
      await loadWorkloads(request.connection_id);
      if (state.route?.path !== "/topology") return;
      stopTopologyLayout();
      if (content) {
        content.innerHTML = topologyContent(dockerTopologyModel(request), request, true);
        content.setAttribute("aria-busy", "false");
      }
      bindTopologyCanvas();
    } catch (error) {
      if (!(error instanceof AuthenticationRequired)) toast(`Topology: ${error.message}`, "error");
    } finally {
      state.topologyRefreshing = false;
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.textContent = "Refresh";
      }
      if (content && document.body.contains(content)) content.setAttribute("aria-busy", "false");
    }
  }

  function composeProjectName(workload) {
    return workload?.docker?.compose_project || workload?.labels?.["com.docker.compose.project"] || "";
  }

  function composeServiceName(workload) {
    return workload.docker?.compose_service || workload.labels?.["com.docker.compose.service"] || workload.name;
  }

  function topologyActivityRequest(request, model) {
    const workload = model?.workloads.find(item => item.name === request.focus);
    return {
      connection_id: request.connection_id,
      kind: workload?.kind || "Container",
      namespace: workload?.namespace || "",
      name: request.focus,
      pod: "",
      container: "",
      topology_project: request.project,
    };
  }

  function dockerTopologyModel(request) {
    const workloads = state.workloads
      .filter(item => item.connection_id === request.connection_id && composeProjectName(item) === request.project)
      .sort((a, b) => composeServiceName(a).localeCompare(composeServiceName(b)) || String(a.name).localeCompare(String(b.name)));
    if (!workloads.length) return null;

    const servicesByName = new Map();
    const networksByName = new Map();
    const storageByKey = new Map();
    for (const workload of workloads) {
      const docker = workload.docker || {};
      const serviceName = composeServiceName(workload);
      let service = servicesByName.get(serviceName);
      if (!service) {
        service = { name: serviceName, workloads: [], images: new Set(), ports: new Map(), dependencies: new Set(), networkKeys: new Set(), storageKeys: new Set() };
        servicesByName.set(serviceName, service);
      }
      service.workloads.push(workload);
      for (const image of workload.images || []) if (image) service.images.add(image);
      for (const dependency of docker.depends_on || []) if (dependency) service.dependencies.add(dependency);
      for (const port of docker.ports || []) {
        const key = [port.container_port, port.protocol, port.host_ip, port.host_port].join("|");
        service.ports.set(key, port);
      }
      for (const network of docker.networks || []) {
        if (!network.name) continue;
        let resource = networksByName.get(network.name);
        if (!resource) {
          resource = { key: network.name, name: network.name, gateway: network.gateway || "", networkID: network.network_id || "", attachments: [] };
          networksByName.set(network.name, resource);
        }
        if (!resource.gateway && network.gateway) resource.gateway = network.gateway;
        if (!resource.networkID && network.network_id) resource.networkID = network.network_id;
        resource.attachments.push({
          service: serviceName,
          container: workload.name,
          containerNumber: docker.compose_container_number || "",
          address: network.ip_address || network.global_ipv6_address || "",
          aliases: network.aliases || [],
        });
        service.networkKeys.add(network.name);
      }
      for (const mount of docker.mounts || []) {
        const kind = mount.type || "mount";
        const identity = kind === "volume" ? (mount.name || mount.source || mount.destination) : (mount.source || mount.destination);
        const key = `${kind}:${identity}`;
        let resource = storageByKey.get(key);
        if (!resource) {
          resource = { key, kind, name: identity, source: mount.source || "", driver: mount.driver || "", attachments: [] };
          storageByKey.set(key, resource);
        }
        resource.attachments.push({
          service: serviceName,
          container: workload.name,
          containerNumber: docker.compose_container_number || "",
          destination: mount.destination || "",
          readOnly: Boolean(mount.read_only),
        });
        service.storageKeys.add(key);
      }
    }

    const services = [...servicesByName.values()].sort((a, b) => a.name.localeCompare(b.name));
    const networks = [...networksByName.values()].sort((a, b) => a.name.localeCompare(b.name));
    const storage = [...storageByKey.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    const networkIDs = new Map(networks.map((item, index) => [item.key, `topology-network-${index}`]));
    const storageIDs = new Map(storage.map((item, index) => [item.key, `topology-storage-${index}`]));
    const serviceIDs = new Map(services.map((item, index) => [item.name, `topology-service-${index}`]));
    services.forEach((service, index) => {
      service.nodeID = `topology-service-${index}`;
      service.targetIDs = [
        ...[...service.networkKeys].map(key => networkIDs.get(key)),
        ...[...service.storageKeys].map(key => storageIDs.get(key)),
      ].filter(Boolean);
      service.dependencyIDs = [...service.dependencies].map(name => serviceIDs.get(name)).filter(Boolean);
    });
    networks.forEach((item, index) => { item.nodeID = `topology-network-${index}`; });
    storage.forEach((item, index) => { item.nodeID = `topology-storage-${index}`; });

    const first = workloads[0].docker || {};
    return {
      project: request.project,
      connectionID: workloads[0].connection_id,
      connection: workloads[0].connection,
      workingDir: first.compose_working_dir || workloads[0].labels?.["com.docker.compose.project.working_dir"] || "",
      configFiles: first.compose_config_files || workloads[0].labels?.["com.docker.compose.project.config_files"] || "",
      composeVersion: first.compose_version || workloads[0].labels?.["com.docker.compose.version"] || "",
      services, networks, storage, workloads,
    };
  }

  function topologyContent(model, request, loaded = false) {
    if (!model) {
      if (loaded) return emptyState("Compose project not found", `${request.project} is no longer present on this Docker connection.`, "Workloads", "back-workloads");
      return `<div class="workload-discovery" role="status"><div class="discovery-track" aria-hidden="true"><span></span></div><strong>Loading topology</strong></div>`;
    }
    const focusedWorkload = request.focus ? model.workloads.find(item => item.name === request.focus) : null;
    const focusedService = focusedWorkload
      ? model.services.find(service => service.workloads.some(item => item.name === focusedWorkload.name))
      : null;
    if (focusedWorkload && focusedService) return focusedTopologyContent(model, focusedWorkload, focusedService);
    const resources = model.networks.length + model.storage.length;
    return `${topologyControls()}<div class="topology-summary" aria-label="Topology summary">
      <span><strong>${model.services.length}</strong> service${model.services.length === 1 ? "" : "s"}</span>
      <span><strong>${model.workloads.length}</strong> container${model.workloads.length === 1 ? "" : "s"}</span>
      <span><strong>${model.networks.length}</strong> network${model.networks.length === 1 ? "" : "s"}</span>
      <span><strong>${model.storage.length}</strong> storage source${model.storage.length === 1 ? "" : "s"}</span>
    </div>
    <div id="topology-viewport" class="topology-viewport" tabindex="0" aria-label="Topology canvas. Use Control or Command with the mouse wheel to zoom.">
    <div id="topology-world" class="topology-world"><div class="topology-map">
      <svg class="topology-edge-layer" aria-hidden="true"></svg>
      <section class="topology-column topology-project-column" aria-labelledby="topology-project-label">
        <h2 id="topology-project-label" class="topology-column-label">Project</h2>
        ${topologyProjectNode(model, resources)}
      </section>
      <section class="topology-column topology-service-column" aria-labelledby="topology-service-label">
        <h2 id="topology-service-label" class="topology-column-label">Services</h2>
        <div class="topology-node-list">${model.services.map(service => topologyServiceNode(service)).join("")}</div>
      </section>
      <section class="topology-column topology-resource-column" aria-labelledby="topology-resource-label">
        <h2 id="topology-resource-label" class="topology-column-label">Runtime resources</h2>
        ${model.networks.length ? `<div class="topology-resource-group"><h3>Networks</h3><div class="topology-node-list">${model.networks.map(network => topologyNetworkNode(network, model.project)).join("")}</div></div>` : ""}
        ${model.storage.length ? `<div class="topology-resource-group"><h3>Storage and host paths</h3><div class="topology-node-list">${model.storage.map(item => topologyStorageNode(item)).join("")}</div></div>` : ""}
        ${resources ? "" : `<div class="topology-resource-empty">No networks or mounts reported.</div>`}
      </section>
    </div></div></div>`;
  }

  function topologyControls() {
    return `<div class="topology-controls" aria-label="Topology controls">
      <button class="btn small" data-action="toggle-all-topology-nodes" aria-pressed="false">Expand all</button>
      <div class="topology-zoom-controls" aria-label="Canvas zoom">
        <button class="btn small icon-button" data-action="zoom-topology" data-zoom="-0.1" aria-label="Zoom out" title="Zoom out (−)">−</button>
        <button id="topology-zoom-level" class="btn small topology-zoom-level" data-action="reset-topology-zoom" aria-label="Reset zoom to 100%" title="Reset zoom (0)">${Math.round(state.topologyZoom * 100)}%</button>
        <button class="btn small icon-button" data-action="zoom-topology" data-zoom="0.1" aria-label="Zoom in" title="Zoom in (+)">+</button>
      </div>
    </div>`;
  }

  function focusedTopologyContent(model, workload, service) {
    const networks = model.networks
      .filter(item => service.networkKeys.has(item.key))
      .map(item => ({ ...item, attachments: item.attachments.filter(attachment => attachment.container === workload.name) }));
    const storage = model.storage
      .filter(item => service.storageKeys.has(item.key))
      .map(item => ({ ...item, attachments: item.attachments.filter(attachment => attachment.container === workload.name) }));
    const dependencyNames = [...service.dependencies].sort();
    const dependencies = dependencyNames.map((name, index) => ({
      name,
      nodeID: `topology-focus-dependency-${index}`,
      service: model.services.find(item => item.name === name),
    }));
    const targetIDs = [...networks, ...storage].map(item => item.nodeID);
    const resources = networks.length + storage.length;
    return `${topologyControls()}<div class="topology-summary" aria-label="Focused topology summary">
      <span><strong>1</strong> selected container</span>
      <span><strong>${dependencies.length}</strong> dependenc${dependencies.length === 1 ? "y" : "ies"}</span>
      <span><strong>${networks.length}</strong> network${networks.length === 1 ? "" : "s"}</span>
      <span><strong>${storage.length}</strong> storage source${storage.length === 1 ? "" : "s"}</span>
    </div>
    <div id="topology-viewport" class="topology-viewport" tabindex="0" aria-label="Topology canvas. Use Control or Command with the mouse wheel to zoom.">
    <div id="topology-world" class="topology-world"><div class="topology-map topology-map-focused" data-focus-container="${html(workload.name)}">
      <svg class="topology-edge-layer" aria-hidden="true"></svg>
      <section class="topology-column topology-focus-context-column" aria-labelledby="topology-context-label">
        <h2 id="topology-context-label" class="topology-column-label">Compose context</h2>
        <div class="topology-node-list">
          ${topologyProjectNode(model, model.networks.length + model.storage.length)}
          ${dependencies.map(item => topologyDependencyNode(item)).join("")}
        </div>
      </section>
      <section class="topology-column topology-focus-column" aria-labelledby="topology-focus-label">
        <h2 id="topology-focus-label" class="topology-column-label">Selected container</h2>
        ${topologyFocusNode(workload, service, targetIDs, dependencies.map(item => item.nodeID))}
      </section>
      <section class="topology-column topology-focus-resource-column" aria-labelledby="topology-connected-label">
        <h2 id="topology-connected-label" class="topology-column-label">Connected resources</h2>
        ${networks.length ? `<div class="topology-resource-group"><h3>Networks</h3><div class="topology-node-list">${networks.map(network => topologyNetworkNode(network, model.project)).join("")}</div></div>` : ""}
        ${storage.length ? `<div class="topology-resource-group"><h3>Storage and host paths</h3><div class="topology-node-list">${storage.map(item => topologyStorageNode(item)).join("")}</div></div>` : ""}
        ${resources ? "" : `<div class="topology-resource-empty">No networks or mounts reported.</div>`}
      </section>
    </div></div></div>`;
  }

  function topologyDependencyNode(item) {
    const workloads = item.service?.workloads || [];
    const workload = workloads.length === 1 ? workloads[0] : null;
    const good = workloads.filter(workload => statusBucket(workload) === "good").length;
    const bucket = workloads.some(workload => statusBucket(workload) === "bad")
      ? "bad"
      : workloads.some(workload => statusBucket(workload) === "warn")
        ? "warn"
        : workloads.length && good === workloads.length ? "good" : "other";
    return `<article id="${html(item.nodeID)}" class="topology-node topology-related-node" tabindex="0" data-topology-node data-topology-role="dependency" data-topology-label="${html(item.name)}" data-topology-connection="${html(workload?.connection_id || "")}" data-topology-project="${html(workload ? composeProjectName(workload) : "")}" data-topology-focus="${html(workload?.name || "")}" data-topology-openable="true" aria-label="${html(item.name)} service. Double-click to open when one container is available. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">S</span><div><strong>${html(item.name)}</strong><small>${workloads.length ? `${workloads.length} container${workloads.length === 1 ? "" : "s"}` : "Not observed"}</small></div>${workloads.length ? `<span class="topology-state ${bucket}">${good}/${workloads.length}</span>` : ""}</div>
    </article>`;
  }

  function topologyNodeToggle(label, expanded = false) {
    return `<button type="button" class="topology-node-toggle" data-action="toggle-topology-node" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${html(label)} details"><span aria-hidden="true"></span></button>`;
  }

  function topologyNodeDetails(content, expanded = false) {
    return `<div class="topology-node-details" ${expanded ? "" : "hidden"}>${content}</div>`;
  }

  function topologyFocusNode(workload, service, targetIDs, dependencyIDs) {
    const image = workload.images?.[0] || "";
    const ports = [...new Set([...service.ports.values()].map(formatDockerPort))];
    const activityRequest = encodeURIComponent(JSON.stringify({
      connection_id: workload.connection_id,
      kind: workload.kind,
      namespace: workload.namespace || "",
      name: workload.name,
      pod: "",
      container: "",
      topology_project: composeProjectName(workload),
    }));
    return `<article id="topology-focus" class="topology-node topology-focus-node" tabindex="0" data-topology-node data-topology-role="focus" data-topology-label="${html(workload.name)}" data-topology-connection="${html(workload.connection_id)}" data-topology-project="${html(composeProjectName(workload))}" data-topology-container="${html(workload.uid || "")}" data-topology-request="${activityRequest}" data-topology-openable="true" data-topology-targets="${html(targetIDs.join(" "))}" data-topology-dependencies="${html(dependencyIDs.join(" "))}" aria-label="${html(workload.name)} container. Double-click to open logs. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">C</span><div><strong>${html(workload.name)}</strong><small>${html(service.name)}</small></div><span class="status ${statusBucket(workload)}">${html(workload.state || "Unknown")}</span>${topologyNodeToggle(workload.name, true)}</div>
      ${topologyNodeDetails(`${image ? `<div class="topology-image" title="${html(image)}">${html(image)}</div>` : ""}${ports.length ? `<div class="topology-inline-facts"><strong>Ports</strong>${ports.map(port => `<code>${html(port)}</code>`).join("")}</div>` : ""}`, true)}
    </article>`;
  }

  function topologyProjectNode(model, resourceCount) {
    const focused = Boolean(routeInfo().params.get("focus"));
    const facts = [
      model.configFiles ? `<div><dt>Compose file</dt><dd title="${html(model.configFiles)}">${html(model.configFiles)}</dd></div>` : "",
      model.workingDir ? `<div><dt>Working directory</dt><dd title="${html(model.workingDir)}">${html(model.workingDir)}</dd></div>` : "",
      model.composeVersion ? `<div><dt>Compose</dt><dd>v${html(model.composeVersion)}</dd></div>` : "",
    ].join("");
    const openHint = focused ? "Double-click to open the full project view." : "Double-click to expand all connected nodes.";
    return `<article id="topology-project" class="topology-node topology-project-node" tabindex="0" data-topology-node data-topology-role="project" data-topology-label="${html(model.project)}" data-topology-connection="${html(model.connectionID)}" data-topology-project="${html(model.project)}" data-topology-openable="true" aria-label="${html(model.project)} project. ${openHint} Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">P</span><div><strong>${html(model.project)}</strong><small>${model.services.length} services · ${resourceCount} resources</small></div>${topologyNodeToggle(model.project)}</div>
      ${topologyNodeDetails(facts ? `<dl class="topology-project-facts">${facts}</dl>` : "")}
    </article>`;
  }

  function topologyServiceNode(service) {
    const workloads = [...service.workloads].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const workload = workloads.length === 1 ? workloads[0] : null;
    const good = workloads.filter(item => statusBucket(item) === "good").length;
    const bucket = workloads.some(item => statusBucket(item) === "bad")
      ? "bad"
      : workloads.some(item => statusBucket(item) === "warn")
        ? "warn"
        : good === workloads.length ? "good" : "other";
    const images = [...service.images];
    const ports = [...new Set([...service.ports.values()].map(formatDockerPort))];
    const dependencies = [...service.dependencies].sort();
    return `<article id="${html(service.nodeID)}" class="topology-node topology-service-node" tabindex="0" data-topology-node data-topology-role="service" data-topology-label="${html(service.name)}" data-topology-connection="${html(workloads[0]?.connection_id || "")}" data-topology-project="${html(workloads[0] ? composeProjectName(workloads[0]) : "")}" data-topology-focus="${html(workload?.name || "")}" data-topology-openable="true" data-topology-targets="${html(service.targetIDs.join(" "))}" data-topology-dependencies="${html(service.dependencyIDs.join(" "))}" aria-label="${html(service.name)} service with ${workloads.length} container${workloads.length === 1 ? "" : "s"}. Double-click to ${workload ? "open its connected view" : "show its containers"}. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">S</span><div><strong>${html(service.name)}</strong><small>${workloads.length} container${workloads.length === 1 ? "" : "s"}</small></div><span class="topology-state ${bucket}">${good}/${workloads.length}</span>${topologyNodeToggle(service.name)}</div>
      ${topologyNodeDetails(`${images.length ? `<div class="topology-image" title="${html(images.join(", "))}">${html(images.join(", "))}</div>` : ""}
      <div class="topology-container-list">${workloads.map(workload => {
        const encoded = encodeURIComponent(JSON.stringify({ connection_id: workload.connection_id, kind: workload.kind, namespace: workload.namespace || "", name: workload.name, topology_project: composeProjectName(workload) }));
        return `<button type="button" class="topology-container-link" data-workload="${encoded}"><span class="topology-container-state ${statusBucket(workload)}" aria-hidden="true"></span><span>${html(workload.name)}</span><span>${html(workload.state || "Unknown")}</span><span aria-hidden="true">→</span></button>`;
      }).join("")}</div>
      ${ports.length ? `<div class="topology-inline-facts"><strong>Ports</strong>${ports.map(port => `<code>${html(port)}</code>`).join("")}</div>` : ""}
      ${dependencies.length ? `<div class="topology-dependencies"><strong>Depends on</strong><span>${dependencies.map(html).join(" · ")}</span></div>` : ""}`)}
    </article>`;
  }

  function topologyNetworkNode(network, project) {
    const displayName = network.name.startsWith(`${project}_`) ? network.name.slice(project.length + 1) : network.name;
    return `<article id="${html(network.nodeID)}" class="topology-node topology-resource-node" tabindex="0" data-topology-node data-topology-role="network" data-topology-label="${html(displayName)}" data-topology-openable="true" aria-label="${html(displayName)} network with ${network.attachments.length} attachment${network.attachments.length === 1 ? "" : "s"}. Double-click to show attachments. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">N</span><div><strong>${html(displayName)}</strong><small>${html(network.name)} · ${network.attachments.length} attachment${network.attachments.length === 1 ? "" : "s"}</small></div>${topologyNodeToggle(displayName)}</div>
      ${topologyNodeDetails(`${network.gateway ? `<div class="topology-resource-path"><span>Gateway</span><code title="${html(network.networkID)}">${html(network.gateway)}</code></div>` : ""}
      <div class="topology-attachment-list">${network.attachments.sort(compareTopologyAttachments).map(item => `<div><span title="${html(item.container)}">${html(topologyAttachmentLabel(item))}</span><code title="${item.aliases.length ? `Aliases: ${html(item.aliases.join(", "))}` : ""}">${html(item.address || "attached")}</code></div>`).join("")}</div>`)}
    </article>`;
  }

  function topologyStorageNode(item) {
    const typeLabel = item.kind === "bind" ? "Host path" : item.kind === "volume" ? "Named volume" : item.kind;
    const source = item.kind === "volume" ? item.name : item.source || item.name;
    return `<article id="${html(item.nodeID)}" class="topology-node topology-resource-node" tabindex="0" data-topology-node data-topology-role="storage" data-topology-label="${html(source)}" data-topology-openable="true" aria-label="${html(source)} ${html(typeLabel.toLowerCase())} with ${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}. Double-click to show attachments. Shift+F10 for actions.">
      <div class="topology-node-heading"><span class="topology-node-mark">${item.kind === "bind" ? "H" : "V"}</span><div><strong title="${html(source)}">${html(source)}</strong><small>${html(typeLabel)} · ${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}</small></div>${topologyNodeToggle(source)}</div>
      ${topologyNodeDetails(`${item.kind === "volume" && item.source && item.source !== item.name ? `<div class="topology-resource-path"><span>Docker host path</span><code title="${html(item.source)}">${html(item.source)}</code></div>` : ""}
      <div class="topology-attachment-list">${item.attachments.sort(compareTopologyAttachments).map(attachment => `<div><span title="${html(attachment.container)}">${html(topologyAttachmentLabel(attachment))}</span><code>${html(attachment.destination)}${attachment.readOnly ? " · read-only" : ""}</code></div>`).join("")}</div>`)}
    </article>`;
  }

  function topologyAttachmentLabel(attachment) {
    return attachment.containerNumber ? `${attachment.service} #${attachment.containerNumber}` : attachment.service;
  }

  function compareTopologyAttachments(a, b) {
    return String(a.service).localeCompare(String(b.service))
      || Number(a.containerNumber || 0) - Number(b.containerNumber || 0)
      || String(a.container).localeCompare(String(b.container));
  }

  function formatDockerPort(port) {
    const protocol = port.protocol || "tcp";
    if (!port.host_port) return `${port.container_port}/${protocol}`;
    const host = !port.host_ip || port.host_ip === "0.0.0.0" || port.host_ip === "::" ? "" : `${port.host_ip}:`;
    return `${host}${port.host_port} → ${port.container_port}/${protocol}`;
  }

  function clampTopologyZoom(value) {
    return Math.min(1.6, Math.max(0.5, Math.round(value * 10) / 10));
  }

  function scheduleTopologyDraw() {
    if (state.topologyDrawFrame) cancelAnimationFrame(state.topologyDrawFrame);
    state.topologyDrawFrame = requestAnimationFrame(drawTopologyEdges);
  }

  function applyTopologyZoom(value) {
    const viewport = document.getElementById("topology-viewport");
    const world = document.getElementById("topology-world");
    const map = viewport?.querySelector(".topology-map");
    if (!viewport || !world || !map) return;
    state.topologyZoom = clampTopologyZoom(value);
    const naturalWidth = viewport.clientWidth;
    map.style.width = `${naturalWidth}px`;
    map.style.transform = `scale(${state.topologyZoom})`;
    world.style.width = `${naturalWidth * state.topologyZoom}px`;
    world.style.height = `${map.offsetHeight * state.topologyZoom}px`;
    const label = document.getElementById("topology-zoom-level");
    if (label) label.textContent = `${Math.round(state.topologyZoom * 100)}%`;
    scheduleTopologyDraw();
  }

  function updateTopologyExpandControl() {
    const toggles = [...document.querySelectorAll(".topology-node-toggle")];
    const allExpanded = toggles.length > 0 && toggles.every(button => button.getAttribute("aria-expanded") === "true");
    const button = document.querySelector('[data-action="toggle-all-topology-nodes"]');
    if (button) {
      button.textContent = allExpanded ? "Collapse all" : "Expand all";
      button.setAttribute("aria-pressed", String(allExpanded));
    }
  }

  function toggleTopologyNode(node, forceExpanded, deferLayout = false) {
    const button = node?.querySelector(":scope > .topology-node-heading .topology-node-toggle");
    const details = node?.querySelector(":scope > .topology-node-details");
    if (!node || !button || !details) return;
    const expanded = forceExpanded ?? button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${node.querySelector(":scope > .topology-node-heading strong")?.textContent || "node"} details`);
    details.hidden = !expanded;
    updateTopologyExpandControl();
    if (!deferLayout) requestAnimationFrame(() => applyTopologyZoom(state.topologyZoom));
  }

  function toggleAllTopologyNodes() {
    const nodes = [...document.querySelectorAll(".topology-node")].filter(node => node.querySelector(":scope > .topology-node-details"));
    const shouldExpand = nodes.some(node => node.querySelector(":scope > .topology-node-details")?.hidden);
    setAllTopologyNodes(shouldExpand);
  }

  function setAllTopologyNodes(expanded) {
    const nodes = [...document.querySelectorAll(".topology-node")].filter(node => node.querySelector(":scope > .topology-node-details"));
    nodes.forEach(node => toggleTopologyNode(node, expanded, true));
    updateTopologyExpandControl();
    requestAnimationFrame(() => applyTopologyZoom(state.topologyZoom));
  }

  function openTopologyNodeView(node) {
    if (!node) return;
    const role = node.dataset.topologyRole || "";
    const connection = node.dataset.topologyConnection || routeInfo().params.get("connection_id") || "";
    const project = node.dataset.topologyProject || routeInfo().params.get("project") || "";
    const focus = node.dataset.topologyFocus || "";
    if (role === "project") {
      if (routeInfo().params.get("focus")) {
        navigate(`/topology?${new URLSearchParams({ connection_id: connection, project }).toString()}`);
      } else {
        setAllTopologyNodes(true);
      }
      return;
    }
    if (role === "focus" && node.dataset.topologyRequest) {
      const request = JSON.parse(decodeURIComponent(node.dataset.topologyRequest));
      navigate(`/activity?${new URLSearchParams(request).toString()}`);
      return;
    }
    if (focus && connection && project) {
      navigate(`/topology?${new URLSearchParams({ connection_id: connection, project, focus }).toString()}`);
      return;
    }
    if (node.querySelector(":scope > .topology-node-details")) toggleTopologyNode(node, true);
  }

  function topologyContextIcon(name) {
    const paths = {
      logs: '<path d="M3.5 4.5 6.5 8l-3 3.5M8.5 11.5h4"/>',
      topology: '<circle cx="3.5" cy="8" r="1.5"/><circle cx="12.5" cy="4" r="1.5"/><circle cx="12.5" cy="12" r="1.5"/><path d="M5 8h2.2c1.5 0 1.8-4 3.8-4M7.2 8c1.5 0 1.8 4 3.8 4"/>',
      workloads: '<rect x="3" y="3.5" width="10" height="3" rx="1"/><rect x="3" y="9.5" width="10" height="3" rx="1"/><path d="M5.5 5h.01M5.5 11h.01"/>',
      connected: '<rect x="2.5" y="5.5" width="4" height="5" rx="1"/><rect x="9.5" y="2.5" width="4" height="4" rx="1"/><rect x="9.5" y="9.5" width="4" height="4" rx="1"/><path d="M6.5 8h1c1.2 0 1-3.5 2-3.5M7.5 8c1.2 0 1 3.5 2 3.5"/>',
      expand: '<path d="m5.5 2.5-3 3m0-3v3h3M10.5 13.5l3-3m0 3v-3h-3"/>',
      collapse: '<path d="m2.5 5.5 3-3m0 3v-3h-3M13.5 10.5l-3 3m0-3v3h3"/>',
      containers: '<rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><path d="M5 5h.01M5 11h.01"/>',
      attachments: '<path d="M6.4 9.6 4.8 11.2a2.1 2.1 0 0 1-3-3l2.5-2.5a2.1 2.1 0 0 1 3 0M9.6 6.4l1.6-1.6a2.1 2.1 0 0 1 3 3l-2.5 2.5a2.1 2.1 0 0 1-3 0M5.8 10.2l4.4-4.4"/>',
      copy: '<rect x="5.5" y="5.5" width="7" height="7" rx="1.3"/><path d="M10.5 5.5V4.2a1.7 1.7 0 0 0-1.7-1.7H4.2a1.7 1.7 0 0 0-1.7 1.7v4.6a1.7 1.7 0 0 0 1.7 1.7h1.3"/>',
      restart: '<path d="M12.8 5.4V2.7l-1.7 1.7A5.3 5.3 0 1 0 13 9.8"/><path d="M12.8 2.7h-2.7"/>',
      delete: '<path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6"/>',
    };
    return `<svg viewBox="0 0 16 16" aria-hidden="true">${paths[name] || paths.topology}</svg>`;
  }

  function topologyContextAction(action, label, values = {}, icon = "topology") {
    const attributes = Object.entries(values)
      .map(([key, value]) => ` data-${key}="${html(value)}"`)
      .join("");
    return `<button type="button" role="menuitem" data-action="${html(action)}"${attributes}><span class="topology-context-action-icon">${topologyContextIcon(icon)}</span><span>${html(label)}</span></button>`;
  }

  function closeTopologyContextMenu(restoreFocus = false) {
    const menu = document.getElementById("topology-context-menu");
    if (!menu) return;
    const owner = document.getElementById(menu.dataset.owner || "");
    owner?.classList.remove("topology-node-context-active");
    menu.remove();
    if (restoreFocus) owner?.focus();
  }

  function showTopologyContextMenu(node, clientX, clientY, focusMenu = false) {
    if (!node || state.route?.path !== "/topology") return;
    closeTopologyContextMenu();
    const role = node.dataset.topologyRole || "resource";
    const label = node.dataset.topologyLabel || node.querySelector(":scope > .topology-node-heading strong")?.textContent || "Resource";
    const connection = node.dataset.topologyConnection || routeInfo().params.get("connection_id") || "";
    const project = node.dataset.topologyProject || routeInfo().params.get("project") || "";
    const focus = node.dataset.topologyFocus || "";
    const containerID = node.dataset.topologyContainer || "";
    const managed = canManageDockerConnection(connection);
    const details = node.querySelector(":scope > .topology-node-details");
    const expanded = details ? !details.hidden : false;
    const actions = [];
    const typeLabels = {
      project: "Compose project",
      focus: "Container",
      service: "Service",
      dependency: "Service",
      network: "Network",
      storage: "Storage",
    };
    const typeLabel = typeLabels[role] || "Resource";
    const mark = node.querySelector(":scope > .topology-node-heading .topology-node-mark")?.textContent?.trim() || "•";

    if (role === "project") {
      if (routeInfo().params.get("focus")) {
        actions.push(topologyContextAction("open-topology-project", "Open project topology", { connection, project }, "topology"));
      } else {
        const hasCollapsed = [...document.querySelectorAll(".topology-node-details")].some(item => item.hidden);
        actions.push(topologyContextAction("set-all-topology-nodes", hasCollapsed ? "Expand all details" : "Collapse all details", { expanded: hasCollapsed }, hasCollapsed ? "expand" : "collapse"));
      }
      actions.push(topologyContextAction("filter-topology-node-workloads", "Show project workloads", { connection, search: project }, "workloads"));
      if (managed) actions.push(topologyContextAction("restart-compose-project", "Restart project", { connection, project }, "restart"));
    } else if (role === "focus") {
      actions.push(topologyContextAction("open-topology-logs", "Open logs", { request: node.dataset.topologyRequest || "" }, "logs"));
      actions.push(topologyContextAction("open-topology-project", "Open project topology", { connection, project }, "topology"));
      actions.push(topologyContextAction("filter-topology-node-workloads", "Show in workloads", { connection, search: label }, "workloads"));
      if (managed && containerID) {
        actions.push(`<div class="topology-context-separator" role="separator"></div>`);
        actions.push(topologyContextAction("restart-docker-container", "Restart container", { connection, container: containerID, name: label }, "restart"));
        actions.push(topologyContextAction("delete-docker-container", "Delete container", { connection, container: containerID, name: label }, "delete"));
      }
    } else if (role === "service" || role === "dependency") {
      if (focus) actions.push(topologyContextAction("open-topology-connected", "Open connected view", { connection, project, focus }, "connected"));
      if (details) actions.push(topologyContextAction("toggle-topology-context-node", expanded ? "Collapse details" : "Show containers", { node: node.id }, expanded ? "collapse" : "containers"));
      actions.push(topologyContextAction("filter-topology-node-workloads", "Show service workloads", { connection, search: label }, "workloads"));
    } else if (details) {
      actions.push(topologyContextAction("toggle-topology-context-node", expanded ? "Hide attachments" : "Show attached containers", { node: node.id }, expanded ? "collapse" : "attachments"));
    }

    actions.push(`<div class="topology-context-separator" role="separator"></div>`);
    actions.push(topologyContextAction("copy-topology-node-name", `Copy ${role === "project" ? "project name" : "name"}`, { value: label }, "copy"));
    document.body.insertAdjacentHTML("beforeend", `<div id="topology-context-menu" class="topology-context-menu" role="menu" aria-label="${html(label)} actions" data-owner="${html(node.id)}">
      <div class="topology-context-heading"><span class="topology-context-node-mark" aria-hidden="true">${html(mark)}</span><span><strong title="${html(label)}">${html(label)}</strong><small>${html(typeLabel)}</small></span></div>
      ${actions.join("")}
    </div>`);
    const menu = document.getElementById("topology-context-menu");
    if (!menu) return;
    node.classList.add("topology-node-context-active");
    const bounds = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    if (focusMenu) menu.querySelector('[role="menuitem"]')?.focus();
  }

  function bindTopologyCanvas() {
    const map = document.querySelector(".topology-map");
    const viewport = document.getElementById("topology-viewport");
    if (!map || !viewport) return;
    state.topologyObserver = new ResizeObserver(() => applyTopologyZoom(state.topologyZoom));
    state.topologyObserver.observe(map);
    state.topologyObserver.observe(viewport);
    const highlight = event => {
      const node = event.target.closest?.("[data-topology-node]");
      if (!node || !map.contains(node)) return;
      map.dataset.highlightNode = node.id;
      map.querySelectorAll(".topology-edge").forEach(edge => {
        edge.classList.toggle("active", edge.dataset.from === node.id || edge.dataset.to === node.id);
      });
    };
    const clearHighlight = event => {
      const node = event.target.closest?.("[data-topology-node]");
      if (node && event.relatedTarget && node.contains(event.relatedTarget)) return;
      delete map.dataset.highlightNode;
      map.querySelectorAll(".topology-edge.active").forEach(edge => edge.classList.remove("active"));
    };
    map.addEventListener("pointerover", highlight);
    map.addEventListener("pointerout", clearHighlight);
    map.addEventListener("focusin", highlight);
    map.addEventListener("focusout", clearHighlight);
    viewport.addEventListener("wheel", event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      applyTopologyZoom(state.topologyZoom + (event.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });
    viewport.addEventListener("keydown", event => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        applyTopologyZoom(state.topologyZoom + 0.1);
      } else if (event.key === "-") {
        event.preventDefault();
        applyTopologyZoom(state.topologyZoom - 0.1);
      } else if (event.key === "0") {
        event.preventDefault();
        applyTopologyZoom(1);
      }
    });
    updateTopologyExpandControl();
    requestAnimationFrame(() => applyTopologyZoom(state.topologyZoom));
  }

  function drawTopologyEdges() {
    state.topologyDrawFrame = 0;
    const map = document.querySelector(".topology-map");
    const svg = map?.querySelector(".topology-edge-layer");
    const root = document.getElementById("topology-project");
    if (!map || !svg || !root) return;
    const mapRect = map.getBoundingClientRect();
    const scale = state.topologyZoom || 1;
    const mapWidth = map.offsetWidth;
    const mapHeight = map.offsetHeight;
    svg.setAttribute("viewBox", `0 0 ${mapWidth} ${mapHeight}`);
    svg.setAttribute("width", mapWidth);
    svg.setAttribute("height", mapHeight);
    const pathFor = (from, to, kind) => {
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const startX = (fromRect.right - mapRect.left) / scale;
      const startY = (fromRect.top + fromRect.height / 2 - mapRect.top) / scale;
      const endX = (toRect.left - mapRect.left) / scale;
      const endY = (toRect.top + toRect.height / 2 - mapRect.top) / scale;
      const bend = Math.max(34, Math.abs(endX - startX) * .48);
      return `<path class="topology-edge ${kind}" data-from="${html(from.id)}" data-to="${html(to.id)}" d="M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${(startX + bend).toFixed(1)} ${startY.toFixed(1)}, ${(endX - bend).toFixed(1)} ${endY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}"></path>`;
    };
    const dependencyPathFor = (from, to) => {
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const startX = (fromRect.right - mapRect.left) / scale;
      const startY = (fromRect.top + fromRect.height / 2 - mapRect.top) / scale;
      const endX = (toRect.right - mapRect.left) / scale;
      const endY = (toRect.top + toRect.height / 2 - mapRect.top) / scale;
      const sideX = Math.max(startX, endX) + 20;
      return `<path class="topology-edge dependency-edge" data-from="${html(from.id)}" data-to="${html(to.id)}" d="M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${sideX.toFixed(1)} ${startY.toFixed(1)}, ${sideX.toFixed(1)} ${endY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}"></path>`;
    };
    const paths = [];
    const focus = document.getElementById("topology-focus");
    if (focus) {
      paths.push(pathFor(root, focus, "project-edge"));
      for (const dependency of document.querySelectorAll('[data-topology-role="dependency"]')) {
        paths.push(pathFor(dependency, focus, "dependency-edge"));
      }
      for (const targetID of String(focus.dataset.topologyTargets || "").split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(targetID);
        if (target) paths.push(pathFor(focus, target, "resource-edge"));
      }
      svg.innerHTML = paths.join("");
      return;
    }
    document.querySelectorAll('[data-topology-role="service"]').forEach(service => {
      paths.push(pathFor(root, service, "project-edge"));
      for (const targetID of String(service.dataset.topologyTargets || "").split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(targetID);
        if (target) paths.push(pathFor(service, target, "resource-edge"));
      }
      for (const dependencyID of String(service.dataset.topologyDependencies || "").split(/\s+/).filter(Boolean)) {
        const dependency = document.getElementById(dependencyID);
        if (dependency) paths.push(dependencyPathFor(service, dependency));
      }
    });
    svg.innerHTML = paths.join("");
  }

  function stopTopologyLayout() {
    state.topologyObserver?.disconnect();
    state.topologyObserver = null;
    if (state.topologyDrawFrame) cancelAnimationFrame(state.topologyDrawFrame);
    state.topologyDrawFrame = 0;
  }

  function metricCPUCell(metric) {
    return `<div class="metric-cell">${html(formatCPU(metric))}</div><div class="cell-subtitle">${metric ? html(formatTime(metric.timestamp)) : html(workloadMetricPlaceholder())}</div>`;
  }

  function metricMemoryCell(metric) {
    return `<div class="metric-cell">${html(formatMemory(metric))}</div><div class="cell-subtitle">${metric?.memory_limit_bytes ? "usage / limit" : metric ? "working set" : html(workloadMetricPlaceholder())}</div>`;
  }

  function workloadMetricPlaceholder() {
    if (state.workloadMetricsLoading) return "Loading…";
    if (state.workloadMetricsDeferred) return "Not loaded";
    if (state.workloadMetricsLoaded) return "No sample";
    return "After discovery";
  }

  function metricKey(item) {
    return [item.connection_id || "", item.namespace || "", item.kind || "", item.name || ""].join("|");
  }

  function formatCPU(metric) {
    if (!metric || metric.error) return "—";
    if (metric.cpu_percent !== undefined && metric.cpu_percent !== null) return `${Number(metric.cpu_percent).toFixed(metric.cpu_percent >= 10 ? 1 : 2)}%`;
    const millicores = Number(metric.cpu_cores || 0) * 1000;
    return millicores >= 1000 ? `${(millicores / 1000).toFixed(2)} cores` : `${millicores.toFixed(millicores >= 10 ? 0 : 1)}m`;
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let current = bytes;
    let index = 0;
    while (current >= 1024 && index < units.length - 1) { current /= 1024; index += 1; }
    return `${current.toFixed(current >= 100 || index === 0 ? 0 : current >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function formatMemory(metric) {
    if (!metric || metric.error) return "—";
    const usage = formatBytes(metric.memory_bytes);
    return metric.memory_limit_bytes ? `${usage} / ${formatBytes(metric.memory_limit_bytes)}` : usage;
  }

  function statusBucket(item) {
    const value = `${item.severity || ""} ${item.state || ""}`.toLowerCase();
    if (/error|failed|failure|degraded|unhealthy|crash|terminated/.test(value)) return "bad";
    if (/warning|pending|restart|progress|unknown|notready|not ready/.test(value)) return "warn";
    if (/healthy|ready|running|available|active|created/.test(value)) return "good";
    return "other";
  }

  function emptyState(title, copy, button, action) {
    return `<div class="empty"><div class="empty-inner"><div class="empty-symbol" aria-hidden="true">◇</div><h2>${html(title)}</h2><p>${html(copy)}</p>${button ? `<button class="btn primary" data-action="${html(action)}">${html(button)}</button>` : ""}</div></div>`;
  }

  function bindWorkloadControls() {
    bindWorkloadViewport();
    const search = document.getElementById("workload-search");
    if (search) search.addEventListener("input", debounce(() => {
      state.filters.search = search.value;
      state.workloadBrowseMode = "auto";
      updateWorkloadView(true);
    }, 120));
    [["connection-filter", "connection"], ["namespace-filter", "namespace"], ["status-filter", "status"]].forEach(([id, key]) => {
      document.getElementById(id)?.addEventListener("change", event => {
        state.filters[key] = ["connection", "namespace"].includes(key)
          ? filterInputValues(event.target.value)
          : event.target.value;
        state.workloadBrowseMode = "auto";
        updateWorkloadView(true);
      });
    });
    document.querySelectorAll(".workload-filter-menu [data-log-menu-search]").forEach(input => {
      input.addEventListener("input", event => filterLogMenuOptions(event.target.closest(".log-menu-field"), event.target.value));
    });
  }

  function syncWorkloadFilterControls() {
    const search = document.getElementById("workload-search");
    if (search) search.value = state.filters.search;
    updateWorkloadFilterMenu("connection", state.filters.connection);
    updateWorkloadFilterMenu("namespace", state.filters.namespace);
    updateWorkloadFilterMenu("status", state.filters.status);
  }

  function updateWorkloadFilterMenu(filter, value) {
    const field = document.querySelector(`[data-workload-filter="${filter}"]`);
    if (!field) return;
    const multiple = field.dataset.multiple === "true";
    const input = field.querySelector("input[type=hidden]");
    const options = [...field.querySelectorAll(".log-menu-option")];
    const values = filterValues(value);
    const selected = options.filter(option => option.dataset.value && values.includes(option.dataset.value));
    const allOption = options.find(option => !option.dataset.value) || options[0];
    const label = multiple && selected.length > 1
      ? `${selected.length} ${filter === "connection" ? "connections" : "namespaces"}`
      : selected[0]?.dataset.label || allOption?.dataset.label || allOption?.textContent?.trim() || "";
    const fullLabel = selected.length ? selected.map(option => option.dataset.label).join(", ") : allOption?.dataset.label || "";
    if (input) input.value = multiple ? JSON.stringify(values) : values[0] || "";
    field.querySelector("[data-log-menu-label]")?.replaceChildren(document.createTextNode(label));
    const trigger = field.querySelector(".log-menu-trigger");
    if (trigger) {
      const filterLabel = filter === "connection" ? "Connection" : filter === "namespace" ? "Namespace" : "State";
      trigger.setAttribute("aria-label", `${filterLabel}: ${fullLabel}`);
      trigger.title = fullLabel;
    }
    for (const option of options) {
      const isSelected = option.dataset.value ? values.includes(option.dataset.value) : values.length === 0;
      option.classList.toggle("selected", isSelected);
      option.setAttribute("aria-selected", String(isSelected));
    }
    updateWorkloadFilterDraftSummary(field);
  }

  function filterInputValues(value) {
    try {
      const parsed = JSON.parse(value);
      return filterValues(parsed);
    } catch {
      return filterValues(value);
    }
  }

  function updateWorkloadFilterDraftSummary(field) {
    const summary = field?.querySelector("[data-workload-selection-count]");
    if (!summary) return;
    const count = [...field.querySelectorAll(".log-menu-option.selected")].filter(option => option.dataset.value).length;
    summary.textContent = count ? `${count} selected` : "All";
  }

  function resetWorkloadFilterDraft(field) {
    if (!field || field.dataset.multiple !== "true") return;
    const values = filterInputValues(field.querySelector("input[type=hidden]")?.value || "[]");
    for (const option of field.querySelectorAll(".log-menu-option")) {
      const selected = option.dataset.value ? values.includes(option.dataset.value) : values.length === 0;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    }
    updateWorkloadFilterDraftSummary(field);
  }
