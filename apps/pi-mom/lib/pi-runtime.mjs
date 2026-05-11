// Pi SDK runtime shim for the Slack bridge.
//
// Owns the shared singletons (`authStorage`, `modelRegistry`, `resourceLoader`)
// built once at process boot, and exposes `createSlackSession({ threadTs, ... })`
// which is the only entry point the Slack handlers should use.
//
// Imported dynamically from index.mjs so the file remains parseable on a
// fresh clone before `npm install` resolves @earendil-works/pi-coding-agent.
//
// API surface assumed (per pi.dev/docs/latest/sdk):
//   - AuthStorage.create()
//   - ModelRegistry.create(authStorage)
//   - DefaultResourceLoader({ additionalExtensionPaths, skillPaths, agentPaths, promptPaths })
//   - SessionManager.create(cwd) | .open(path) | .inMemory()
//   - createAgentSession({ sessionManager, authStorage, modelRegistry, resourceLoader })
//   - session.bindExtensions({ uiContext })
//   - session.prompt(text), .followUp(text), .subscribe(listener), .abort(), .dispose()

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import {
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { slackUI } from "./slack-ui-context.mjs";

// REPO_ROOT resolves from apps/pi-mom/lib up to the workspace root.
const REPO_ROOT = resolve(process.cwd(), "..", "..");

const require_ = createRequire(import.meta.url);

// Resolve a pi-package node_module to its extension entrypoint at runtime.
// pi-subagents has no `exports`/`main`, so we anchor on its package.json and
// derive the path from `pi.extensions[0]` (or a fallback subpath).
function resolveNodeModuleExtension(packageName, subpath) {
  const pkgJsonPath = require_.resolve(`${packageName}/package.json`);
  const pkgRoot = dirname(pkgJsonPath);
  const pkg = require_(`${packageName}/package.json`);
  const declared = subpath ?? pkg?.pi?.extensions?.[0];
  if (!declared) {
    throw new Error(`resolveNodeModuleExtension: ${packageName} has no pi.extensions[0] and no fallback subpath`);
  }
  return resolve(pkgRoot, declared);
}

const EXTENSION_PATHS = [
  resolve(REPO_ROOT, "./extensions/browser-use-tools.ts"),
  resolve(REPO_ROOT, "./extensions/env-guard.ts"),
  resolve(REPO_ROOT, "./extensions/git-checkpoint.ts"),
  resolve(REPO_ROOT, "./extensions/linear-mcp-guard.ts"),
  resolve(REPO_ROOT, "./extensions/permission-gate.ts"),
  resolve(REPO_ROOT, "./extensions/slack-mcp-guard.ts"),
  resolve(REPO_ROOT, "./packages/pi-ext-covent-aws/src/index.ts"),
  resolveNodeModuleExtension("pi-subagents"),
];

const SKILL_PATHS = [resolve(REPO_ROOT, "./skills")];
const PROMPT_PATHS = [resolve(REPO_ROOT, "./prompts")];

let cachedRuntime;

// Build the shared Pi runtime — singletons constructed once at boot per
// pi.dev/docs/latest/sdk. cwd drives project-local resource discovery
// (e.g. .pi/agents); agentDir is the Pi global config (auth.json,
// settings.json, models.json). loader.reload() must run before the loader
// is passed to createAgentSession.
export async function getSharedRuntime() {
  if (cachedRuntime) return cachedRuntime;

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(REPO_ROOT, getAgentDir());
  const resourceLoader = new DefaultResourceLoader({
    cwd: REPO_ROOT,
    agentDir: getAgentDir(),
    settingsManager,
    additionalExtensionPaths: EXTENSION_PATHS,
    additionalSkillPaths: SKILL_PATHS,
    additionalPromptTemplatePaths: PROMPT_PATHS,
  });
  await resourceLoader.reload();

  cachedRuntime = {
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    repoRoot: REPO_ROOT,
  };
  return cachedRuntime;
}

// pendingApprovals is module-scope so it survives session replacement (per PR #17 §3.4).
// Keys are Slack action_ids assigned by slack-ui-context; values are resolveFns.
const pendingApprovals = new Map();

export function getPendingApprovals() {
  return pendingApprovals;
}

export async function createSlackSession({ threadTs, channel, client, sessionFilePath, runStore, tools } = {}) {
  if (!threadTs) throw new Error("createSlackSession: threadTs is required");
  if (!channel) throw new Error("createSlackSession: channel is required");
  if (!client) throw new Error("createSlackSession: client is required");

  const { authStorage, modelRegistry, resourceLoader, repoRoot } = await getSharedRuntime();

  // Resolve the resume path: explicit arg wins; otherwise look it up via runStore.
  let resumePath = sessionFilePath;
  if (!resumePath && runStore && typeof runStore.getSessionPathForThread === "function") {
    try {
      resumePath = await runStore.getSessionPathForThread(threadTs);
    } catch {
      resumePath = undefined;
    }
  }

  const sessionManager = resumePath
    ? SessionManager.open(resumePath)
    : SessionManager.create(repoRoot);
  const isFollowUp = Boolean(resumePath);

  const { session } = await createAgentSession({
    sessionManager,
    authStorage,
    modelRegistry,
    resourceLoader,
  });

  session.bindExtensions({
    uiContext: slackUI({ client, channel, threadTs, pendingApprovals }),
  });

  // Per-Action tool gating. Pi's default is to expose every tool registered
  // by the loaded extensions; when the dispatcher restricts an Action to a
  // subset (registry.yaml `tools:` array), we apply it here so the host
  // never has to recreate the session between turns.
  if (Array.isArray(tools) && tools.length > 0 && typeof session.setActiveToolsByName === "function") {
    try {
      session.setActiveToolsByName(tools);
    } catch (error) {
      console.warn(
        `[pi-runtime] setActiveToolsByName failed for thread ${threadTs}: ${error?.message ?? error}`,
      );
    }
  }

  // For freshly-created sessions, persist the resolved path back to the run
  // store so the next message on this thread can resume.
  if (!isFollowUp && runStore && typeof runStore.setSessionPathForThread === "function") {
    const newPath = sessionManager.getSessionFile();
    if (newPath) {
      try {
        await runStore.setSessionPathForThread(threadTs, newPath);
      } catch {
        // best-effort — failing to persist the session path doesn't block the run
      }
    } else {
      console.warn(
        `[pi-runtime] sessionManager.getSessionFile() returned undefined; thread ${threadTs} will not resume.`,
      );
    }
  }

  return { session, sessionManager, isFollowUp };
}

// Build a minimal Block Kit "tool started" section. Kept deliberately small;
// richer task-card formatting can land alongside the index.mjs surgery phase.
function toolStartBlocks({ toolName }) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `🔧 Tool: \`${toolName ?? "unknown"}\`` },
    },
  ];
}

function toolEndMarkdown({ isError }) {
  return isError ? "\n❌ tool failed\n" : "\n✅ tool ok\n";
}

// runActionInSlack drives a single Pi turn end-to-end against Slack's native
// streaming API (chat.startStream / appendStream / stopStream). Returns the
// accumulated assistant text.
export async function runActionInSlack({
  session,
  channel,
  threadTs,
  client,
  prompt,
  isFollowUp = false,
  onProgress,
} = {}) {
  if (!session) throw new Error("runActionInSlack: session is required");
  if (!channel) throw new Error("runActionInSlack: channel is required");
  if (!threadTs) throw new Error("runActionInSlack: threadTs is required");
  if (!client) throw new Error("runActionInSlack: client is required");
  if (typeof prompt !== "string" || !prompt) throw new Error("runActionInSlack: prompt is required");

  const started = await client.chat.startStream({ channel, thread_ts: threadTs });
  const streamTs = started?.ts;
  if (!streamTs) throw new Error("runActionInSlack: chat.startStream did not return a ts");

  // Sequence all Slack writes through a single promise chain to honor rate
  // limits.
  let streamChain = Promise.resolve();
  let streamError = null;

  const queueAppend = (payload) => {
    streamChain = streamChain
      .then(() => client.chat.appendStream({ channel, ts: streamTs, ...payload }))
      .catch((error) => {
        streamError = streamError || error;
      });
    return streamChain;
  };

  const stopStream = async () => {
    await client.chat.stopStream({ channel, ts: streamTs });
  };

  let accumulated = "";

  const done = new Promise((resolveFn, rejectFn) => {
    let unsubscribe = () => {};

    const settle = (fn, value) => {
      try { unsubscribe(); } catch { /* ignore */ }
      fn(value);
    };

    unsubscribe = session.subscribe((evt) => {
      try {
        const type = evt?.type;
        if (type === "message_update") {
          const inner = evt.assistantMessageEvent;
          if (inner?.type === "text_delta" && typeof inner.delta === "string") {
            accumulated += inner.delta;
            queueAppend({ markdown_text: inner.delta });
            if (typeof onProgress === "function") {
              try { onProgress({ type: "text_delta", delta: inner.delta }); } catch { /* swallow */ }
            }
          }
        } else if (type === "tool_execution_start") {
          queueAppend({ blocks: toolStartBlocks({ toolName: evt.toolName }) });
          if (typeof onProgress === "function") {
            try { onProgress({ type: "tool_start", toolName: evt.toolName, toolCallId: evt.toolCallId }); } catch { /* swallow */ }
          }
        } else if (type === "tool_execution_end") {
          queueAppend({ markdown_text: toolEndMarkdown({ isError: Boolean(evt.isError) }) });
          if (typeof onProgress === "function") {
            try { onProgress({ type: "tool_end", toolCallId: evt.toolCallId, isError: Boolean(evt.isError) }); } catch { /* swallow */ }
          }
        } else if (type === "agent_end") {
          settle(resolveFn, accumulated);
        } else if (type === "auto_retry_failed" || type === "error") {
          settle(rejectFn, new Error(evt?.error?.message || "Pi SDK reported an error"));
        }
      } catch (err) {
        settle(rejectFn, err);
      }
    });
  });

  try {
    if (isFollowUp) {
      await session.followUp(prompt);
    } else {
      await session.prompt(prompt);
    }
    const result = await done;
    await streamChain;
    if (streamError) throw streamError;
    await stopStream();
    return result;
  } catch (error) {
    try { await streamChain; } catch { /* swallow */ }
    try { await stopStream(); } catch { /* swallow */ }
    throw error;
  } finally {
    try { await session.dispose(); } catch { /* swallow per Pi semantics */ }
  }
}
