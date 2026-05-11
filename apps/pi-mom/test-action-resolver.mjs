import assert from "node:assert/strict";
import {
  clearActionResolverCache,
  listActiveActions,
  loadActionMetadata,
  resolveAction,
} from "./lib/action-resolver.mjs";

clearActionResolverCache();

// resolveAction returns a populated record for a migrated route.
const summary = resolveAction("summarize");
assert.ok(summary, "resolveAction('summarize') should return an entry");
assert.equal(summary.key, "summarize");
assert.equal(summary.status, "active");
assert.equal(typeof summary.systemPromptSuffix, "string");
assert.ok(summary.systemPromptSuffix.length > 0, "summarize must have a non-empty systemPromptSuffix");
assert.ok(Array.isArray(summary.tools), "tools must be an array");
assert.equal(summary.canvas, true, "summarize should render to a Slack canvas");

// Unknown actions resolve to null.
assert.equal(resolveAction("unknown"), null);
assert.equal(resolveAction(""), null);
assert.equal(resolveAction(undefined), null);

// listActiveActions covers all 8 migrated routes plus the original active actions.
const active = listActiveActions();
const expectedActive = [
  "summarize",
  "linear",
  "agenda",
  "escalation",
  "spec",
  "digest",
  "image",
  "agent",
  "run-action",
];
for (const key of expectedActive) {
  assert.ok(active.includes(key), `listActiveActions should include '${key}'`);
}

// Per-Action sanity: image must expose the GPT image tools.
const image = resolveAction("image");
assert.ok(image, "image action should resolve");
assert.equal(image.riskLevel, "creative");
assert.ok(image.tools.includes("gpt_image_generate"));

// Per-Action sanity: linear is allowed to call Linear MCP tools.
const linear = resolveAction("linear");
assert.ok(linear.tools.includes("linear_*"), "linear should permit linear_* MCP tools");

// loadActionMetadata caches by default; fresh: true reloads.
const first = loadActionMetadata();
const second = loadActionMetadata();
assert.equal(first, second, "loadActionMetadata should cache by default");
const reloaded = loadActionMetadata({ fresh: true });
assert.notEqual(first, reloaded, "fresh: true must reload");

console.log("test-action-resolver.mjs OK");
