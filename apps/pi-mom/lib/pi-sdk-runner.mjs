// In-process Pi SDK runner. Replaces the legacy `spawn(PI_COMMAND, ...)` subprocess runner.
//
// Public contract preserved from the old runPi (apps/pi-mom/index.mjs):
//   runPi(prompt, { onOutput, signal }): Promise<string>
//
// SDK event shape relied on (verified against @earendil-works/pi-coding-agent@0.74.0
// + @earendil-works/pi-agent-core + @earendil-works/pi-ai type defs):
//   AgentEvent { type: "message_update", assistantMessageEvent: AssistantMessageEvent }
//   AssistantMessageEvent { type: "text_delta", delta: string, ... }
//   AssistantMessageEvent { type: "error", error: AssistantMessage, reason: "aborted"|"error" }
//   AgentEvent { type: "agent_end", messages: AgentMessage[] } is the terminal event.

// PI_OFFLINE=1 disables the SDK's "install user-scope packages from settings.json"
// path that runs at first session creation. The default user settings list
// `npm:pi-web-access`, `npm:pi-subagents`, etc., which trip `npm install -g`
// (EACCES on Railway/WSL non-root). The bot loads any approved packages from
// app dependencies via an explicit resource loader instead of ambient global
// discovery. Set this BEFORE the SDK is invoked. Override with PI_OFFLINE=0
// only if you specifically need global package installs at runtime.
if (process.env.PI_OFFLINE === undefined || process.env.PI_OFFLINE === "") {
  process.env.PI_OFFLINE = "1";
}

// PI_AGENT_DIR is a friendlier alias for the SDK's PI_CODING_AGENT_DIR env var
// (resolved by getAgentDir() in @earendil-works/pi-coding-agent/dist/config.js).
// Without this alias, anyone who sets PI_AGENT_DIR on Railway expecting the
// docs-friendly name would silently fall back to ~/.pi/agent.
if (process.env.PI_AGENT_DIR && !process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = process.env.PI_AGENT_DIR;
}

// OAuth provider seeding for Railway/non-interactive deploys: certain providers
// (notably openai-codex) have no env-key path — they only authenticate via
// OAuth credentials in auth.json. Locally Jake ran `pi login openai-codex`
// and the SDK rotates tokens on every call. On Railway the file doesn't
// exist, so we materialize it from PI_AUTH_JSON_B64 on cold boot. Once the
// file exists (typically on a persistent volume mounted at $PI_AGENT_DIR),
// the SDK owns subsequent token rotation via its file-lock path. The seed
// env var is only consulted if auth.json is missing — we never overwrite
// an existing file because that would clobber the SDK's rotated tokens.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Buffer as _NodeBuffer } from "node:buffer";
import { homedir as _homedir } from "node:os";
import { join as _join } from "node:path";

function _resolveAgentDir() {
  return (
    process.env.PI_AGENT_DIR ||
    process.env.PI_CODING_AGENT_DIR ||
    _join(_homedir(), ".pi", "agent")
  );
}

(function seedAuthJsonFromEnv() {
  const seed = process.env.PI_AUTH_JSON_B64;
  if (!seed) return;
  const dir = _resolveAgentDir();
  const authPath = _join(dir, "auth.json");
  if (existsSync(authPath)) return;
  try {
    const json = _NodeBuffer.from(seed, "base64").toString("utf-8");
    JSON.parse(json); // syntax check before writing
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(authPath, json, { mode: 0o600 });
    console.log(`✓ Seeded ${authPath} from PI_AUTH_JSON_B64 (${json.length} bytes)`);
  } catch (err) {
    console.error(
      `Failed to seed auth.json from PI_AUTH_JSON_B64: ${err?.message || err}`,
    );
  }
})();

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
// Registers `linear_create_issue` as a Pi custom tool. The model drives Linear
// issue creation directly via tool calls, which is composable with future
// search/comment/update tools.
import linearTools from "../../../extensions/linear-tools.ts";
// slack-interactive-tools: registers `slack_approval_card`,
// `slack_choice_card`, `slack_input_request` as Pi custom tools so the
// model can post polished Block Kit interactivity (approval previews,
// choice cards, input modals) mid-turn. Backed by the
// confirmWithPreview / selectWithContext / inputRequest methods on
// slack-ui-context.mjs which the SDK threads through as ctx.ui to every
// extension and tool handler.
import slackInteractiveTools from "../../../extensions/slack-interactive-tools.ts";

export function subagentsEnabledFromEnv(env = process.env) {
  return String(env.PI_MOM_SUBAGENTS_ENABLED || "").toLowerCase() === "true";
}

async function loadSubagentsExtension() {
  const mod = await import("pi-subagents/src/extension/index.ts");
  return mod.default || mod;
}

export async function buildPiMomExtensionFactories({
  env = process.env,
  loadSubagents = loadSubagentsExtension,
} = {}) {
  const factories = [linearTools, slackInteractiveTools];
  if (subagentsEnabledFromEnv(env)) {
    factories.push(await loadSubagents());
  }
  return factories;
}

export async function buildResourceLoaderOptions({
  cwd,
  agentDir = getAgentDir(),
  env = process.env,
  loadSubagents = loadSubagentsExtension,
} = {}) {
  return {
    cwd,
    agentDir,
    // Skip filesystem discovery of extensions (extensionPaths empty) but
    // still load the inline factories below. This keeps the bot's
    // surface area predictable — only the extensions we explicitly opt
    // into run inside the agent loop.
    noExtensions: true,
    extensionFactories: await buildPiMomExtensionFactories({ env, loadSubagents }),
    // Skills ARE loaded (discovered from ./skills per package.json's
    // `pi.skills` config). The model uses skill descriptions to pick the
    // right operating mode per turn — Slack/Linear context primers,
    // repo work patterns, reasoning aids — instead of routing all of
    // that through hardcoded route instructions alone.
    // Prompts/themes/context-files stay off: they're not the lever here.
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  };
}

const PI_TIMEOUT_MS = Number(process.env.PI_TIMEOUT_MS || 180000);
const PI_MODEL = process.env.PI_MOM_MODEL || "openai-codex/gpt-5.5";
const PI_THINKING = process.env.PI_MOM_THINKING_LEVEL || "high";
const PI_WORKDIR = process.env.PI_WORKDIR || process.env.HOME || process.cwd();
// Legacy env fallback used only by the pi-sdk-runner unit tests that construct
// a runner without explicit `tools`; production callers always pass `tools`
// from the lib/routes.mjs route map.
const ALLOW_TOOLS = process.env.PI_MOM_ALLOW_PI_TOOLS === "true";

function stripTerminalSequences(text) {
  if (!text) return "";
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

// Deps cache. A single shared AuthStorage (file at ${PI_AGENT_DIR}/auth.json,
// seeded from PI_AUTH_JSON_B64 on cold boot) and a ModelRegistry bound to
// it. All Slack users share this auth — it's Andy's ChatGPT Max account.
// Pi rotates the access token in place on every model call.
let _depsPromise = null;

async function defaultGetDeps() {
  if (_depsPromise) return _depsPromise;

  _depsPromise = (async () => {
    const authStorage = await AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const slash = PI_MODEL.indexOf("/");
    const provider = slash >= 0 ? PI_MODEL.slice(0, slash) : PI_MODEL;
    const modelId = slash >= 0 ? PI_MODEL.slice(slash + 1) : "";
    const model = modelRegistry.find(provider, modelId);
    return { authStorage, modelRegistry, model, modelId: PI_MODEL };
  })().catch((err) => {
    _depsPromise = null;
    throw err;
  });
  return _depsPromise;
}

export function _resetSdkSingletonsForTests() {
  _depsPromise = null;
}

export function createRunner({
  createSession = createAgentSession,
  getDeps = defaultGetDeps,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  buildResourceLoader,
  allowTools = ALLOW_TOOLS,
  timeoutMs = PI_TIMEOUT_MS,
  thinkingLevel = PI_THINKING,
  workdir = PI_WORKDIR,
} = {}) {
  async function makeResourceLoader(cwd) {
    if (buildResourceLoader) return buildResourceLoader(cwd);
    const loader = new DefaultResourceLoader(await buildResourceLoaderOptions({ cwd }));
    await loader.reload();
    return loader;
  }

  async function runPi(prompt, { onOutput, signal, sessionManager, tools, sink, uiContext } = {}) {
    const deps = await getDeps();
    if (!deps.model) {
      throw new Error(
        `PI_MOM_MODEL '${deps.modelId || PI_MODEL}' not found in registry; check provider API key env var`,
      );
    }

    // Tool gating: when `tools` is provided by the lib/routes.mjs route map, it is
    // the authoritative allowlist. Empty array → noTools:"all" (no Pi tools
    // active; model-only draft). Non-empty array → all builtin tools
    // available to the SDK, then `setActiveToolsByName(tools)` narrows them
    // after createSession returns. When `tools` is undefined (legacy callers
    // + unit tests), fall back to the historical `allowTools` flag.
    const toolsExplicit = Array.isArray(tools);
    const effectiveAllowTools = toolsExplicit ? tools.length > 0 : allowTools;

    const sessionOptions = {
      cwd: workdir,
      model: deps.model,
      thinkingLevel,
      sessionManager: sessionManager || SessionManager.inMemory(),
      authStorage: deps.authStorage,
      modelRegistry: deps.modelRegistry,
      // Always pass our resource loader so the inline linearTools extension
      // loads regardless of tool gating. Without this, createAgentSession
      // synthesizes a default DefaultResourceLoader that discovers from
      // agentDir/extensions (empty on Railway) and the inline factory is
      // never seen.
      resourceLoader: await makeResourceLoader(workdir),
    };
    if (!effectiveAllowTools) {
      sessionOptions.noTools = "all";
    }
    // uiContext (ExtensionUIContext shape) is passed when a surface needs to
    // surface Pi extension prompts (ctx.ui.select/confirm/input) back to the
    // user. The runner consumes it via session.bindExtensions; createSession
    // also accepts uiContext directly per agent-session.d.ts:109. Prefer
    // bindExtensions so the binding is explicit and easy to swap per turn.
    if (uiContext) sessionOptions.uiContext = uiContext;

    const result = await createSession(sessionOptions);
    const session = result?.session ?? result;
    if (toolsExplicit && tools.length > 0 && typeof session.setActiveToolsByName === "function") {
      session.setActiveToolsByName(tools);
    }
    if (uiContext && typeof session.bindExtensions === "function") {
      try {
        await session.bindExtensions({ uiContext });
      } catch (err) {
        // Non-fatal: bindExtensions can fail if extensions are disabled (the
        // pi-mom runner sets noTools/no-extensions/no-skills). The
        // sessionOptions.uiContext path above still applies to anything that
        // can read ctx.ui, so we just trace and continue.
        try { onOutput?.(""); } catch {}
      }
    }

    return await new Promise((resolve, reject) => {
      let settled = false;
      let fullText = "";
      let capturedError;
      let unsubscribe;
      let timer;
      let abortHandler;

      const settle = async (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutFn(timer);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        if (unsubscribe) {
          try { unsubscribe(); } catch {}
        }
        try { await session.abort(); } catch {}
        try { await session.dispose(); } catch {}
        if (err) reject(err);
        else resolve(stripTerminalSequences(fullText));
      };

      unsubscribe = session.subscribe((evt) => {
        if (!evt || settled) return;
        if (evt.type === "message_update" && evt.assistantMessageEvent) {
          const ame = evt.assistantMessageEvent;
          if (ame.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
            fullText += ame.delta;
            try { onOutput?.(ame.delta); } catch {}
          } else if (ame.type === "error") {
            const msg = ame.error?.errorMessage || ame.reason || "agent error";
            capturedError = new Error(String(msg));
          }
        } else if (evt.type === "agent_end") {
          settle(capturedError || null);
        }
        // Forward every event (text deltas, tool_execution_*, turn_start/end,
        // etc.) to the optional Stage-5 sink so it can drive Slack streaming.
        // Sink-internal errors must not break the SDK subscription loop.
        if (sink && typeof sink.handle === "function") {
          try { sink.handle(evt); } catch {}
        }
      });

      timer = setTimeoutFn(
        () => settle(new Error(`Pi timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      if (signal) {
        if (signal.aborted) {
          settle(new Error("aborted"));
          return;
        }
        abortHandler = () => settle(new Error("aborted"));
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      Promise.resolve()
        .then(() => session.prompt(prompt))
        .catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
    });
  }

  return { runPi };
}

const _defaultRunner = createRunner();
export const runPi = _defaultRunner.runPi;
