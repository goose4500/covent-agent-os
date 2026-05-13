import assert from "node:assert/strict";
import {
  DEFAULT_ACTION_METADATA,
  findEventRoute,
  getEventRoutes,
  loadActionMetadata,
  loadRegistry,
  validateRegistry,
} from "./lib/control-plane/registry-loader.mjs";

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
assert.ok(registry.legacyRoutes.length >= 8, "legacy routes should document current Slack routes and handlers (agent/image/digest/escalation removed)");
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
  "spec",
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

// --- Event-triggered routes (issue #48) ------------------------------------
//
// New optional shape: top-level `eventRoutes:` array whose entries carry a
// `trigger:` block, a `destination:` block, and the same per-route knobs
// (tools / systemPromptSuffix / approvals) the Slack-only `routes:` map uses.
// The Slack-only `routes:` map must keep validating exactly as today —
// covered by `loadRegistry()` above already loading without throwing.

// Regression guard: a registry without `eventRoutes:` still validates.
assert.doesNotThrow(
  () => validateRegistry({ version: 1, actions: [], routes: { plain: { tools: [], approvals: "none" } } }),
  "registry without eventRoutes still validates",
);
assert.deepEqual(
  getEventRoutes({ version: 1, actions: [], routes: { plain: {} } }),
  [],
  "getEventRoutes returns [] when eventRoutes is absent",
);

// A valid event route validates and is surfaced by getEventRoutes.
{
  const r = validateRegistry({
    version: 1,
    actions: [],
    eventRoutes: [
      {
        name: "demo-route",
        trigger: { source: "linear", when: ["Comment.create"], idempotency: "webhookDelivery" },
        destination: { resolver: "fallback_channel", fallback_channel: "C123" },
        tools: ["linear_graphql"],
        systemPromptSuffix: "demo",
        approvals: "tool",
      },
    ],
  });
  const event = getEventRoutes(r);
  assert.equal(event.length, 1);
  assert.equal(event[0].name, "demo-route");
  assert.equal(event[0].trigger.source, "linear");
  assert.deepEqual(event[0].trigger.when, ["Comment.create"]);
  assert.equal(findEventRoute(r, "demo-route")?.name, "demo-route");
  assert.equal(findEventRoute(r, "missing"), undefined);
}

// trigger present but destination missing → fails validation.
assert.throws(
  () =>
    validateRegistry({
      version: 1,
      actions: [],
      eventRoutes: [
        {
          name: "no-dest",
          trigger: { source: "linear", when: ["Comment.create"] },
        },
      ],
    }),
  /eventRoutes\[0\]\.destination must be an object/,
);

// trigger.source missing → fails validation.
assert.throws(
  () =>
    validateRegistry({
      version: 1,
      actions: [],
      eventRoutes: [
        {
          name: "no-source",
          trigger: { when: ["Comment.create"] },
          destination: { resolver: "fallback_channel", fallback_channel: "C1" },
        },
      ],
    }),
  /eventRoutes\[0\]\.trigger\.source must be a non-empty string/,
);

// trigger.when missing → fails validation.
assert.throws(
  () =>
    validateRegistry({
      version: 1,
      actions: [],
      eventRoutes: [
        {
          name: "no-when",
          trigger: { source: "linear" },
          destination: { resolver: "fallback_channel", fallback_channel: "C1" },
        },
      ],
    }),
  /eventRoutes\[0\]\.trigger\.when must be a non-empty array/,
);

// trigger.when present but empty array → fails validation.
assert.throws(
  () =>
    validateRegistry({
      version: 1,
      actions: [],
      eventRoutes: [
        {
          name: "empty-when",
          trigger: { source: "linear", when: [] },
          destination: { resolver: "fallback_channel", fallback_channel: "C1" },
        },
      ],
    }),
  /eventRoutes\[0\]\.trigger\.when must be a non-empty array/,
);

// Unknown source → fails (allow-list keeps "add a source" deliberate).
assert.throws(
  () =>
    validateRegistry({
      version: 1,
      actions: [],
      eventRoutes: [
        {
          name: "bad-source",
          trigger: { source: "stripe", when: ["Charge.created"] },
          destination: { resolver: "fallback_channel", fallback_channel: "C1" },
        },
      ],
    }),
  /eventRoutes\[0\]\.trigger\.source must be one of/,
);

// Unknown destination resolver → fails (mirrors destination-resolver.mjs strategies).
assert.throws(
  () =>
    validateRegistry({
      version: 1,
      actions: [],
      eventRoutes: [
        {
          name: "bad-resolver",
          trigger: { source: "linear", when: ["Comment.create"] },
          destination: { resolver: "magic" },
        },
      ],
    }),
  /eventRoutes\[0\]\.destination\.resolver must be one of/,
);

// Duplicate event route name → fails.
assert.throws(
  () =>
    validateRegistry({
      version: 1,
      actions: [],
      eventRoutes: [
        {
          name: "dupe",
          trigger: { source: "linear", when: ["Comment.create"] },
          destination: { resolver: "fallback_channel", fallback_channel: "C1" },
        },
        {
          name: "dupe",
          trigger: { source: "linear", when: ["Comment.create"] },
          destination: { resolver: "fallback_channel", fallback_channel: "C1" },
        },
      ],
    }),
  /duplicate event route name 'dupe'/,
);

// The real registry exposes linear-comment-sync via getEventRoutes.
{
  const eventRoutes = getEventRoutes(registry);
  assert.ok(Array.isArray(eventRoutes) && eventRoutes.length >= 1, "registry has event routes");
  const linearSync = findEventRoute(registry, "linear-comment-sync");
  assert.ok(linearSync, "linear-comment-sync route should exist");
  assert.equal(linearSync.trigger.source, "linear");
  assert.deepEqual(linearSync.trigger.when, ["Comment.create"]);
  assert.equal(linearSync.trigger.idempotency, "webhookDelivery");
  assert.equal(linearSync.destination.resolver, "linear_attachment_thread");
  assert.equal(typeof linearSync.destination.fallback_channel, "string");
  assert.ok(Array.isArray(linearSync.tools));
  assert.ok(linearSync.tools.includes("linear_graphql"));
  assert.ok(linearSync.tools.includes("slack_api"));
  assert.equal(typeof linearSync.systemPromptSuffix, "string");
  assert.ok(linearSync.systemPromptSuffix.length > 0);
}
