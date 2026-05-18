// In-process Pi SDK runner. Replaces the legacy `spawn(PI_COMMAND, ...)` subprocess runner.
//
// Public contract preserved from the old runPi (apps/pi-mom/index.mjs):
//   runPi(prompt, { onOutput, signal }): Promise<string>
//
// SDK event shape relied on (verified against @earendil-works/pi-coding-agent@0.75.3
// + @earendil-works/pi-agent-core + @earendil-works/pi-ai type defs):
//   AgentEvent { type: "message_update", assistantMessageEvent: AssistantMessageEvent }
//   AssistantMessageEvent { type: "text_delta", delta: string, ... }
//   AssistantMessageEvent { type: "text_end", content: string, ... }
//   AssistantMessageEvent { type: "error", error: AssistantMessage, reason: "aborted"|"error" }
//   AgentEvent { type: "message_end"|"turn_end", message: AgentMessage }
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
import { createRequire } from "node:module";
import { homedir as _homedir } from "node:os";
import { dirname as _dirname, join as _join, resolve as _resolve } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";

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

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function buildSlackMcpConfigFromEnv(env = process.env) {
  if (!isTruthyEnv(env.SLACK_MCP_ENABLED)) return null;
  const bearerTokenEnv = env.SLACK_MCP_BEARER_TOKEN_ENV || "SLACK_MCP_USER_TOKEN";
  const server = {
    url: env.SLACK_MCP_URL || "https://mcp.slack.com/mcp",
    lifecycle: env.SLACK_MCP_LIFECYCLE || "lazy",
    auth: "bearer",
    bearerTokenEnv,
    directTools: isTruthyEnv(env.SLACK_MCP_DIRECT_TOOLS),
  };
  if (env.SLACK_MCP_IDLE_TIMEOUT_MINUTES) {
    const idleTimeout = Number(env.SLACK_MCP_IDLE_TIMEOUT_MINUTES);
    if (Number.isFinite(idleTimeout)) server.idleTimeout = idleTimeout;
  }
  return {
    settings: {
      toolPrefix: "server",
    },
    mcpServers: {
      slack: server,
    },
  };
}

export function seedMcpJsonFromEnv({ env = process.env, agentDir = _resolveAgentDir(), log = console } = {}) {
  const mcpPath = _join(agentDir, "mcp.json");
  if (existsSync(mcpPath)) return { seeded: false, reason: "exists", path: mcpPath };

  let json = "";
  let source = "";
  if (env.PI_MCP_JSON_B64) {
    source = "PI_MCP_JSON_B64";
    json = _NodeBuffer.from(env.PI_MCP_JSON_B64, "base64").toString("utf-8");
  } else {
    const slackMcpConfig = buildSlackMcpConfigFromEnv(env);
    if (!slackMcpConfig) return { seeded: false, reason: "not-configured", path: mcpPath };
    source = "SLACK_MCP_ENABLED";
    json = `${JSON.stringify(slackMcpConfig, null, 2)}\n`;
  }

  try {
    JSON.parse(json); // syntax check before writing
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(mcpPath, json, { mode: 0o600 });
    log?.log?.(`✓ Seeded ${mcpPath} from ${source} (${json.length} bytes)`);
    return { seeded: true, source, path: mcpPath };
  } catch (err) {
    log?.error?.(
      `Failed to seed mcp.json from ${source}: ${err?.message || err}`,
    );
    return { seeded: false, reason: "error", source, path: mcpPath, error: err };
  }
}

// MCP server config seeder. Mirrors the auth.json pattern: pi-mcp-adapter
// reads `${PI_AGENT_DIR}/mcp.json` (the "Pi global override" slot in its
// precedence list — see pi-mcp-adapter/config.ts). On Railway the file
// doesn't exist on cold boot of a fresh volume, so we materialize it from
// PI_MCP_JSON_B64 or, when SLACK_MCP_ENABLED=1, from a built-in Slack MCP
// preset that reads its bearer token from an env var without writing the
// token into git or disk. We only seed when the file is missing because the
// adapter persists OAuth/directTools state back into this file.
seedMcpJsonFromEnv();

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
// slack-canvas-tools: registers `slack_canvas_start` /
// `slack_canvas_finish` so the model can open a Slack canvas mid-turn
// for long-form deliverables. The canvas-sink attaches to the live
// composite event fan via ctx.ui.startCanvas, so text deltas mirror
// into the canvas automatically until ctx.ui.stopCanvas detaches.
import slackCanvasTools from "../../../extensions/slack-canvas-tools.ts";
// bridge-tools: registers `bridge_help` / `bridge_status` so the model
// can surface bridge help and live status when the user asks. Backed
// by ctx.ui.bridgeHelp / ctx.ui.bridgeStatus closures supplied by the
// bridge per-turn.
import bridgeTools from "../../../extensions/bridge-tools.ts";
import browserUseTools from "../../../extensions/browser-use-tools.ts";
import xFetchPostTool from "../../../extensions/x-fetch-post-tool.ts";
import gitCheckpoint from "../../../extensions/git-checkpoint.ts";

const require = createRequire(import.meta.url);

const _PI_MOM_LIB_DIR = _dirname(_fileURLToPath(import.meta.url));

export function resolveProjectSkillsDir() {
  return _resolve(_PI_MOM_LIB_DIR, "..", "..", "..", "skills");
}

export function subagentsEnabledFromEnv(_env = process.env) {
  return true;
}

export function webAccessEnabledFromEnv(_env = process.env) {
  return true;
}

export function resolveWebAccessResourcePaths({ requireFn = require } = {}) {
  const pkgJson = requireFn.resolve("pi-web-access/package.json");
  const root = _dirname(pkgJson);
  return {
    packageJsonPath: pkgJson,
    root,
    extensionPath: _join(root, "index.ts"),
    skillsPath: _join(root, "skills"),
  };
}

async function loadSubagentsExtension() {
  const mod = await import("pi-subagents/src/extension/index.ts");
  return mod.default || mod;
}

// pi-mcp-adapter is the community Pi extension that proxies arbitrary MCP
// servers through a single `mcp` tool (and optional per-server direct
// tools). It's loaded inline the same way pi-subagents is — as an in-process
// extension factory, NOT via `pi install` — so PI_OFFLINE=1 has no effect
// on it. Server config lives at `${PI_AGENT_DIR}/mcp.json` (seeded above
// from PI_MCP_JSON_B64 on Railway) or `.mcp.json` / `.pi/mcp.json` for
// project-scoped servers. See pi-mcp-adapter/README.md for the schema.
async function loadMcpAdapterExtension() {
  const mod = await import("pi-mcp-adapter");
  return mod.default || mod;
}

export async function buildPiMomExtensionFactories({
  loadSubagents = loadSubagentsExtension,
  loadMcpAdapter = loadMcpAdapterExtension,
} = {}) {
  return [
    linearTools,
    slackInteractiveTools,
    slackCanvasTools,
    bridgeTools,
    browserUseTools,
    xFetchPostTool,
    gitCheckpoint,
    await loadMcpAdapter(),
    await loadSubagents(),
  ];
}

export async function buildResourceLoaderOptions({
  cwd,
  agentDir = getAgentDir(),
  env = process.env,
  loadSubagents = loadSubagentsExtension,
  loadMcpAdapter = loadMcpAdapterExtension,
  resolveWebAccessPaths = resolveWebAccessResourcePaths,
} = {}) {
  const webAccess = resolveWebAccessPaths();
  return {
    cwd,
    agentDir,
    // Keep extension loading deterministic for Railway but make every
    // app-approved extension default-on. Package/global auto-install stays
    // disabled by PI_OFFLINE; the app explicitly loads its own extension
    // factories plus the app-pinned pi-web-access package path.
    noExtensions: true,
    extensionFactories: await buildPiMomExtensionFactories({ env, loadSubagents, loadMcpAdapter }),
    additionalExtensionPaths: [webAccess.extensionPath],
    // Skills are no longer route-gated: repo skills plus pi-web-access skills
    // are always available, and ambient/default skill discovery is allowed.
    additionalSkillPaths: [resolveProjectSkillsDir(), webAccess.skillsPath],
    noSkills: false,
    noPromptTemplates: false,
    noThemes: false,
    noContextFiles: false,
  };
}

export function resolvePiWorkdir(env = process.env, cwd = process.cwd()) {
  // Prefer the actual app checkout so project-owned `.agents/` profiles are
  // discoverable by pi-subagents. HOME is `/root` on Railway, which hides the
  // repo and makes `team:` subagent presets fall back to builtin-only discovery.
  return env.PI_WORKDIR || cwd || env.HOME;
}

const PI_TIMEOUT_MS = Number(process.env.PI_TIMEOUT_MS || 720000);
const PI_MODEL = process.env.PI_MOM_MODEL || "openai-codex/gpt-5.5";
const PI_THINKING = process.env.PI_MOM_THINKING_LEVEL || "high";
const PI_WORKDIR = resolvePiWorkdir();
// Normal Slack turns omit `tools`, which means every registered tool is
// activated by default. Legacy env-level tool deny switches are intentionally
// ignored; explicit `tools: []` is the only internal no-tools escape hatch.
const ALLOW_TOOLS = true;

function stripTerminalSequences(text) {
  if (!text) return "";
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function extractAssistantText(message) {
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part) return "";
      if (typeof part === "string") return part;
      if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("");
}

function extractLastAssistantText(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractAssistantText(messages[i]);
    if (text && text.trim()) return text;
  }
  return "";
}

function extractAssistantError(message) {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.errorMessage === "string" && message.errorMessage) return message.errorMessage;
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return `agent ${message.stopReason}`;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  for (const part of content) {
    if (part?.type === "error") {
      return part.errorMessage || part.message || part.text || "agent error";
    }
  }
  return "";
}

function extractLastAssistantError(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractAssistantError(messages[i]);
    if (text) return text;
  }
  return "";
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

    // Default-all posture: normal Slack turns omit `tools`, so we create the
    // session with tools enabled and then activate every registered tool by
    // name. Explicit `tools: []` remains an internal escape hatch for tests or
    // non-Pi bridge replies that intentionally need no tools.
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
    } else if (!toolsExplicit && effectiveAllowTools && typeof session.setActiveToolsByName === "function" && typeof session.getAllTools === "function") {
      const allToolNames = session.getAllTools().map((tool) => tool.name).filter(Boolean);
      session.setActiveToolsByName([...new Set(allToolNames)]);
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
      let latestFinalText = "";
      const textByContentIndex = new Map();
      let capturedError;
      let unsubscribe;
      let timer;
      let abortHandler;

      const appendOutput = (text) => {
        if (!text) return;
        fullText += text;
        try { onOutput?.(text); } catch {}
      };

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
            const key = ame.contentIndex ?? "default";
            textByContentIndex.set(key, `${textByContentIndex.get(key) || ""}${ame.delta}`);
            appendOutput(ame.delta);
          } else if (ame.type === "text_end") {
            const content = typeof ame.content === "string" ? ame.content : "";
            if (content) {
              const key = ame.contentIndex ?? "default";
              const seen = textByContentIndex.get(key) || "";
              let missing = "";
              if (!seen) missing = content;
              else if (content.startsWith(seen) && content.length > seen.length) missing = content.slice(seen.length);
              if (missing) appendOutput(missing);
              textByContentIndex.set(key, content);
              latestFinalText = content;
            }
          } else if (ame.type === "error") {
            const msg = ame.error?.errorMessage || ame.reason || "agent error";
            capturedError = new Error(String(msg));
          }
        } else if (evt.type === "message_end") {
          latestFinalText = extractAssistantText(evt.message) || latestFinalText;
          const msgError = extractAssistantError(evt.message);
          if (msgError) capturedError = new Error(String(msgError));
        } else if (evt.type === "turn_end") {
          latestFinalText = extractAssistantText(evt.message) || latestFinalText;
          const msgError = extractAssistantError(evt.message);
          if (msgError) capturedError = new Error(String(msgError));
        } else if (evt.type === "agent_end") {
          if (!fullText.trim()) {
            fullText = extractLastAssistantText(evt.messages) || latestFinalText || fullText;
          }
          const finalError = extractLastAssistantError(evt.messages);
          if (finalError) capturedError = new Error(String(finalError));
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
