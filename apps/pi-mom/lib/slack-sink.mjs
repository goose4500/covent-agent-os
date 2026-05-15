// Translates Pi SDK AgentEvents into Slack chat.startStream chunks.
//
// Owns the streaming lifecycle (start → append loop → stop), batches
// text_delta chunks (~200 ms) to stay under Slack's Tier-4 rate limit
// while still feeling live, surfaces tool_execution_* as task_update
// chunks, and emits zero-width-space heartbeats whenever the model goes
// quiet so Slack's stream session (which closes after ~3 min of no
// activity) stays alive across long thinking-level=high runs.
//
// Surface awareness: Assistant chat-tab gets periodic setStatus("is
// thinking…") refreshes so the thinking pill stays warm; app_mention /
// direct_message surfaces use the markdown_text + heartbeat path only.
//
// Streaming "thinking surface":
//   When `planTitle` is supplied, the stream starts with
//   task_display_mode="plan" and emits a `plan_update` chunk so Slack
//   renders Covent Pi's run as a collapsible plan card with tool tasks
//   underneath. Without `planTitle` we keep the legacy timeline layout.
//   See https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks/
//   and chunk.d.ts (PlanUpdateChunk, TaskUpdateChunk).
//
// DI-friendly: tests inject a fake client.chatStream() returning a
// minimal { append, stop } object plus a fake timers pair.

import { formatPiFailureForSlack } from "./failure-summary.mjs";
import { createStreamingRedactor } from "./redaction.mjs";
import { normalizeSlackMarkdown } from "./slack-format.mjs";

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_HEARTBEAT_THRESHOLD_MS = 25_000;
const DEFAULT_APPEND_BATCH_MS = 200;
// Slack's chat.startStream messages reject `chat.appendStream` calls with
// `msg_too_long` once a stream crosses some opaque cumulative cap (observed
// empirically around 11 000 chars). Crucially: a single `msg_too_long`
// during the stream's life poisons the whole stream — `chat.stopStream`
// later finalizes the message as empty in Slack's UI even though the prior
// appends succeeded. So rotation must happen STRICTLY before Slack returns
// any rejection. 9 000 gives ~2 000 chars of headroom for Bolt's 256-char
// buffer + in-flight chain entries + the size of any markdown overhead
// Slack counts on its side.
const DEFAULT_MAX_STREAM_CHARS = 9_000;
const ZERO_WIDTH_SPACE = "​";

export function createSlackSink({
  client,
  channel,
  threadTs,
  recipient,
  surface,
  setStatus,
  requestId,
  planTitle,
  trace = () => {},
  redact = (text) => String(text || ""),
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  heartbeatThresholdMs = DEFAULT_HEARTBEAT_THRESHOLD_MS,
  appendBatchMs = DEFAULT_APPEND_BATCH_MS,
  maxStreamChars = DEFAULT_MAX_STREAM_CHARS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = () => Date.now(),
} = {}) {
  if (typeof client?.chatStream !== "function") {
    throw new Error(
      "Slack WebClient.chatStream is unavailable; upgrade @slack/web-api to a release that exposes the streaming helper.",
    );
  }

  let stream;
  let started = false;
  let stopped = false;
  let streamChain = Promise.resolve();
  let streamError = null;
  let streamedChars = 0;       // cumulative across rotations (for traces / stop)
  let currentStreamChars = 0;  // resets on rotation
  let streamRotations = 0;
  let textBuffer = "";
  let assistantTextChars = 0;
  const textByContentIndex = new Map();
  const streamingRedactor = createStreamingRedactor({ redact });
  let textTimer;
  let heartbeatTimer;
  let lastActivityMs = now();

  function buildStreamArgs() {
    const args = { channel, thread_ts: threadTs };
    if (recipient?.user_id && recipient?.team_id) {
      args.recipient_user_id = recipient.user_id;
      args.recipient_team_id = recipient.team_id;
    }
    // Plan mode collapses tool calls into a single plan card; timeline (the
    // implicit default) renders them inline. We only flip into plan mode
    // when the caller has named the plan.
    if (planTitle) args.task_display_mode = "plan";
    return args;
  }

  async function rotateStream() {
    if (!started || stopped) return;
    streamRotations += 1;
    trace("slack.stream_rotated", {
      requestId,
      streamRotations,
      previousChars: currentStreamChars,
    });
    try { await stream.stop(); } catch {}
    stream = client.chatStream(buildStreamArgs());
    currentStreamChars = 0;
    try {
      await stream.append({ markdown_text: "_…(continued)_\n\n" });
    } catch (err) {
      trace("slack.stream_rotation_marker_failed", {
        requestId,
        error: err?.data?.error || err.message,
      });
    }
  }

  function touch() {
    lastActivityMs = now();
  }

  function appendNow(markdown_text, { normalize = true } = {}) {
    if (!markdown_text) return streamChain;
    const redactedMarkdown = redact(String(markdown_text));
    const safeMarkdown = normalize
      ? normalizeSlackMarkdown(redactedMarkdown, {
          preserveWhitespaceOnly: true,
          preserveOpenLineTrailingSpace: true,
        })
      : redactedMarkdown;
    if (!safeMarkdown) return streamChain;
    // Rotate to a fresh stream before this append if it would push the
    // current stream past Slack's per-message cumulative ceiling. The
    // check uses currentStreamChars (post-rotation counter) so we only
    // rotate once per cycle; streamedChars stays a monotonic total.
    if (started && currentStreamChars + safeMarkdown.length > maxStreamChars) {
      streamChain = streamChain.then(() => rotateStream());
    }
    streamedChars += safeMarkdown.length;
    currentStreamChars += safeMarkdown.length;
    touch();
    streamChain = streamChain
      .then(() => stream.append({ markdown_text: safeMarkdown }))
      .catch((err) => {
        streamError = streamError || err;
        trace("slack.stream_append_error", {
          requestId,
          error: err?.data?.error || err.message,
        });
      });
    return streamChain;
  }

  function appendTaskUpdate(task) {
    touch();
    // Slack's chat.appendStream expects per-event chunks under a `chunks`
    // array. The previous shape (`{ task_update: task }`) was a guess at an
    // older API and silently failed server-side (the catch below swallowed
    // the rejection). See @slack/types chunk.d.ts → TaskUpdateChunk.
    const chunk = { type: "task_update", ...task };
    streamChain = streamChain
      .then(() => stream.append({ chunks: [chunk] }))
      .catch((err) => {
        trace("slack.stream_task_error", {
          requestId,
          error: err?.data?.error || err.message,
          taskId: task?.id,
        });
      });
    return streamChain;
  }

  function appendPlanUpdate(title) {
    if (!title) return streamChain;
    touch();
    streamChain = streamChain
      .then(() => stream.append({ chunks: [{ type: "plan_update", title: String(title) }] }))
      .catch((err) => {
        trace("slack.stream_plan_error", {
          requestId,
          error: err?.data?.error || err.message,
        });
      });
    return streamChain;
  }

  function flushTextBuffer() {
    if (!textBuffer) return;
    const text = textBuffer;
    textBuffer = "";
    const safeText = streamingRedactor.push(text);
    if (safeText) appendNow(safeText);
  }

  function flushRedactionCarry() {
    const tail = streamingRedactor.flush();
    if (tail) appendNow(tail);
  }

  function scheduleFlush() {
    if (textTimer !== undefined) return;
    textTimer = setTimeoutFn(() => {
      textTimer = undefined;
      flushTextBuffer();
    }, appendBatchMs);
  }

  function tickHeartbeat() {
    if (stopped) return;
    const idle = now() - lastActivityMs;
    if (idle >= heartbeatThresholdMs) {
      appendNow(ZERO_WIDTH_SPACE, { normalize: false });
      trace("slack.stream_heartbeat", { requestId, idleMs: idle });
    }
    if (surface === "assistant" && typeof setStatus === "function") {
      Promise.resolve(setStatus("is thinking…")).catch(() => {});
    }
  }

  async function start({ initialText } = {}) {
    if (started) throw new Error("slack-sink: start() called twice");
    started = true;
    const streamArgs = buildStreamArgs();
    stream = client.chatStream(streamArgs);
    trace("slack.stream_started", {
      requestId,
      hasRecipient: Boolean(streamArgs.recipient_user_id),
      surface,
      planMode: Boolean(planTitle),
    });
    if (planTitle) {
      appendPlanUpdate(planTitle);
      await streamChain;
    }
    if (initialText) {
      appendNow(initialText);
      await streamChain;
    }
    heartbeatTimer = setIntervalFn(tickHeartbeat, heartbeatMs);
    touch();
  }

  function handle(evt) {
    if (!evt || stopped) return;
    if (evt.type === "message_update" && evt.assistantMessageEvent) {
      const ame = evt.assistantMessageEvent;
      if (ame.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
        const key = ame.contentIndex ?? "default";
        textByContentIndex.set(key, `${textByContentIndex.get(key) || ""}${ame.delta}`);
        assistantTextChars += ame.delta.length;
        textBuffer += ame.delta;
        touch();
        scheduleFlush();
      } else if (ame.type === "text_end") {
        const content = typeof ame.content === "string" ? ame.content : "";
        if (content) {
          const key = ame.contentIndex ?? "default";
          const seen = textByContentIndex.get(key) || "";
          let missing = "";
          if (!seen) missing = content;
          else if (content.startsWith(seen) && content.length > seen.length) missing = content.slice(seen.length);
          if (missing) {
            assistantTextChars += missing.length;
            textBuffer += missing;
            touch();
            scheduleFlush();
          }
          textByContentIndex.set(key, content);
        }
      }
    } else if (evt.type === "tool_execution_start") {
      const toolCallId = evt.toolCallId || evt.toolCall?.toolCallId || evt.toolCall?.id || `tool_${streamedChars}`;
      const toolName = evt.toolName || evt.toolCall?.toolName || "tool";
      appendTaskUpdate({
        id: toolCallId,
        title: toolName,
        status: "in_progress",
      });
    } else if (evt.type === "tool_execution_end") {
      const toolCallId = evt.toolCallId || evt.toolCall?.toolCallId || evt.toolCall?.id || `tool_${streamedChars}`;
      const toolName = evt.toolName || evt.toolCall?.toolName || "tool";
      appendTaskUpdate({
        id: toolCallId,
        title: toolName,
        status: evt.isError || evt.error || evt.toolCall?.errorMessage ? "error" : "complete",
      });
    }
  }

  async function appendMarkdown(markdown = "") {
    if (!markdown || !started || stopped) return { appended: false };
    if (textTimer !== undefined) {
      clearTimeoutFn(textTimer);
      textTimer = undefined;
    }
    flushTextBuffer();
    flushRedactionCarry();
    appendNow(String(markdown));
    await streamChain;
    return { appended: true };
  }

  async function stop({ result, error } = {}) {
    if (stopped) return { streamedChars, error: streamError, started };
    stopped = true;
    // Don't use truthiness — timer IDs can be 0 in some runtimes (and in our
    // DI'd fake-timer tests). Compare against undefined explicitly.
    if (textTimer !== undefined) {
      clearTimeoutFn(textTimer);
      textTimer = undefined;
    }
    if (heartbeatTimer !== undefined) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    flushTextBuffer();
    flushRedactionCarry();
    const finalResult = typeof result === "string" ? result : "";
    if (started && !error && finalResult && assistantTextChars === 0) {
      appendNow(finalResult);
      assistantTextChars += finalResult.length;
    }
    await streamChain;
    if (started && error) {
      try {
        const failureText = formatPiFailureForSlack({ error, requestId, redact });
        streamChain = streamChain.then(() =>
          stream.append({ markdown_text: `\n\n${failureText}` }),
        );
        await streamChain;
        if (error && typeof error === "object") error.slackStreamNotified = true;
      } catch (err) {
        trace("slack.stream_error_append_failed", {
          requestId,
          error: err?.data?.error || err.message,
        });
      }
    }
    if (started) {
      try {
        await stream.stop();
        trace("slack.stream_stopped", {
          requestId,
          streamedChars,
          resultLength: result?.length || 0,
        });
      } catch (err) {
        trace("slack.stream_stop_error", {
          requestId,
          error: err?.data?.error || err.message,
        });
      }
    }
    return { streamedChars, error: streamError, started };
  }

  return {
    start,
    handle,
    stop,
    appendMarkdown,
    updatePlan: appendPlanUpdate,
    get streamError() { return streamError; },
    get streamedChars() { return streamedChars; },
    get started() { return started; },
  };
}
