// Gemini-3.1-Flash-Lite image describer.
//
// One pure function, one job: turn raw Slack image bytes into a short,
// factual text description that the Pi agent can read in the assembled
// prompt. The agent gets the description by default and only calls the
// `read_image_content` Pi tool (Worker E) when it actually needs native
// vision. See design doc §3a.
//
// Never throws. Every failure mode returns a tagged `{ error }` object so
// the prompt builder can substitute an "(unavailable)" placeholder and the
// turn keeps moving. Throwing here would force every caller into a
// try/catch dance for what is, by design, a best-effort enrichment.

import { getGemini, MODEL_ID, SAFETY_SETTINGS, withDeadline } from "./gemini-client.mjs";
import { lookup, write } from "./image-description-cache.mjs";

// Describer instruction (system text part). Spec-locked — see design doc §2.
// Kept short so the response stays factual; agents downstream consume this
// as evidence, not as creative-writing fodder. The "≤ 220 words" bound is
// belt-and-braces alongside `maxOutputTokens: 400`.
const DESCRIBER_INSTRUCTION =
  "Describe factually for another AI agent: visible text verbatim, UI " +
  "elements, charts, people/objects, layout. Be factual, not interpretive. " +
  "≤ 220 words.";

// One short retry on 429 (and only 429). Gemini's QPS limits are bursty;
// a 250ms wait is enough to clear most contention without ballooning
// the user-facing turn latency.
const RETRY_BACKOFF_MS = 250;

function _isRateLimited(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  // The SDK surfaces status both as `err.status` and embedded in the message
  // depending on transport layer. We catch both.
  if (err.status === 429 || err.code === 429) return true;
  return /\b429\b|rate.?limit|rate_?limited|RESOURCE_EXHAUSTED/i.test(msg);
}

function _isSafetyBlocked(response) {
  // Gemini's "blocked" signal is a flag in promptFeedback; the response
  // body has no `text` in that case. Picking both up so we never silently
  // emit an empty description.
  if (!response) return true;
  const block = response.promptFeedback?.blockReason;
  if (block) return true;
  const cand = response.candidates?.[0];
  if (cand?.finishReason === "SAFETY" || cand?.finishReason === "BLOCKED") {
    return true;
  }
  return false;
}

function _extractText(response) {
  if (!response) return "";
  // SDK exposes `.text` as a derived getter that concatenates text parts.
  if (typeof response.text === "string") return response.text.trim();
  // Defensive fallback for mocks that return a plain object.
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
  }
  return "";
}

async function _callGeminiOnce({ gemini, buffer, mimeType }) {
  // Inline-data path is the cheapest for ≤20MB inputs (Slack hard-caps
  // image uploads under that). For bigger files we'd switch to the Files
  // API but Slack will never send us anything that large here.
  return gemini.models.generateContent({
    model: MODEL_ID,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: buffer.toString("base64"), mimeType } },
          { text: DESCRIBER_INSTRUCTION },
        ],
      },
    ],
    config: {
      thinkingConfig: { thinkingLevel: "minimal" },
      maxOutputTokens: 400,
      safetySettings: SAFETY_SETTINGS,
    },
  });
}

/**
 * Produce a factual text description for one Slack-uploaded image.
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer raw image bytes (Slack url_private download)
 * @param {string} opts.mimeType e.g. "image/png"
 * @param {string} opts.fileId Slack file_id (used as the cache key)
 * @param {number} [opts.deadlineMs=1800] hard ceiling per Gemini call;
 *   retries do not extend this — each call gets its own deadline so the
 *   worst case is ~2x deadlineMs + RETRY_BACKOFF_MS.
 * @param {*} [opts.gemini] DI hook for tests; defaults to `getGemini()`.
 *   Production callers should never pass this — the singleton in
 *   `gemini-client.mjs` is the only intended client.
 * @param {*} [opts.cache] DI hook for tests; defaults to the on-disk cache.
 * @param {AbortSignal} [opts.signal] optional caller-side abort; an already-
 *   aborted signal short-circuits before we touch Gemini.
 *
 * @returns {Promise<
 *   | { description: string, model: string, builtAt: number, source: "live" | "cache" }
 *   | { error: "gemini_unavailable" | "timeout" | "blocked" | string }
 * >}
 */
export async function describeImage({
  buffer,
  mimeType,
  fileId,
  deadlineMs = 1800,
  gemini,
  cache,
  signal,
} = {}) {
  // Caller-side abort: if the signal is already tripped we don't even hit
  // the cache. This mirrors how a Pi tool's signal works.
  if (signal && signal.aborted) {
    return { error: "aborted" };
  }

  // 1) Cache lookup first — a hit is instant and free.
  const cacheImpl = cache || { lookup, write };
  if (fileId) {
    const hit = await cacheImpl.lookup(fileId);
    if (hit) {
      return { ...hit, source: "cache" };
    }
  }

  // 2) Gemini availability gate. We return BEFORE any network attempt so
  // that callers know not to surface a "we tried" message to the user.
  // No cache write either — there's nothing to cache.
  const client = gemini !== undefined ? gemini : getGemini();
  if (!client) {
    return { error: "gemini_unavailable" };
  }

  // Caller invariants. Throwing would violate the "never throws" contract
  // so we wrap as a typed error.
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    return { error: "invalid_buffer" };
  }
  if (!mimeType || !mimeType.startsWith("image/")) {
    return { error: "invalid_mime" };
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  // 3) Call Gemini with the deadline. One retry on 429 only; everything
  // else propagates immediately so we don't hide systemic problems.
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await withDeadline(
      _callGeminiOnce({ gemini: client, buffer: buf, mimeType }),
      deadlineMs,
    );

    if (result.ok) {
      const response = result.value;
      if (_isSafetyBlocked(response)) {
        // No cache write — a "blocked" verdict can be model/version
        // dependent; we'd rather re-evaluate later than poison the cache.
        return { error: "blocked" };
      }
      const description = _extractText(response);
      if (!description) {
        return { error: "empty_response" };
      }
      const entry = {
        description,
        model: MODEL_ID,
        builtAt: Date.now(),
      };
      // Best-effort cache write. If disk is read-only or the volume is
      // missing we still return the live result to the caller; the next
      // turn will just regenerate.
      if (fileId) {
        try {
          await cacheImpl.write(fileId, entry);
        } catch {
          /* swallow — see comment above */
        }
      }
      return { ...entry, source: "live" };
    }

    // Failure path. Timeouts are terminal; 429s get one retry; all else terminal.
    if (result.error === "timeout") {
      return { error: "timeout" };
    }
    if (attempt === 0 && _isRateLimited({ message: result.error })) {
      attempt += 1;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      continue;
    }
    return { error: result.error };
  }
}
