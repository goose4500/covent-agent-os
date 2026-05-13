// token-estimator — telemetry-only token & prompt-size estimation.
//
// Pure functions. No I/O, no truncation. Used to attach size telemetry to
// thread-context payloads so we can observe long-thread + multimodal growth
// without changing what gets sent to the model.
//
// Heuristic: ~4 chars per token. Good enough for telemetry; not a tokenizer.

/**
 * Estimate token count of a string using the 4-chars-per-token heuristic.
 * Null/undefined/empty → 0. Never throws.
 *
 * @param {string | null | undefined} str
 * @returns {number}
 */
export function estimateTokens(str) {
  return Math.ceil((str || "").length / 4);
}

/**
 * Try to extract a message count from a header string. Looks for patterns like
 * "12 messages" or "msg_count: 12" or "(12 msgs)". Returns 0 if nothing matches.
 *
 * @param {string} header
 * @returns {number}
 */
function deriveMsgCountFromHeader(header) {
  if (!header || typeof header !== "string") return 0;
  // Try a few common shapes — best-effort only.
  const patterns = [
    /msg_count\s*[:=]\s*(\d+)/i,
    /(\d+)\s*messages?\b/i,
    /(\d+)\s*msgs?\b/i,
  ];
  for (const re of patterns) {
    const m = header.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

/**
 * Estimate prompt size from the parts of a built thread-context payload.
 *
 * Inputs match what `buildThreadContext` returns:
 *   { header, summaryBlock, rawTail, attachments, stats }
 *
 * - `rawTail` may be an array of message objects (preferred), OR a string with
 *   a separate `msgCount` companion field for compatibility.
 * - `attachments` may be an array; non-arrays count as 0.
 *
 * @param {object} args
 * @param {string} [args.header]
 * @param {string | null} [args.summaryBlock]
 * @param {Array | string | null} [args.rawTail]
 * @param {Array | null} [args.attachments]
 * @param {number} [args.msgCount] - only used when rawTail is not an array
 * @returns {{ tokens_est: number, msg_count: number, file_count: number, has_summary: boolean, tier: "T0" | "T1" }}
 */
export function estimatePromptSize({
  header,
  summaryBlock,
  rawTail,
  attachments,
  msgCount,
} = {}) {
  // tokens_est: sum tokens of every non-null string-ish input.
  let tokens_est = 0;
  if (header != null) tokens_est += estimateTokens(header);
  if (summaryBlock != null) tokens_est += estimateTokens(summaryBlock);

  if (rawTail != null) {
    if (Array.isArray(rawTail)) {
      for (const msg of rawTail) {
        // Conservative: stringify each message so we count whatever text it carries.
        if (msg == null) continue;
        const s = typeof msg === "string" ? msg : safeStringify(msg);
        tokens_est += estimateTokens(s);
      }
    } else if (typeof rawTail === "string") {
      tokens_est += estimateTokens(rawTail);
    }
  }

  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (att == null) continue;
      const s = typeof att === "string" ? att : safeStringify(att);
      tokens_est += estimateTokens(s);
    }
  }

  // msg_count: prefer array length; else use header substring or explicit msgCount.
  let msg_count = 0;
  if (Array.isArray(rawTail)) {
    msg_count = rawTail.length;
  } else if (typeof msgCount === "number" && Number.isFinite(msgCount)) {
    msg_count = msgCount;
  } else if (typeof header === "string") {
    msg_count = deriveMsgCountFromHeader(header);
  }

  // file_count: only from array attachments.
  const file_count = Array.isArray(attachments) ? attachments.length : 0;

  const has_summary = !!summaryBlock;
  const tier = summaryBlock ? "T1" : "T0";

  return { tokens_est, msg_count, file_count, has_summary, tier };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) || "";
  } catch {
    return String(value ?? "");
  }
}
