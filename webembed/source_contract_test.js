const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const appDirectory = path.join(root, "src", "app");
const styleDirectory = path.join(root, "src", "styles");
const appSource = fs.readdirSync(appDirectory)
  .filter(name => name.endsWith(".js"))
  .sort()
  .map(name => fs.readFileSync(path.join(appDirectory, name), "utf8"))
  .join("\n");
const styleSource = fs.readdirSync(styleDirectory)
  .filter(name => name.endsWith(".css"))
  .sort()
  .map(name => fs.readFileSync(path.join(styleDirectory, name), "utf8"))
  .join("\n");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(!/<button(?![^>]*\btype=)/.test(appSource), "every generated button must declare its type");

const renderedActions = new Set([...appSource.matchAll(/data-action="([a-z0-9-]+)"/g)].map(match => match[1]));
const registeredActions = [...appSource.matchAll(/case "([a-z0-9-]+)"/g)].map(match => match[1]);
const registrationCounts = new Map();
for (const action of registeredActions) registrationCounts.set(action, (registrationCounts.get(action) || 0) + 1);

const missingActions = [...renderedActions].filter(action => !registrationCounts.has(action));
const duplicateActions = [...registrationCounts].filter(([, count]) => count > 1).map(([action]) => action);
assert(!missingActions.length, `unregistered UI actions: ${missingActions.join(", ")}`);
assert(!duplicateActions.length, `duplicate UI actions: ${duplicateActions.join(", ")}`);

assert(appSource.includes("app.inert = true"), "modal manager must make the application background inert");
assert(appSource.includes("trapModalFocus"), "modal manager must contain keyboard focus");
assert(appSource.includes("modalReturnFocus"), "modal manager must restore invoker focus");
assert(styleSource.includes("@media (prefers-reduced-motion: reduce)"), "styles must honor reduced motion");
assert(/input::placeholder[^}]+var\(--subtle\)/.test(styleSource), "input placeholders must use the accessible quiet-text token");

console.log("embedded UI source contracts passed");
