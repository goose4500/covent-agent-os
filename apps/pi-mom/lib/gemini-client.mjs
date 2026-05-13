// Shared Gemini 3.1 Flash Lite client used by the image-describer and the
// (forthcoming) older-thread summarizer. Single module so we have one place
// owning the API-key check, the safety defaults, and the deadline helper.
//
// Why a singleton: pi-mom is one process; one client is plenty. The
// `@google/genai` GoogleGenAI instance is cheap but holds an auth client we
// don't need to rebuild per call.
//
// Why graceful degrade instead of throwing: callers (image describer,
// summarizer) treat Gemini as an enrichment layer. If the key is missing we
// want pi-mom to keep working — image descriptors become "(unavailable)",
// summarizer falls back to a rule-based reducer. See design doc §6.

import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";

export const MODEL_ID = "gemini-3.1-flash-lite";

// All four "real" harm categories at BLOCK_ONLY_HIGH — matches the design's
// non-restrictive default so we capture user-visible Slack content (memes,
// product screenshots with mild-but-edgy copy, etc.) without surprises.
// HARM_CATEGORY_UNSPECIFIED / CIVIC_INTEGRITY / IMAGE_HATE are not included
// because they are either unused or not supported on the Gemini API tier.
export const SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
];

let _client = null;
let _warned = false;

/**
 * Returns a singleton GoogleGenAI instance, or `null` if GEMINI_API_KEY is
 * not set. The first time the key is missing we log a one-shot warning so
 * the operator notices on boot; subsequent calls stay silent.
 *
 * Callers MUST handle the `null` case. Throwing here would punish every
 * caller for what is meant to be a graceful degradation path.
 */
export function getGemini() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (!_warned) {
      _warned = true;
      console.warn(
        "[gemini-client] GEMINI_API_KEY missing — image descriptions and " +
          "thread summarization will degrade. See docs/research/2026-05-12/" +
          "long-thread-multimodal-context-rnd.md §6.",
      );
    }
    return null;
  }
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

// Test-only escape hatch: reset the singleton + the one-shot warning latch
// so unit tests can simulate "no API key on boot" / "API key now present"
// without spawning a subprocess. Not part of the public production API.
export function _resetForTests() {
  _client = null;
  _warned = false;
}

/**
 * Race `promise` against a `ms`-millisecond deadline. Returns a tagged
 * result so callers can branch on `ok` without try/catch. We don't `throw`
 * here because every site that uses Gemini wants to degrade, not crash.
 *
 * `error` is `"timeout"` when the deadline fires, otherwise the raw error
 * string (or a `gemini_blocked` marker if the caller chooses to map it).
 */
export async function withDeadline(promise, ms) {
  // AbortSignal.timeout is in Node 17.3+ / Bun, lands in undici; safe here.
  const signal = AbortSignal.timeout(ms);
  const deadline = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("timeout"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("timeout")),
      { once: true },
    );
  });
  try {
    const value = await Promise.race([promise, deadline]);
    return { ok: true, value };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    if (msg === "timeout" || err?.name === "TimeoutError" || err?.name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: msg };
  }
}
