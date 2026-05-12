import assert from "node:assert/strict";
import { createResolver, resolveAction as realResolveAction } from "./lib/action-resolver.mjs";

const fixtureRegistry = {
  version: 1,
  actions: [],
  routes: {
    plain: { tools: [], systemPromptSuffix: "", approvals: "none" },
    help: { tools: [], systemPromptSuffix: "", approvals: "none" },
    status: { tools: [], systemPromptSuffix: "", approvals: "none" },
    summarize: {
      tools: [],
      systemPromptSuffix: "Summarize the thread.",
      approvals: "none",
    },
    linear: {
      tools: ["read"],
      systemPromptSuffix: "Create a Linear-ready issue spec.",
      approvals: "none",
    },
    spec: {
      tools: [],
      systemPromptSuffix: "Convert idea into a spec draft.",
      approvals: "none",
    },
    agent: {
      tools: [],
      systemPromptSuffix: "Show a confirmation card.",
      approvals: "modal",
    },
  },
};

// Case 1: kind=route + routeKey → returns that route's tools + suffix + approvals.
{
  const { resolveAction } = createResolver({ registry: fixtureRegistry });
  const action = resolveAction({ kind: "route", routeKey: "summarize" });
  assert.equal(action.name, "summarize", "route name matches routeKey");
  assert.deepEqual(action.tools, [], "summarize is tool-less");
  assert.equal(action.systemPromptSuffix, "Summarize the thread.", "suffix from registry");
  assert.equal(action.approvals, "none", "approvals from registry");
}

// Case 2: linear route has a non-empty tools array, which the SDK runner will narrow with setActiveToolsByName.
{
  const { resolveAction } = createResolver({ registry: fixtureRegistry });
  const action = resolveAction({ kind: "route", routeKey: "linear" });
  assert.equal(action.name, "linear");
  assert.deepEqual(action.tools, ["read"], "linear has a single allowed tool");
  assert.ok(action.systemPromptSuffix.includes("Linear"), "linear suffix mentions Linear");
}

// Case 3: kind=plain → resolves to the `plain` fallback entry.
{
  const { resolveAction } = createResolver({ registry: fixtureRegistry });
  const action = resolveAction({ kind: "plain", text: "what's up" });
  assert.equal(action.name, "plain", "plain → plain route");
  assert.deepEqual(action.tools, [], "plain route ships no tools by default");
  assert.equal(action.systemPromptSuffix, "");
  assert.equal(action.approvals, "none");
}

// Case 4: kind=help and kind=status resolve to their own entries (not plain).
{
  const { resolveAction } = createResolver({ registry: fixtureRegistry });
  assert.equal(resolveAction({ kind: "help" }).name, "help");
  assert.equal(resolveAction({ kind: "status" }).name, "status");
}

// Case 5: agent route's approvals === "modal" — modal gate is a Stage 6 hook but the field must flow through today.
{
  const { resolveAction } = createResolver({ registry: fixtureRegistry });
  const action = resolveAction({ kind: "route", routeKey: "agent" });
  assert.equal(action.approvals, "modal", "agent route requires a modal approval");
}

// Case 6: unknown routeKey → fall back to the plain entry (defensive: a fresh prefix added to
// parseCommand but not yet registered in registry.yaml must not crash the bot).
{
  const { resolveAction } = createResolver({ registry: fixtureRegistry });
  const action = resolveAction({ kind: "route", routeKey: "totally-new-prefix" });
  assert.equal(action.name, "totally-new-prefix", "name reflects the requested key");
  assert.deepEqual(action.tools, [], "falls back to plain tools posture");
  assert.equal(action.systemPromptSuffix, "");
  assert.equal(action.approvals, "none");
}

// Case 7: malformed input (undefined, null, weird kind) → still produces a safe default Action.
{
  const { resolveAction } = createResolver({ registry: fixtureRegistry });
  for (const input of [undefined, null, {}, { kind: "weird" }, { kind: "route" }]) {
    const action = resolveAction(input);
    assert.ok(action.name, "name always set");
    assert.ok(Array.isArray(action.tools), "tools is always an array");
    assert.equal(typeof action.systemPromptSuffix, "string", "suffix is always a string");
    assert.equal(typeof action.approvals, "string", "approvals is always a string");
  }
}

// Case 8: missing routes block in registry → fall back to constructor defaults.
{
  const { resolveAction } = createResolver({
    registry: { version: 1, actions: [], routes: {} },
    defaultTools: ["read"],
    defaultSystemPromptSuffix: "be helpful",
    defaultApprovals: "modal",
  });
  const action = resolveAction({ kind: "plain", text: "hi" });
  assert.deepEqual(action.tools, ["read"], "uses defaultTools");
  assert.equal(action.systemPromptSuffix, "be helpful");
  assert.equal(action.approvals, "modal");
  // Mutating the returned tools array must not pollute future resolutions.
  action.tools.push("bash");
  const next = resolveAction({ kind: "plain", text: "again" });
  assert.deepEqual(next.tools, ["read"], "tools array is defensively copied");
}

// Case 9: the default exported `resolveAction` reads the real registry on disk
// and produces a sensible shape for the canonical `linear` route.
{
  const action = realResolveAction({ kind: "route", routeKey: "linear" });
  assert.equal(action.name, "linear");
  assert.ok(Array.isArray(action.tools), "default resolver returns tools array");
  assert.equal(typeof action.systemPromptSuffix, "string");
  assert.ok(action.systemPromptSuffix.length > 0, "linear suffix is non-empty in real registry");
}

console.log("action-resolver tests passed");
