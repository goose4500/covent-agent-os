import assert from "node:assert/strict";
import { DEFAULT_ACTION_METADATA, loadActionMetadata, loadRegistry, validateRegistry } from "./lib/control-plane/registry-loader.mjs";

const registry = loadRegistry();

assert.equal(registry.version, 1);
assert.ok(Array.isArray(registry.actions));

const runAction = registry.actions.find((action) => action.key === "run-action");
assert.ok(runAction, "run-action action should exist");
assert.equal(runAction.status, "active");
assert.equal(typeof runAction.name, "string");
assert.equal(typeof runAction.description, "string");
assert.equal(typeof runAction.runtime, "object");
assert.equal(runAction.riskLevel, "bounded");
assert.equal(runAction.approvalMode, "Slack confirmation required before start");
assert.ok(Array.isArray(runAction.artifacts));
assert.ok(runAction.artifacts.includes("Slack thread updates"));
assert.ok(Array.isArray(runAction.sourceLinks));
assert.ok(runAction.sourceLinks.includes("Slack source thread"));
assert.equal(loadActionMetadata("run-action").key, "run-action");
assert.equal(DEFAULT_ACTION_METADATA.key, "run-action");

const repoHealth = registry.actions.find((action) => action.key === "repo-health");
assert.ok(repoHealth, "repo-health action should exist");
assert.equal(repoHealth.status, "planned");
assert.equal(repoHealth.riskLevel, "read-only");
assert.equal(repoHealth.approvalMode, "Slack confirmation required before start");

assert.ok(Array.isArray(registry.legacyRoutes), "legacyRoutes should be present");
assert.ok(registry.legacyRoutes.length >= 14, "legacy routes should document current Slack routes and handlers");
for (const route of registry.legacyRoutes) {
  assert.equal(typeof route.name, "string");
  assert.ok(route.name.length > 0);
  assert.ok(Array.isArray(route.triggers), `${route.name} should document triggers`);
  assert.ok(route.triggers.length > 0, `${route.name} should have at least one trigger`);
  assert.equal(typeof route.status, "string");
  assert.equal(typeof route.notes, "string");
  assert.ok(route.notes.length > 0, `${route.name} should have notes`);
}

const legacyRouteNames = new Set(registry.legacyRoutes.map((route) => route.name));
for (const expected of [
  "help",
  "status",
  "summarize",
  "linear",
  "agenda",
  "escalation",
  "spec",
  "digest",
  "image",
  "agent",
  "agent_run_start",
  "agent_run_cancel",
  "app_mention",
  "direct_message",
]) {
  assert.ok(legacyRouteNames.has(expected), `legacy route ${expected} should be documented`);
}

assert.throws(
  () => validateRegistry({
    version: 1,
    actions: [
      { key: "duplicate", status: "planned" },
      { key: "duplicate", status: "planned" },
    ],
  }),
  /duplicate action key 'duplicate'/,
);

assert.throws(
  () => validateRegistry({ version: 1, actions: [{ key: "bad", status: "planned", artifacts: "summary" }] }),
  /actions\[0\]\.artifacts must be an array when present/,
);

assert.throws(
  () => validateRegistry({ version: 1, actions: [{ key: "bad", status: "planned", riskLevel: "" }] }),
  /actions\[0\]\.riskLevel must be a non-empty string/,
);
