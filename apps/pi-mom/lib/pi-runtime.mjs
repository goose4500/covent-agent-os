// Pi SDK runtime shim for the Slack bridge.
//
// Owns the shared singletons (`authStorage`, `modelRegistry`, `resourceLoader`)
// built once at process boot, and exposes `createSlackSession({ threadTs, ... })`
// which is the only entry point the Slack handlers should use.
//
// The runtime is feature-flagged behind PI_MOM_USE_SDK; index.mjs falls back
// to the subprocess `runPi()` when the flag is off, so this module is allowed
// to throw at import time when the package is not installed.
//
// API surface assumed (per pi.dev/docs/latest/sdk):
//   - AuthStorage.create()
//   - ModelRegistry.create(authStorage)
//   - DefaultResourceLoader({ additionalExtensionPaths, skillPaths, agentPaths, promptPaths })
//   - SessionManager.create(cwd) | .open(path) | .inMemory()
//   - createAgentSession({ sessionManager, authStorage, modelRegistry, resourceLoader })
//   - session.bindExtensions({ uiContext })
//   - session.prompt(text), .followUp(text), .subscribe(listener), .abort(), .dispose()

import { resolve } from "node:path";

import {
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

import { slackUI } from "./slack-ui-context.mjs";

const REPO_ROOT = resolve(process.cwd(), "..", "..");

const EXTENSION_PATHS = [
  "./extensions/browser-use-tools.ts",
  "./extensions/env-guard.ts",
  "./extensions/git-checkpoint.ts",
  "./extensions/linear-mcp-guard.ts",
  "./extensions/openai-image-tools.ts",
  "./extensions/permission-gate.ts",
  "./extensions/slack-mcp-guard.ts",
  "./extensions/action-router.ts",
  "./packages/pi-ext-covent-aws/src/index.ts",
].map((p) => resolve(REPO_ROOT, p));

const SKILL_PATHS = [resolve(REPO_ROOT, "./skills")];
const AGENT_PATHS = [resolve(REPO_ROOT, "./.pi/agents")];
const PROMPT_PATHS = [resolve(REPO_ROOT, "./prompts")];

let cachedRuntime;

export function getSharedRuntime() {
  if (cachedRuntime) return cachedRuntime;

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resourceLoader = new DefaultResourceLoader({
    additionalExtensionPaths: EXTENSION_PATHS,
    skillPaths: SKILL_PATHS,
    agentPaths: AGENT_PATHS,
    promptPaths: PROMPT_PATHS,
  });

  cachedRuntime = { authStorage, modelRegistry, resourceLoader, repoRoot: REPO_ROOT };
  return cachedRuntime;
}

// pendingApprovals is module-scope so it survives session replacement (per PR #17 §3.4).
// Keys are Slack action_ids assigned by slack-ui-context; values are resolveFns.
const pendingApprovals = new Map();

export function getPendingApprovals() {
  return pendingApprovals;
}

export async function createSlackSession({ threadTs, channel, client, sessionFilePath }) {
  if (!threadTs) throw new Error("createSlackSession: threadTs is required");
  if (!channel) throw new Error("createSlackSession: channel is required");
  if (!client) throw new Error("createSlackSession: client is required");

  const { authStorage, modelRegistry, resourceLoader, repoRoot } = getSharedRuntime();

  const sessionManager = sessionFilePath
    ? SessionManager.open(sessionFilePath)
    : SessionManager.create(repoRoot);

  const { session } = await createAgentSession({
    sessionManager,
    authStorage,
    modelRegistry,
    resourceLoader,
  });

  session.bindExtensions({
    uiContext: slackUI({ client, channel, threadTs, pendingApprovals }),
  });

  return { session, sessionManager };
}
