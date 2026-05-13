import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = join(__dirname, "..", "..", "control-plane", "registry.yaml");

// Allow-listed values for event-triggered route fields. Keeping these as Sets
// next to the validator makes "add a new source" a one-line config change for
// Phase 2 (GitHub webhooks) and beyond — no scattered string literals.
const SUPPORTED_TRIGGER_SOURCES = new Set(["linear"]);
const SUPPORTED_TRIGGER_IDEMPOTENCY = new Set(["webhookDelivery"]);
const SUPPORTED_DESTINATION_RESOLVERS = new Set([
  "linear_attachment_thread",
  "static_mapping",
  "fallback_channel",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`registry validation failed: ${path} must be a non-empty string`);
  }
}

function requireStringArrayWhenPresent(value, path) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`registry validation failed: ${path} must be an array when present`);
  }
  for (const [index, item] of value.entries()) {
    requireString(item, `${path}[${index}]`);
  }
}

function validateEventRouteEntry(route, path) {
  if (!isObject(route)) {
    throw new Error(`registry validation failed: ${path} must be an object`);
  }
  requireString(route.name, `${path}.name`);

  // trigger block — required for event-triggered routes (this is what
  // distinguishes them from Slack-only routes).
  if (!isObject(route.trigger)) {
    throw new Error(`registry validation failed: ${path}.trigger must be an object`);
  }
  requireString(route.trigger.source, `${path}.trigger.source`);
  if (!SUPPORTED_TRIGGER_SOURCES.has(route.trigger.source)) {
    throw new Error(
      `registry validation failed: ${path}.trigger.source must be one of [${[...SUPPORTED_TRIGGER_SOURCES].join(", ")}] (got '${route.trigger.source}')`,
    );
  }
  if (!Array.isArray(route.trigger.when) || route.trigger.when.length === 0) {
    throw new Error(
      `registry validation failed: ${path}.trigger.when must be a non-empty array`,
    );
  }
  for (const [index, token] of route.trigger.when.entries()) {
    requireString(token, `${path}.trigger.when[${index}]`);
  }
  if (route.trigger.idempotency !== undefined) {
    requireString(route.trigger.idempotency, `${path}.trigger.idempotency`);
    if (!SUPPORTED_TRIGGER_IDEMPOTENCY.has(route.trigger.idempotency)) {
      throw new Error(
        `registry validation failed: ${path}.trigger.idempotency must be one of [${[...SUPPORTED_TRIGGER_IDEMPOTENCY].join(", ")}] (got '${route.trigger.idempotency}')`,
      );
    }
  }

  // destination block — required when a trigger is present so the receiver
  // knows where to land the resulting synthetic Slack message.
  if (!isObject(route.destination)) {
    throw new Error(`registry validation failed: ${path}.destination must be an object`);
  }
  requireString(route.destination.resolver, `${path}.destination.resolver`);
  if (!SUPPORTED_DESTINATION_RESOLVERS.has(route.destination.resolver)) {
    throw new Error(
      `registry validation failed: ${path}.destination.resolver must be one of [${[...SUPPORTED_DESTINATION_RESOLVERS].join(", ")}] (got '${route.destination.resolver}')`,
    );
  }
  if (route.destination.fallback_channel !== undefined) {
    requireString(route.destination.fallback_channel, `${path}.destination.fallback_channel`);
  }
  if (route.destination.static_map !== undefined && !isObject(route.destination.static_map)) {
    throw new Error(`registry validation failed: ${path}.destination.static_map must be an object when present`);
  }

  // Shared route-shape fields (mirrors the Slack-only `routes:` map).
  if (route.tools !== undefined) {
    if (!Array.isArray(route.tools)) {
      throw new Error(`registry validation failed: ${path}.tools must be an array when present`);
    }
    for (const [index, tool] of route.tools.entries()) {
      requireString(tool, `${path}.tools[${index}]`);
    }
  }
  if (route.systemPromptSuffix !== undefined && typeof route.systemPromptSuffix !== "string") {
    throw new Error(`registry validation failed: ${path}.systemPromptSuffix must be a string when present`);
  }
  if (route.approvals !== undefined) {
    requireString(route.approvals, `${path}.approvals`);
  }
}

export const DEFAULT_ACTION_METADATA = Object.freeze({
  key: "run-action",
  name: "Run Action",
  description: "Confirm and run a bounded agent Action from the control plane.",
  riskLevel: "bounded",
  approvalMode: "Slack confirmation required before start",
  artifacts: ["Slack thread updates", "Optional Slack canvas result"],
  sourceLinks: ["Slack source thread"],
});

export function validateRegistry(registry) {
  if (!isObject(registry)) {
    throw new Error("registry validation failed: top-level value must be an object");
  }
  if (registry.version === undefined || registry.version === null || registry.version === "") {
    throw new Error("registry validation failed: version is required");
  }
  if (!Array.isArray(registry.actions)) {
    throw new Error("registry validation failed: actions must be an array");
  }

  const actionKeys = new Set();
  for (const [index, action] of registry.actions.entries()) {
    if (!isObject(action)) {
      throw new Error(`registry validation failed: actions[${index}] must be an object`);
    }
    requireString(action.key, `actions[${index}].key`);
    if (actionKeys.has(action.key)) {
      throw new Error(`registry validation failed: duplicate action key '${action.key}'`);
    }
    actionKeys.add(action.key);

    requireStringArrayWhenPresent(action.artifacts, `actions[${index}].artifacts`);
    requireStringArrayWhenPresent(action.sourceLinks, `actions[${index}].sourceLinks`);
    if (action.riskLevel !== undefined) {
      requireString(action.riskLevel, `actions[${index}].riskLevel`);
    }
    if (action.approvalMode !== undefined) {
      requireString(action.approvalMode, `actions[${index}].approvalMode`);
    }

    if (action.status === "active") {
      requireString(action.name, `actions[${index}].name`);
      requireString(action.description, `actions[${index}].description`);
      requireString(action.status, `actions[${index}].status`);
      if (!isObject(action.runtime)) {
        throw new Error(`registry validation failed: actions[${index}].runtime must be an object for active actions`);
      }
    }
  }

  if (registry.legacyRoutes !== undefined && !Array.isArray(registry.legacyRoutes)) {
    throw new Error("registry validation failed: legacyRoutes must be an array when present");
  }

  if (registry.routes !== undefined) {
    if (!isObject(registry.routes)) {
      throw new Error("registry validation failed: routes must be an object when present");
    }
    for (const [routeKey, route] of Object.entries(registry.routes)) {
      const path = `routes.${routeKey}`;
      if (!isObject(route)) {
        throw new Error(`registry validation failed: ${path} must be an object`);
      }
      if (route.tools !== undefined) {
        if (!Array.isArray(route.tools)) {
          throw new Error(`registry validation failed: ${path}.tools must be an array when present`);
        }
        for (const [index, tool] of route.tools.entries()) {
          requireString(tool, `${path}.tools[${index}]`);
        }
      }
      if (route.systemPromptSuffix !== undefined && typeof route.systemPromptSuffix !== "string") {
        throw new Error(`registry validation failed: ${path}.systemPromptSuffix must be a string when present`);
      }
      if (route.approvals !== undefined) {
        requireString(route.approvals, `${path}.approvals`);
      }
    }
  }

  // Event-triggered routes (issue #48). Top-level array of route entries that
  // include a `trigger:` block. Slack-only routes still live in the `routes:`
  // map above and are unaffected by this addition.
  if (registry.eventRoutes !== undefined) {
    if (!Array.isArray(registry.eventRoutes)) {
      throw new Error("registry validation failed: eventRoutes must be an array when present");
    }
    const seenNames = new Set();
    for (const [index, route] of registry.eventRoutes.entries()) {
      const path = `eventRoutes[${index}]`;
      validateEventRouteEntry(route, path);
      if (seenNames.has(route.name)) {
        throw new Error(`registry validation failed: duplicate event route name '${route.name}'`);
      }
      seenNames.add(route.name);
    }
  }

  return registry;
}

export function parseRegistryYaml(yamlText) {
  return validateRegistry(parse(yamlText));
}

export function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  return parseRegistryYaml(readFileSync(registryPath, "utf8"));
}

export function findAction(registry, key) {
  return registry?.actions?.find((action) => action.key === key);
}

export function findRoute(registry, routeKey) {
  if (!routeKey) return undefined;
  return registry?.routes?.[routeKey];
}

/**
 * Return the array of event-triggered routes from `registry`. Each returned
 * entry has a `trigger:` block and is intended to be matched against an
 * incoming webhook event by the receiver/integrator (Phase 3).
 *
 * Returns an empty array if `registry.eventRoutes` is missing or empty. The
 * defensive filter on `entry.trigger` is paranoia: validation already
 * guarantees every entry in `eventRoutes` has a trigger, but a future caller
 * passing an unvalidated registry shouldn't get surprised.
 *
 * @param {object} registry
 * @returns {Array<object>}
 */
export function getEventRoutes(registry) {
  const routes = registry?.eventRoutes;
  if (!Array.isArray(routes)) return [];
  return routes.filter((entry) => entry && typeof entry === "object" && entry.trigger);
}

export function findEventRoute(registry, name) {
  if (!name) return undefined;
  return getEventRoutes(registry).find((route) => route.name === name);
}

export function loadActionMetadata(key = "run-action", registryPath = DEFAULT_REGISTRY_PATH) {
  const action = findAction(loadRegistry(registryPath), key);
  if (!action) {
    throw new Error(`registry validation failed: action '${key}' is missing`);
  }
  return action;
}
