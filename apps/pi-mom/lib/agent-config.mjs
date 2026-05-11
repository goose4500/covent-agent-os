import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_AGENT_CONFIG_PATH = join(__dirname, "..", "agent.yaml");

const VALID_APPROVALS = new Set(["none", "explicit-intent", "button-confirm", "double-confirm"]);
const VALID_WRITE_TARGETS = new Set(["linear", "github", "slack"]);
const VALID_IDEMPOTENCY = new Set(["none", "scan-thread-for-prior-success", "external-hash"]);
const ACTION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]+$/;

function fail(message) {
  throw new Error(`agent.yaml validation failed: ${message}`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path} must be a non-empty string`);
  }
}

function requireOptionalString(value, path) {
  if (value === undefined) return;
  requireString(value, path);
}

function requireStringArray(value, path, { allowEmpty = true } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${path} must be an array when present`);
  if (!allowEmpty && value.length === 0) fail(`${path} must not be empty`);
  for (const [index, item] of value.entries()) {
    requireString(item, `${path}[${index}]`);
  }
  return value;
}

function requireEnum(value, allowed, path) {
  if (value === undefined) return;
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(`${path} must be one of ${[...allowed].join(", ")} (got ${JSON.stringify(value)})`);
  }
}

function requireInteger(value, path, { min, max } = {}) {
  if (value === undefined) return;
  if (!Number.isInteger(value)) fail(`${path} must be an integer`);
  if (min !== undefined && value < min) fail(`${path} must be >= ${min}`);
  if (max !== undefined && value > max) fail(`${path} must be <= ${max}`);
}

function validateProfile(name, profile) {
  if (!isObject(profile)) fail(`profiles.${name} must be an object`);
  requireString(profile.description, `profiles.${name}.description`);
  requireStringArray(profile.skills, `profiles.${name}.skills`);
  requireStringArray(profile.extensions, `profiles.${name}.extensions`);
  requireStringArray(profile.tools, `profiles.${name}.tools`);
  requireStringArray(profile.writeTargets, `profiles.${name}.writeTargets`);
  for (const [i, target] of (profile.writeTargets ?? []).entries()) {
    if (!VALID_WRITE_TARGETS.has(target)) {
      fail(`profiles.${name}.writeTargets[${i}] must be one of ${[...VALID_WRITE_TARGETS].join(", ")}`);
    }
  }
  requireEnum(profile.approval, VALID_APPROVALS, `profiles.${name}.approval`);
}

function validateTriggers(action, basePath) {
  const triggers = action.triggers;
  if (!isObject(triggers)) fail(`${basePath}.triggers must be an object`);
  const intents = requireStringArray(triggers.mentionIntents, `${basePath}.triggers.mentionIntents`);
  const patterns = requireStringArray(triggers.mentionPatterns, `${basePath}.triggers.mentionPatterns`);
  for (const [i, source] of patterns.entries()) {
    try {
      new RegExp(source, "i");
    } catch (error) {
      fail(`${basePath}.triggers.mentionPatterns[${i}] is not a valid regex: ${error.message}`);
    }
  }
  const prefixes = requireStringArray(triggers.prefixes, `${basePath}.triggers.prefixes`);
  if (intents.length === 0 && patterns.length === 0 && prefixes.length === 0) {
    fail(`${basePath}.triggers must declare mentionIntents, mentionPatterns, or prefixes`);
  }
}

function validateTarget(target, basePath) {
  if (target === undefined) return;
  if (!isObject(target)) fail(`${basePath} must be an object`);
  if (target.linear !== undefined) {
    if (!isObject(target.linear)) fail(`${basePath}.linear must be an object`);
    requireString(target.linear.teamIdEnv, `${basePath}.linear.teamIdEnv`);
    requireString(target.linear.projectIdEnv, `${basePath}.linear.projectIdEnv`);
    requireString(target.linear.stateIdEnv, `${basePath}.linear.stateIdEnv`);
  }
}

function validateAction(action, index, profileNames) {
  if (!isObject(action)) fail(`actions[${index}] must be an object`);
  requireString(action.key, `actions[${index}].key`);
  if (!ACTION_KEY_PATTERN.test(action.key)) {
    fail(`actions[${index}].key must match ${ACTION_KEY_PATTERN}`);
  }
  requireString(action.name, `actions[${index}].name`);
  requireString(action.description, `actions[${index}].description`);
  requireString(action.profile, `actions[${index}].profile`);
  if (!profileNames.has(action.profile)) {
    fail(`actions[${index}].profile '${action.profile}' is not defined under profiles`);
  }
  requireString(action.handler, `actions[${index}].handler`);
  validateTriggers(action, `actions[${index}]`);
  validateTarget(action.target, `actions[${index}].target`);
  requireEnum(action.idempotency, VALID_IDEMPOTENCY, `actions[${index}].idempotency`);
  requireInteger(action.timeoutMs, `actions[${index}].timeoutMs`, { min: 1000, max: 600000 });
}

function validateChannel(channel, index, profileNames) {
  if (!isObject(channel)) fail(`channels[${index}] must be an object`);
  const hasId = channel.id !== undefined;
  const hasIdEnv = channel.idEnv !== undefined;
  if (hasId === hasIdEnv) {
    fail(`channels[${index}] must declare exactly one of id or idEnv`);
  }
  if (hasId) {
    requireString(channel.id, `channels[${index}].id`);
    if (!CHANNEL_ID_PATTERN.test(channel.id)) {
      fail(`channels[${index}].id must look like a Slack channel ID (got ${JSON.stringify(channel.id)})`);
    }
  }
  if (hasIdEnv) requireString(channel.idEnv, `channels[${index}].idEnv`);
  requireOptionalString(channel.name, `channels[${index}].name`);
  requireOptionalString(channel.nameEnv, `channels[${index}].nameEnv`);
  requireString(channel.profile, `channels[${index}].profile`);
  if (!profileNames.has(channel.profile)) {
    fail(`channels[${index}].profile '${channel.profile}' is not defined under profiles`);
  }
}

function validateRuntime(runtime) {
  if (runtime === undefined) return;
  if (!isObject(runtime)) fail(`runtime must be an object`);
  if (runtime.pi !== undefined) {
    if (!isObject(runtime.pi)) fail(`runtime.pi must be an object`);
    requireOptionalString(runtime.pi.command, `runtime.pi.command`);
    requireOptionalString(runtime.pi.extraArgsEnv, `runtime.pi.extraArgsEnv`);
    requireInteger(runtime.pi.timeoutMs, `runtime.pi.timeoutMs`, { min: 1000 });
    requireInteger(runtime.pi.outputIdleMs, `runtime.pi.outputIdleMs`, { min: 100 });
    if (runtime.pi.streaming !== undefined && typeof runtime.pi.streaming !== "boolean") {
      fail(`runtime.pi.streaming must be a boolean when present`);
    }
  }
  if (runtime.slack !== undefined) {
    if (!isObject(runtime.slack)) fail(`runtime.slack must be an object`);
    requireInteger(runtime.slack.maxTextChars, `runtime.slack.maxTextChars`, { min: 1000, max: 40000 });
    requireInteger(runtime.slack.streamAppendChars, `runtime.slack.streamAppendChars`, { min: 100 });
  }
}

export function validateAgentConfig(raw) {
  if (!isObject(raw)) fail(`top-level value must be an object`);
  if (raw.version !== 1) fail(`version must equal 1`);

  if (!isObject(raw.profiles) || Object.keys(raw.profiles).length === 0) {
    fail(`profiles must be an object with at least one profile`);
  }
  const profileNames = new Set(Object.keys(raw.profiles));
  for (const name of profileNames) {
    validateProfile(name, raw.profiles[name]);
  }

  if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
    fail(`actions must be a non-empty array`);
  }
  const actionKeys = new Set();
  for (const [index, action] of raw.actions.entries()) {
    validateAction(action, index, profileNames);
    if (actionKeys.has(action.key)) fail(`duplicate action key '${action.key}'`);
    actionKeys.add(action.key);
  }

  if (raw.channels !== undefined) {
    if (!Array.isArray(raw.channels)) fail(`channels must be an array when present`);
    for (const [index, channel] of raw.channels.entries()) {
      validateChannel(channel, index, profileNames);
    }
  }

  validateRuntime(raw.runtime);

  return raw;
}

export function parseAgentYaml(yamlText) {
  return validateAgentConfig(parse(yamlText));
}

export function loadAgentConfig(configPath = DEFAULT_AGENT_CONFIG_PATH) {
  return parseAgentYaml(readFileSync(configPath, "utf8"));
}

export function resolveChannelId(channel, env = process.env) {
  if (channel.id) return channel.id;
  if (channel.idEnv) {
    const value = env[channel.idEnv];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  }
  return undefined;
}

export function resolveLinearTarget(action, env = process.env) {
  const linear = action?.target?.linear;
  if (!linear) return undefined;
  return {
    teamId: env[linear.teamIdEnv],
    projectId: env[linear.projectIdEnv],
    stateId: env[linear.stateIdEnv],
  };
}

export function findAction(config, key) {
  return config?.actions?.find((action) => action.key === key);
}

export function findProfile(config, name) {
  return config?.profiles?.[name];
}

export function matchActionByText(
  config,
  text = "",
  { includePrefixes = true, includeIntents = true } = {},
) {
  const value = String(text || "").trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  for (const action of config?.actions ?? []) {
    if (includePrefixes) {
      const prefixes = action.triggers?.prefixes ?? [];
      if (prefixes.some((prefix) => lower.startsWith(String(prefix).toLowerCase()))) {
        return action;
      }
    }
    if (includeIntents) {
      const intents = action.triggers?.mentionIntents ?? [];
      if (intents.some((intent) => lower.includes(String(intent).toLowerCase()))) {
        return action;
      }
      const patterns = action.triggers?.mentionPatterns ?? [];
      for (const source of patterns) {
        try {
          if (new RegExp(source, "i").test(value)) return action;
        } catch {
          // Loader already validated patterns at boot; swallow to be safe at runtime.
        }
      }
    }
  }
  return undefined;
}

export function stripMatchedTrigger(text = "", action) {
  const original = String(text || "");
  if (!action) return original.trim();
  const lower = original.toLowerCase();

  for (const prefix of action.triggers?.prefixes ?? []) {
    if (lower.startsWith(String(prefix).toLowerCase())) {
      return original.slice(prefix.length).replace(/^[\s:;,.\-–—]+/, "").trim();
    }
  }
  for (const intent of action.triggers?.mentionIntents ?? []) {
    const idx = lower.indexOf(String(intent).toLowerCase());
    if (idx !== -1) {
      return `${original.slice(0, idx)}${original.slice(idx + intent.length)}`
        .replace(/^[\s:;,.\-–—]+/, "")
        .trim();
    }
  }
  for (const source of action.triggers?.mentionPatterns ?? []) {
    try {
      const regex = new RegExp(source, "i");
      const match = regex.exec(original);
      if (match) {
        return `${original.slice(0, match.index)}${original.slice(match.index + match[0].length)}`
          .replace(/^[\s:;,.\-–—]+/, "")
          .trim();
      }
    } catch {
      // ignore
    }
  }
  return original.trim();
}
