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

// The previous `legacyRoutes:` block has been folded into `actions:` entries
// as of PR 2 of the pi-mom SDK migration. The remaining Slack prompt routes
// live in the registry as first-class active Actions; `summarize` and `image`
// were retired.
const actionKeys = new Set(registry.actions.map((action) => action.key));
for (const expected of [
  "linear",
  "agenda",
  "escalation",
  "spec",
  "digest",
  "agent",
]) {
  assert.ok(actionKeys.has(expected), `migrated action ${expected} should be registered`);
  const action = registry.actions.find((entry) => entry.key === expected);
  assert.equal(action.status, "active", `${expected} should be active`);
  assert.equal(typeof action.systemPromptSuffix, "string", `${expected} must define systemPromptSuffix`);
  assert.ok(action.systemPromptSuffix.length > 0, `${expected} must have a non-empty systemPromptSuffix`);
}

// Guard against accidental re-introduction of the deleted actions.
for (const removed of ["summarize", "image"]) {
  assert.ok(!actionKeys.has(removed), `${removed} action was deleted and must not be registered`);
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
