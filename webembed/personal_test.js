const assert = require("node:assert/strict");
const personal = require("./dist/personal.js");

const memory = new Map();
const storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
const store = personal.load(storage);
const session = personal.createSession(store, { connection_id: "local", name: "api" }, "API incident");
personal.addEvidence(store, "log", { message: "authorization: Bearer abc123", fields: { token: "secret", trace_id: "trace-1" } });
personal.updateSession(store, session.id, { notes: "password=hunter2" });
assert.equal(personal.save(store, storage).ok, true);
assert.equal(personal.load(storage).sessions.length, 1);

const exported = personal.exportBundle(session, []);
assert.match(JSON.stringify(exported.value), /REDACTED/);
assert.doesNotMatch(JSON.stringify(exported.value), /hunter2|abc123|"secret"/);
assert.equal(personal.correlationIDs(session.evidence)[0].value, "trace-1");

const importedStore = personal.emptyStore();
const imported = personal.importBundle(importedStore, exported.value);
assert.equal(imported.status, "closed");
assert.match(imported.name, /imported/);

const view = personal.saveView(store, "workloads", "Production", { filters: { namespace: ["prod"] } });
assert.equal(view.kind, "workloads");
assert.equal(store.views.length, 1);
personal.renameView(store, view.id, "Production workloads");
assert.equal(store.views[0].name, "Production workloads");
personal.addRecent(store, { key: "workload:a", label: "api", detail: "prod", route: "/activity?a=1" });
personal.addRecent(store, { key: "workload:a", label: "api", detail: "prod", route: "/activity?a=1" });
assert.equal(store.recents.length, 1);

assert.equal(personal.validateHandoff("https://grafana.example/explore?namespace={namespace}").ok, true);
assert.equal(personal.resolveHandoff("https://grafana.example/explore?namespace={namespace}", { namespace: "prod east" }), "https://grafana.example/explore?namespace=prod%20east");
assert.equal(personal.validateHandoff("javascript:alert(1)").ok, false);
assert.equal(personal.compareVersions("0.2.0", "0.1.9"), 1);
assert.equal(personal.reconnectDelay(1, 0.5), 1000);

console.log("personal workflow tests passed");
