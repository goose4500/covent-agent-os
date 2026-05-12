import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = join(__dirname, "..", "..", "control-plane", "registry.yaml");

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

export function loadActionMetadata(key = "run-action", registryPath = DEFAULT_REGISTRY_PATH) {
  const action = findAction(loadRegistry(registryPath), key);
  if (!action) {
    throw new Error(`registry validation failed: action '${key}' is missing`);
  }
  return action;
}
