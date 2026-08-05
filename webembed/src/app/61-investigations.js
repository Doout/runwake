  function investigationEvidenceLabel(item) {
    const payload = item.payload || {};
    if (item.kind === "metric") return `${payload.name || "Metric"} · ${formatTime(payload.timestamp)}`;
    const message = String(payload.message || payload.summary || item.kind).replace(/\s+/g, " ").trim();
    return `${item.kind} · ${message.slice(0, 110)}`;
  }

  function investigationTimeline(session) {
    const items = [...(session.evidence || [])].sort((a, b) => new Date(a.payload?.timestamp || a.pinnedAt) - new Date(b.payload?.timestamp || b.pinnedAt));
    if (!items.length) return `<div class="investigation-empty">Pin a log record, runtime event, or metric sample while inspecting a workload.</div>`;
    return `<ol class="investigation-timeline">${items.map(item => `<li><time>${html(formatTime(item.payload?.timestamp || item.pinnedAt, true))}</time><span class="evidence-kind">${html(item.kind)}</span><strong>${html(investigationEvidenceLabel(item).replace(/^\w+ · /, ""))}</strong><small>${html(item.payload?.workload || item.payload?.name || item.payload?.source || "")}</small></li>`).join("")}</ol>`;
  }

  function renderInvestigations() {
    if (!investigationsAvailable()) return navigate("/workloads");
    const sessions = state.personal.sessions || [];
    const active = activeInvestigation();
    const viewed = active || sessions.find(item => item.id === state.viewingSessionID && item.readOnly);
    shell(`<section class="page investigations-page">
      <header class="page-header"><div><h1 class="page-title">Investigations</h1><p class="page-description">Local evidence only. Nothing on this page is stored by the Runwake server.</p></div><div class="header-actions"><label class="btn file-button">Import<input id="investigation-import" type="file" accept="application/json,.json" hidden></label>${active ? `<button type="button" class="btn" data-action="close-investigation" data-id="${html(active.id)}">Finish current</button>` : `<button type="button" class="btn primary" data-action="new-investigation">New investigation</button>`}</div></header>
      ${viewed ? `<section class="investigation-workbench">
        <div class="investigation-heading"><div><span class="live-signal ${viewed.readOnly ? "readonly" : ""}" aria-hidden="true"></span><input id="investigation-name" class="investigation-name" value="${html(viewed.name)}" aria-label="Investigation name" ${viewed.readOnly ? "readonly" : ""}></div><span>${viewed.readOnly ? "Imported read-only · " : ""}${viewed.evidence.length} pinned · updated ${html(relativeTime(viewed.updatedAt))}</span></div>
        <div class="investigation-layout"><div>${investigationTimeline(viewed)}</div><aside><label>Notes<textarea id="investigation-notes" class="field" rows="10" placeholder="Record what you observed, not a guessed cause." ${viewed.readOnly ? "readonly" : ""}>${html(viewed.notes)}</textarea></label><div class="investigation-actions"><button type="button" class="btn" data-action="export-investigation" data-id="${html(viewed.id)}">Export evidence</button>${viewed.readOnly ? "" : `<button type="button" class="btn ghost" data-action="configure-handoffs">Handoffs</button>`}</div></aside></div>
      </section>` : `<div class="investigation-empty-state"><span aria-hidden="true">◎</span><h2>No active investigation</h2><p>Start one before opening live evidence, or import a bundle created earlier.</p><button type="button" class="btn primary" data-action="new-investigation">Start investigation</button></div>`}
      ${sessions.length ? `<section class="investigation-history"><div class="section-head"><h2 class="section-title">Local history</h2><span class="hint">Latest ${sessions.length} sessions</span></div><div class="investigation-list">${sessions.map(session => `<article><button type="button" data-action="activate-investigation" data-id="${html(session.id)}"><span class="status ${session.status === "active" ? "good" : "other"}">${html(session.status)}</span><strong>${html(session.name)}</strong><small>${session.evidence.length} pinned · ${html(relativeTime(session.updatedAt))}</small></button><div><button type="button" class="btn ghost small" data-action="export-investigation" data-id="${html(session.id)}">Export</button><button type="button" class="btn ghost small danger" data-action="delete-investigation" data-id="${html(session.id)}">Delete</button></div></article>`).join("")}</div></section>` : ""}
    </section>`, "investigations");
    bindInvestigationControls();
  }

  function bindInvestigationControls() {
    const active = activeInvestigation();
    const persist = debounce(() => {
      if (!active) return;
      personal.updateSession(state.personal, active.id, { name: document.getElementById("investigation-name")?.value, notes: document.getElementById("investigation-notes")?.value });
      savePersonalState();
    }, 220);
    document.getElementById("investigation-name")?.addEventListener("input", persist);
    document.getElementById("investigation-notes")?.addEventListener("input", persist);
    document.getElementById("investigation-import")?.addEventListener("change", async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const session = personal.importBundle(state.personal, await file.text());
        savePersonalState(`${session.name} imported`);
        renderInvestigations();
      } catch (error) {
        toast(`Import failed: ${error.message}`, "error");
      }
    });
  }
