// Small reader helper around control-plane/registry.yaml.
//
// The Slack dispatcher (apps/pi-mom/index.mjs) uses this to translate an
// inbound Action name into the metadata the action-router extension expects:
// tools allow-list, system prompt suffix, canvas flag, etc.
//
// The companion `lib/control-plane/registry-loader.mjs` enforces the full
// schema (versions, required fields for active actions, legacy routes). That
// loader is reused here so we benefit from the same validation rules.
import { DEFAULT_REGISTRY_PATH, loadRegistry } from "./control-plane/registry-loader.mjs";

let cached = null;
let cachedPath = null;

function readEntry(action) {
  if (!action || typeof action !== "object") return null;
  return {
    key: action.key,
    name: typeof action.name === "string" ? action.name : action.key,
    status: action.status ?? "planned",
    riskLevel: action.riskLevel ?? null,
    tools: Array.isArray(action.tools) ? [...action.tools] : [],
    systemPromptSuffix: typeof action.systemPromptSuffix === "string" ? action.systemPromptSuffix : "",
    canvas: action.canvas === true,
  };
}

export function loadActionMetadata({ path = DEFAULT_REGISTRY_PATH, fresh = false } = {}) {
  if (!fresh && cached && cachedPath === path) return cached;
  const registry = loadRegistry(path);
  cached = registry;
  cachedPath = path;
  return registry;
}

export function listActiveActions({ path = DEFAULT_REGISTRY_PATH, fresh = false } = {}) {
  const registry = loadActionMetadata({ path, fresh });
  return (registry.actions ?? [])
    .filter((action) => action?.status === "active" && typeof action.key === "string")
    .map((action) => action.key);
}

export function resolveAction(name, { path = DEFAULT_REGISTRY_PATH, fresh = false } = {}) {
  if (typeof name !== "string" || name === "") return null;
  const registry = loadActionMetadata({ path, fresh });
  const action = (registry.actions ?? []).find((entry) => entry?.key === name);
  if (!action) return null;
  return readEntry(action);
}

// Test/utility hook — drop the in-process cache.
export function clearActionResolverCache() {
  cached = null;
  cachedPath = null;
}
