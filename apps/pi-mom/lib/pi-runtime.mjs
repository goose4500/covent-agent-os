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
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { slackUI } from "./slack-ui-context.mjs";

// REPO_ROOT resolves from apps/pi-mom/lib up to the workspace root.
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

// Probe a SessionManager / session pair for the on-disk session file path. The
// SDK docs don't pin down a single accessor name; we try the most plausible
// surfaces in order and fall back to undefined (caller treats absent as "no
// resume possible this turn"). When the SDK formalises this we can drop the
// scan.
function resolveSessionPath({ sessionManager, session }) {
  const candidates = [
    () => sessionManager?.path,
    () => sessionManager?.sessionPath,
    () => sessionManager?.filePath,
    () => sessionManager?.location,
    () => (typeof sessionManager?.getPath === "function" ? sessionManager.getPath() : undefined),
    () => session?.sessionPath,
    () => session?.path,
  ];
  for (const fn of candidates) {
    try {
      const value = fn();
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // ignore — try the next probe
    }
  }
  // TODO(pi-sdk): once the SDK exposes a stable accessor for the session file
  // path, replace the probe above with a direct read.
  return undefined;
}

export async function createSlackSession({ threadTs, channel, client, sessionFilePath, runStore } = {}) {
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

  // For freshly-created sessions, persist the resolved path back to the run
  // store so the next message on this thread can resume.
  if (!isFollowUp && runStore && typeof runStore.setSessionPathForThread === "function") {
    const newPath = resolveSessionPath({ sessionManager, session });
    if (newPath) {
      try {
        await runStore.setSessionPathForThread(threadTs, newPath);
      } catch {
        // best-effort — failing to persist the session path doesn't block the run
      }
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
// streaming API (chat.startStream / appendStream / stopStream). Falls back to
// the legacy `client.chatStream({...})` helper when the new methods aren't
// available on the installed @slack/web-api.
//
// Returns the accumulated assistant text, mirroring the existing runPi contract.
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

  const hasNativeStream =
    client?.chat &&
    typeof client.chat.startStream === "function" &&
    typeof client.chat.appendStream === "function" &&
    typeof client.chat.stopStream === "function";

  // Slack stream handle. With the new API we hold the `ts` and call append/stop
  // against it directly. With the legacy fallback we hold the stream object.
  let streamTs;
  let legacyStream;

  if (hasNativeStream) {
    const started = await client.chat.startStream({ channel, thread_ts: threadTs });
    streamTs = started?.ts;
    if (!streamTs) throw new Error("runActionInSlack: chat.startStream did not return a ts");
  } else if (typeof client.chatStream === "function") {
    legacyStream = client.chatStream({ channel, thread_ts: threadTs });
  } else {
    throw new Error("runActionInSlack: neither chat.startStream nor chatStream is available on the Slack client");
  }

  // Sequence all Slack writes through a single promise chain to honor rate
  // limits (mirrors the streamChain pattern in index.mjs).
  let streamChain = Promise.resolve();
  let streamError = null;

  const queueAppend = (payload) => {
    streamChain = streamChain
      .then(() => {
        if (hasNativeStream) {
          return client.chat.appendStream({ channel, ts: streamTs, ...payload });
        }
        return legacyStream.append(payload);
      })
      .catch((error) => {
        streamError = streamError || error;
      });
    return streamChain;
  };

  const stopStream = async () => {
    if (hasNativeStream) {
      if (!streamTs) return;
      await client.chat.stopStream({ channel, ts: streamTs });
    } else if (legacyStream) {
      await legacyStream.stop();
    }
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
