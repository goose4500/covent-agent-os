// Stage 8 — Canvas sink. Mirrors a Pi agent run into a standalone Slack
// canvas while the model is still emitting tokens, so long-form deliverables
// (specs) live as a clean scrollable doc the user can share, comment on, and
// re-read instead of a 7-message-long Slack thread.
//
// Why this shape (per May 2026 Slack canvas API research, codified here so
// future readers don't re-discover the foot-guns):
//
//  - `canvases.edit` accepts AT MOST 1 operation per call. We can't batch
//    multiple inserts into one HTTP request; serialize via an in-sink
//    `busy` flag.
//  - The endpoint sits in rate-limit Tier 3 (~50/min). 3s debounce caps us
//    at 20/min with comfortable headroom.
//  - There is NO native "canvas stream" helper (no parallel to
//    `chat.startStream`/`appendStream`/`stopStream`). We build the
//    debounced batcher ourselves.
//  - Block Kit is not supported in canvases — markdown only. Pi already
//    emits markdown so this is a non-issue.
//  - The title is the only "lock" indicator we have: flip to
//    `[streaming] {title}` at start, back to `{title}` at stop via the
//    `rename` op. Slack has no native locking primitive.
//  - At stop, do a single `replace` pass with the full accumulated text
//    so the final document is one cohesive section instead of N
//    streaming fragments.
//
// DI-friendly: tests inject a fake client.canvases.* and fake timers.
// Errors are fail-soft: a failed canvas create/edit traces and continues;
// the slack-sink and Pi turn proceed regardless.

const DEFAULT_FLUSH_MS = 3000;
const DEFAULT_FLUSH_BYTES = 1500;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2000;
const STREAMING_TITLE_PREFIX = "[streaming] ";
const INITIAL_MARKDOWN = "_Starting…_\n\n";

export function createCanvasSink({
  client,
  channel,
  title,
  requestId,
  trace = () => {},
  flushMs = DEFAULT_FLUSH_MS,
  flushBytes = DEFAULT_FLUSH_BYTES,
  rateLimitBackoffMs = DEFAULT_RATE_LIMIT_BACKOFF_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
} = {}) {
  if (typeof client?.canvases?.create !== "function" || typeof client?.canvases?.edit !== "function") {
    throw new Error(
      "Slack WebClient.canvases.{create,edit} unavailable; upgrade @slack/web-api to a release that exposes typed canvas methods.",
    );
  }
  const baseTitle = String(title || "Spec draft").slice(0, 80);

  let canvasId;
  let canvasUrl;
  let started = false;
  let stopped = false;
  let buffer = "";
  let fullText = "";
  let streamedChars = 0;
  let busy = false;
  let flushTimer;
  let lastFlushAt = 0;
  let pendingFlush;

  function scheduleFlush() {
    if (flushTimer !== undefined || stopped) return;
    flushTimer = setTimeoutFn(() => {
      flushTimer = undefined;
      void flushNow().catch(() => {});
    }, flushMs);
  }

  async function flushNow() {
    if (busy || stopped || !canvasId) return;
    if (!buffer) return;
    busy = true;
    const chunk = buffer;
    buffer = "";
    lastFlushAt = now();
    try {
      await client.canvases.edit({
        canvas_id: canvasId,
        changes: [{
          operation: "insert_at_end",
          document_content: { type: "markdown", markdown: chunk },
        }],
      });
      trace("canvas.flushed", { requestId, canvasId, bytes: chunk.length });
    } catch (err) {
      const code = err?.data?.error || err?.code || err?.message;
      // Rate-limit: prepend the chunk back so it goes out on the next flush.
      if (code === "ratelimited" || code === "rate_limited") {
        buffer = chunk + buffer;
        trace("canvas.rate_limited", { requestId, canvasId, retryAfterMs: rateLimitBackoffMs });
        // Re-arm a delayed flush — don't tight-loop.
        if (!stopped) {
          setTimeoutFn(() => { void flushNow().catch(() => {}); }, rateLimitBackoffMs);
        }
      } else {
        trace("canvas.flush_failed", { requestId, canvasId, error: code || "unknown" });
        // For non-ratelimit errors, drop the chunk (it's a best-effort
        // mirror, not the user-visible output — that lives in slack-sink).
      }
    } finally {
      busy = false;
    }
  }

  async function start({ initialText = INITIAL_MARKDOWN } = {}) {
    if (started) throw new Error("canvas-sink: start() called twice");
    started = true;
    try {
      const args = {
        title: `${STREAMING_TITLE_PREFIX}${baseTitle}`.slice(0, 80),
        document_content: { type: "markdown", markdown: initialText },
      };
      // Channel attachment is best-effort: free workspaces require it; paid
      // workspaces accept it as a hint. Standalone canvases (no channel)
      // still work on Pro+; passing channel_id is the safest universal
      // call.
      if (channel) args.channel_id = channel;
      const resp = await client.canvases.create(args);
      canvasId = resp?.canvas_id || resp?.canvas?.id;
      canvasUrl = resp?.canvas?.url || resp?.canvas_url || (canvasId
        ? `https://app.slack.com/docs/${canvasId}`
        : undefined);
      trace("canvas.created", { requestId, canvasId, hasUrl: Boolean(canvasUrl) });
      return canvasId ? { canvasId, url: canvasUrl } : undefined;
    } catch (err) {
      const code = err?.data?.error || err?.message;
      trace("canvas.create_failed", { requestId, error: code || "unknown" });
      // Mark stopped so handle/stop become no-ops.
      stopped = true;
      return undefined;
    }
  }

  function handle(evt) {
    if (!evt || stopped || !canvasId) return;
    if (evt.type !== "message_update" || !evt.assistantMessageEvent) return;
    const ame = evt.assistantMessageEvent;
    if (ame.type !== "text_delta" || typeof ame.delta !== "string" || !ame.delta) return;
    buffer += ame.delta;
    fullText += ame.delta;
    streamedChars += ame.delta.length;
    if (buffer.length >= flushBytes) {
      if (flushTimer !== undefined) {
        clearTimeoutFn(flushTimer);
        flushTimer = undefined;
      }
      pendingFlush = (pendingFlush || Promise.resolve()).then(() => flushNow()).catch(() => {});
    } else {
      scheduleFlush();
    }
  }

  async function stop({ result, error } = {}) {
    if (stopped) return { canvasId, url: canvasUrl, streamedChars, error: null };
    if (flushTimer !== undefined) {
      clearTimeoutFn(flushTimer);
      flushTimer = undefined;
    }
    if (!canvasId) {
      stopped = true;
      return { canvasId: undefined, url: undefined, streamedChars: 0, error: null };
    }
    // Drain BEFORE flipping `stopped` — flushNow() short-circuits when
    // stopped is true, so the final partial buffer would be lost.
    if (pendingFlush) {
      try { await pendingFlush; } catch {}
    }
    if (buffer) {
      try { await flushNow(); } catch {}
    }
    stopped = true;
    // Final pass: replace the streaming fragments with one clean document.
    // Prefer `result` (the cumulative cleaned text from runPi) over our
    // own fullText — runPi strips terminal sequences and is authoritative
    // for the final output. Fall back to fullText if `result` wasn't
    // provided.
    const finalMarkdown = typeof result === "string" && result.length > 0 ? result : fullText;
    if (finalMarkdown) {
      try {
        await client.canvases.edit({
          canvas_id: canvasId,
          changes: [{
            operation: "replace",
            document_content: { type: "markdown", markdown: finalMarkdown },
          }],
        });
        trace("canvas.replaced", { requestId, canvasId, bytes: finalMarkdown.length });
      } catch (err) {
        trace("canvas.replace_failed", { requestId, canvasId, error: err?.data?.error || err?.message || "unknown" });
      }
    }
    // Flip the title to drop the [streaming] prefix.
    try {
      await client.canvases.edit({
        canvas_id: canvasId,
        changes: [{ operation: "rename", title: baseTitle.slice(0, 80) }],
      });
      trace("canvas.renamed", { requestId, canvasId, title: baseTitle });
    } catch (err) {
      // Cosmetic — non-fatal.
      trace("canvas.rename_failed", { requestId, canvasId, error: err?.data?.error || err?.message || "unknown" });
    }
    if (error) {
      // Append an error note so the canvas reader sees that the run was incomplete.
      try {
        await client.canvases.edit({
          canvas_id: canvasId,
          changes: [{
            operation: "insert_at_end",
            document_content: {
              type: "markdown",
              markdown: `\n\n---\n\n_⚠️ Pi encountered an error during this run (req: ${requestId})._`,
            },
          }],
        });
      } catch {}
    }
    return { canvasId, url: canvasUrl, streamedChars, error: null };
  }

  return {
    start,
    handle,
    stop,
    get canvasId() { return canvasId; },
    get url() { return canvasUrl; },
    get started() { return started; },
    get streamedChars() { return streamedChars; },
  };
}
