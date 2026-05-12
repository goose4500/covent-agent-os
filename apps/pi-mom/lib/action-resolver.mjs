// Per-Action tool gating resolver. Reads the `routes` block from
// `control-plane/registry.yaml` and resolves a parsed Slack command into an
// Action shape with the explicit tool allowlist, system-prompt suffix, and
// approval posture that the SDK runner uses to call
// `setActiveToolsByName`.
//
// Public surface:
//   resolveAction(command) → { name, tools, systemPromptSuffix, approvals }
//
// The factory `createResolver` is DI-friendly so tests can inject a fake
// registry without reading the YAML from disk.
//
// Resolution rules (in order):
//   1. `kind === "route"`        → routes[command.routeKey]
//   2. `kind === "help"`         → routes.help
//   3. `kind === "status"`       → routes.status
//   4. `kind === "plain"` or anything else → routes.plain
//   5. Missing route entry       → fall back to defaultTools + defaultSystemPromptSuffix
//
// The fallback is intentionally conservative: an empty tools array
// (= same posture as the legacy noTools:"all" flag) and no extra system
// prompt suffix. Routes that need wider tool access must declare it
// explicitly in registry.yaml.

import { loadRegistry } from "./control-plane/registry-loader.mjs";

const DEFAULT_ROUTE_NAME = "plain";

function safeLoadRegistry() {
  try {
    return loadRegistry();
  } catch (error) {
    // The resolver is on the hot path for every Slack message; a bad YAML
    // must not crash the bridge. Fall back to an empty registry — every
    // route then resolves to the conservative default.
    console.warn(
      `[action-resolver] registry load failed; using default route posture. ${error?.message || error}`,
    );
    return { version: 1, actions: [], routes: {} };
  }
}

export function createResolver({
  registry,
  defaultTools = [],
  defaultSystemPromptSuffix = "",
  defaultApprovals = "none",
} = {}) {
  const resolved = registry || safeLoadRegistry();
  const routes = (resolved && resolved.routes) || {};

  function lookupRouteKey(command) {
    if (!command || typeof command !== "object") return DEFAULT_ROUTE_NAME;
    const kind = command.kind;
    if (kind === "route" && command.routeKey) return command.routeKey;
    if (kind === "help") return "help";
    if (kind === "status") return "status";
    return DEFAULT_ROUTE_NAME;
  }

  function resolveAction(command = {}) {
    const routeKey = lookupRouteKey(command);
    const entry = routes[routeKey] || routes[DEFAULT_ROUTE_NAME] || {};
    const tools = Array.isArray(entry.tools) ? [...entry.tools] : [...defaultTools];
    const systemPromptSuffix =
      typeof entry.systemPromptSuffix === "string"
        ? entry.systemPromptSuffix
        : defaultSystemPromptSuffix;
    const approvals =
      typeof entry.approvals === "string" && entry.approvals
        ? entry.approvals
        : defaultApprovals;
    return {
      name: routeKey,
      tools,
      systemPromptSuffix,
      approvals,
    };
  }

  return { resolveAction };
}

const _defaultResolver = createResolver();
export const resolveAction = _defaultResolver.resolveAction;
