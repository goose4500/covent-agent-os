// Cache pre-warmer for pi-mom.
//
// Fires one Pi turn at bridge startup so the provider's prompt-prefix cache
// is populated before a real Slack user arrives. The provider already gets
// `prompt_cache_key=sessionId` from the SDK on every call (verified in
// @earendil-works/pi-ai providers/openai-codex-responses.js), but cold
// start after a Railway redeploy still pays the full prefix cost on the
// first real turn. Sending one synthetic turn through `runPi` with the
// default tool surface pre-pays that cost: the OpenAI Codex backend
// retains the prefix bytes (independent of `prompt_cache_key`) for a
// window long enough that the next real turn lands as a cache hit.
//
// Side effects are deliberately minimal:
// - Runs against an in-memory SessionManager (the runner's default),
//   so the warmup never writes JSONL to disk and never appears in any
//   Slack thread's resumable history.
// - No sink is passed, so nothing reaches Slack.
// - All exceptions are caught and logged via the standard `[pi-mom-trace]`
//   line format; the bridge never crashes from a warmup failure.
//
// Cost shape: one turn per call. With "ok" as the prompt and the default
// pi-mom tool surface, expect cacheWrite of the full system-prompt/tools
// prefix (~few thousand tokens) plus a tiny output. The `cache-telemetry`
// extension's `cache.prewarm` companion log lets you grep the actual
// numbers in Railway logs after deploy.
//
// Env:
// - PI_MOM_PREWARM_ENABLED ("false" disables; default on)
// - PI_MOM_PREWARM_INTERVAL_MS (0 = startup only; default 0)
// - PI_MOM_PREWARM_PROMPT (default "ok")

const DEFAULT_PROMPT = "ok";

export function createPrewarmer({
  runPi,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  env = process.env,
  log = (...args) => console.log(...args),
  warn = (...args) => console.warn(...args),
} = {}) {
  if (typeof runPi !== "function") {
    throw new TypeError("createPrewarmer requires a `runPi` function");
  }

  const enabled = env.PI_MOM_PREWARM_ENABLED !== "false";
  const intervalMs = Number(env.PI_MOM_PREWARM_INTERVAL_MS || 0);
  const prompt = env.PI_MOM_PREWARM_PROMPT || DEFAULT_PROMPT;

  let timer;

  function emit(stream, event, data) {
    const entry = { ts: new Date().toISOString(), event, ...data };
    stream(`[pi-mom-trace] ${JSON.stringify(entry)}`);
  }

  async function warmOnce(reason) {
    const t0 = Date.now();
    try {
      await runPi(prompt);
      emit(log, "cache.prewarm", { reason, elapsedMs: Date.now() - t0 });
    } catch (err) {
      emit(warn, "cache.prewarm_failed", {
        reason,
        elapsedMs: Date.now() - t0,
        error: err?.message || String(err),
      });
    }
  }

  function start() {
    if (!enabled) {
      emit(log, "cache.prewarm_skipped", { reason: "disabled" });
      return { started: Promise.resolve(), stop: () => {} };
    }
    const started = warmOnce("startup");
    if (intervalMs > 0) {
      timer = setIntervalFn(() => { warmOnce("scheduled"); }, intervalMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
    return {
      started,
      stop: () => {
        if (timer) {
          clearIntervalFn(timer);
          timer = undefined;
        }
      },
    };
  }

  return { warmOnce, start, config: { enabled, intervalMs, prompt } };
}
