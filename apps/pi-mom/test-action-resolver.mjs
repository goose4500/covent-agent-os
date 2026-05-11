import assert from "node:assert/strict";
import {
  clearActionResolverCache,
  listActiveActions,
  loadActionMetadata,
  resolveAction,
} from "./lib/action-resolver.mjs";

clearActionResolverCache();

// resolveAction returns a populated record for a migrated route.
const linear = resolveAction("linear");
assert.ok(linear, "resolveAction('linear') should return an entry");
assert.equal(linear.key, "linear");
assert.equal(linear.status, "active");
assert.equal(typeof linear.systemPromptSuffix, "string");
assert.ok(linear.systemPromptSuffix.length > 0, "linear must have a non-empty systemPromptSuffix");
assert.ok(Array.isArray(linear.tools), "tools must be an array");

// Unknown actions resolve to null.
assert.equal(resolveAction("unknown"), null);
assert.equal(resolveAction(""), null);
assert.equal(resolveAction(undefined), null);

// listActiveActions covers the migrated routes plus the original active actions.
const active = listActiveActions();
const expectedActive = [
  "linear",
  "agenda",
  "escalation",
  "spec",
  "digest",
  "agent",
  "run-action",
];
for (const key of expectedActive) {
  assert.ok(active.includes(key), `listActiveActions should include '${key}'`);
}

// Removed actions must NOT resolve. Guard against accidental re-introduction.
for (const removed of ["summarize", "image"]) {
  assert.equal(resolveAction(removed), null, `${removed} action was deleted and must not resolve`);
  assert.ok(!active.includes(removed), `listActiveActions must not include '${removed}'`);
}

// Per-Action sanity: linear is allowed to call Linear MCP tools.
assert.ok(linear.tools.includes("linear_*"), "linear should permit linear_* MCP tools");

// loadActionMetadata caches by default; fresh: true reloads.
const first = loadActionMetadata();
const second = loadActionMetadata();
assert.equal(first, second, "loadActionMetadata should cache by default");
const reloaded = loadActionMetadata({ fresh: true });
assert.notEqual(first, reloaded, "fresh: true must reload");

console.log("test-action-resolver.mjs OK");
