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
      const handled = await dispatchAction(action, { target, event });
      if (!handled) console.warn(`Unhandled UI action: ${action}`);
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
