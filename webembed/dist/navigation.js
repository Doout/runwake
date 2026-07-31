(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RunwakeNavigation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function parseRoute(hash) {
    const raw = String(hash || "").replace(/^#/, "") || "/workloads";
    const url = new URL(raw, "http://runwake.local");
    return { path: url.pathname, params: url.searchParams };
  }

  function activityTargets(params) {
    const encoded = params.get("targets");
    if (!encoded) return [];
    try {
      const values = JSON.parse(encoded);
      if (!Array.isArray(values)) return [];
      return values.slice(0, 12).map(item => ({ connection_id: String(item.connection_id || ""), kind: String(item.kind || ""), namespace: String(item.namespace || ""), name: String(item.name || ""), pod: String(item.pod || ""), container: String(item.container || "") })).filter(item => item.connection_id && item.kind && item.name);
    } catch {
      return [];
    }
  }

  function activityQuery(request, extra) {
    if (request?.targets?.length > 1) return new URLSearchParams({ targets: JSON.stringify(request.targets), ...(extra || {}) });
    const { targets: ignored, ...single } = request || {};
    return new URLSearchParams({ ...single, ...(extra || {}) });
  }

  return { parseRoute, activityTargets, activityQuery };
});
