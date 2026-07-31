const assert = require("node:assert/strict");
const navigation = require("./dist/navigation.js");

const route = navigation.parseRoute("#/activity?connection_id=local&kind=Container&name=api");
assert.equal(route.path, "/activity");
assert.equal(route.params.get("name"), "api");

const targets = [{ connection_id: "one", kind: "Deployment", namespace: "prod", name: "api", pod: "", container: "" }, { connection_id: "two", kind: "Container", namespace: "", name: "worker", pod: "", container: "" }];
const merged = navigation.activityQuery({ targets });
assert.deepEqual(navigation.activityTargets(merged), targets);
assert.equal(navigation.activityTargets(new URLSearchParams("targets=corrupt")).length, 0);

console.log("navigation tests passed");
