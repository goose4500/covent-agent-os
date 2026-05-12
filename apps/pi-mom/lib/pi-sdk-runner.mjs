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
// (EACCES on Railway/WSL non-root). The bot doesn't use those packages — it
// passes `noTools: "all"` + an explicit resource loader. Set this BEFORE the
// SDK is invoked. Override with PI_OFFLINE=0 only if you specifically need
// global package installs at runtime.
if (process.env.PI_OFFLINE === undefined || process.env.PI_OFFLINE === "") {
  process.env.PI_OFFLINE = "1";
}

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const PI_TIMEOUT_MS = Number(process.env.PI_TIMEOUT_MS || 180000);
const PI_MODEL = process.env.PI_MOM_MODEL || "openai-codex/gpt-5.5";
const PI_THINKING = process.env.PI_MOM_THINKING_LEVEL || "high";
const PI_WORKDIR = process.env.PI_WORKDIR || process.env.HOME || process.cwd();
const ALLOW_TOOLS = process.env.PI_MOM_ALLOW_PI_TOOLS === "true";

function stripTerminalSequences(text) {
  if (!text) return "";
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

let _depsPromise;

async function defaultGetDeps() {
  if (!_depsPromise) {
    _depsPromise = (async () => {
      const authStorage = await AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const slash = PI_MODEL.indexOf("/");
      const provider = slash >= 0 ? PI_MODEL.slice(0, slash) : PI_MODEL;
      const modelId = slash >= 0 ? PI_MODEL.slice(slash + 1) : "";
      const model = modelRegistry.find(provider, modelId);
      return { authStorage, modelRegistry, model, modelId: PI_MODEL };
    })().catch((err) => {
      _depsPromise = undefined;
      throw err;
    });
  }
  return _depsPromise;
}

export function _resetSdkSingletonsForTests() {
  _depsPromise = undefined;
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
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    return loader;
  }

  async function runPi(prompt, { onOutput, signal } = {}) {
    const deps = await getDeps();
    if (!deps.model) {
      throw new Error(
        `PI_MOM_MODEL '${deps.modelId || PI_MODEL}' not found in registry; check provider API key env var`,
      );
    }

    const sessionOptions = {
      cwd: workdir,
      model: deps.model,
      thinkingLevel,
      sessionManager: SessionManager.inMemory(),
      authStorage: deps.authStorage,
      modelRegistry: deps.modelRegistry,
    };
    if (!allowTools) {
      sessionOptions.noTools = "all";
      sessionOptions.resourceLoader = await makeResourceLoader(workdir);
    }

    const result = await createSession(sessionOptions);
    const session = result?.session ?? result;

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
