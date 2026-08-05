  registerActionHandler("connections", [
    "add-connection",
    "add-connection-kind",
    "filter-connections",
    "toggle-connection-menu",
    "edit-connection",
    "save-connection-edit",
    "view-connection-workloads",
    "switch-add-kind",
    "settings-tab",
    "manage-ssh-profiles",
    "add-ssh-profile",
    "save-ssh-profile",
    "save-inline-ssh-profile",
    "cancel-inline-ssh",
    "test-ssh-profile",
    "delete-ssh-profile",
    "confirm-delete-ssh-profile",
    "test-draft-connection",
    "test-agent-ssh",
    "submit-connection",
    "close-modal",
    "backdrop",
    "test-connection",
    "delete-connection",
    "confirm-delete-connection",
    "deploy-agent",
    "submit-agent",
    "copy-code",
    "finish-agent-setup"
  ], async (action, { target, event }) => {
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
      default:
        return;
    }
  });
