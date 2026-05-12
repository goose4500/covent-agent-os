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
// DI-friendly: tests inject a fake client.chatStream() returning a
// minimal { append, stop } object plus a fake timers pair.

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_HEARTBEAT_THRESHOLD_MS = 25_000;
const DEFAULT_APPEND_BATCH_MS = 200;
// Slack's chat.startStream messages cap at ~12 000 chars of cumulative
// markdown_text; appendStream rejects with msg_too_long past that and the
// whole stream message can fail-closed empty. Rotate to a new stream a bit
// under that ceiling so the user always sees their reply.
const DEFAULT_MAX_STREAM_CHARS = 11_000;
const ZERO_WIDTH_SPACE = "​";

export function createSlackSink({
  client,
  channel,
  threadTs,
  recipient,
  surface,
  setStatus,
  requestId,
  trace = () => {},
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
  let textTimer;
  let heartbeatTimer;
  let lastActivityMs = now();

  function buildStreamArgs() {
    const args = { channel, thread_ts: threadTs };
    if (recipient?.user_id && recipient?.team_id) {
      args.recipient_user_id = recipient.user_id;
      args.recipient_team_id = recipient.team_id;
    }
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

  function appendNow(markdown_text) {
    if (!markdown_text) return streamChain;
    // Rotate to a fresh stream before this append if it would push the
    // current stream past Slack's per-message cumulative ceiling. The
    // check uses currentStreamChars (post-rotation counter) so we only
    // rotate once per cycle; streamedChars stays a monotonic total.
    if (started && currentStreamChars + markdown_text.length > maxStreamChars) {
      streamChain = streamChain.then(() => rotateStream());
    }
    streamedChars += markdown_text.length;
    currentStreamChars += markdown_text.length;
    touch();
    streamChain = streamChain
      .then(() => stream.append({ markdown_text }))
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
    streamChain = streamChain
      .then(() => stream.append({ task_update: task }))
      .catch((err) => {
        trace("slack.stream_task_error", {
          requestId,
          error: err?.data?.error || err.message,
          taskId: task?.id,
        });
      });
    return streamChain;
  }

  function flushTextBuffer() {
    if (!textBuffer) return;
    const text = textBuffer;
    textBuffer = "";
    appendNow(text);
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
      appendNow(ZERO_WIDTH_SPACE);
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
    });
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
        textBuffer += ame.delta;
        touch();
        scheduleFlush();
      }
    } else if (evt.type === "tool_execution_start" && evt.toolCall) {
      appendTaskUpdate({
        id: evt.toolCall.toolCallId || evt.toolCall.id || `tool_${streamedChars}`,
        title: evt.toolCall.toolName || "tool",
        status: "in_progress",
      });
    } else if (evt.type === "tool_execution_end" && evt.toolCall) {
      appendTaskUpdate({
        id: evt.toolCall.toolCallId || evt.toolCall.id || `tool_${streamedChars}`,
        title: evt.toolCall.toolName || "tool",
        status: evt.error || evt.toolCall?.errorMessage ? "failed" : "complete",
      });
    }
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
    await streamChain;
    if (started && error) {
      try {
        streamChain = streamChain.then(() =>
          stream.append({
            markdown_text: `\n\nPi encountered an error (req: ${requestId}). Check the pi-mom terminal for details.`,
          }),
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
    get streamError() { return streamError; },
    get streamedChars() { return streamedChars; },
    get started() { return started; },
  };
}
