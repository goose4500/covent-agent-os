import assert from "node:assert/strict";
import { createSlackSink } from "./lib/slack-sink.mjs";

function makeFakeStream() {
  const appends = [];
  const stopCalls = [];
  return {
    appends,
    stopCalls,
    async append(chunk) { appends.push(chunk); },
    async stop() { stopCalls.push(true); },
  };
}

function makeFakeClient({ streamFactory } = {}) {
  return { chatStream: streamFactory || ((args) => { const s = makeFakeStream(); s._args = args; return s; }) };
}

function makeFakeTimers() {
  const timers = [];
  let nowMs = 0;
  return {
    timers,
    setTimeoutFn: (fn, ms) => { const id = timers.length; timers.push({ fn, ms, kind: "to", cleared: false }); return id; },
    clearTimeoutFn: (id) => { if (timers[id]) timers[id].cleared = true; },
    setIntervalFn: (fn, ms) => { const id = timers.length; timers.push({ fn, ms, kind: "iv", cleared: false }); return id; },
    clearIntervalFn: (id) => { if (timers[id]) timers[id].cleared = true; },
    fireTimer: async (id) => { const t = timers[id]; if (t && !t.cleared) await t.fn(); },
    now: () => nowMs,
    advance: (delta) => { nowMs += delta; },
  };
}

// Case 1: start posts initial markdown_text, handle batches text_delta into a single append.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C1", threadTs: "1.0",
    surface: "app_mention", requestId: "req_t1",
    appendBatchMs: 100, heartbeatMs: 1000, heartbeatThresholdMs: 800,
    ...T,
  });

  await sink.start({ initialText: "thinking…" });
  assert.deepEqual(fakeStream.appends[0], { markdown_text: "thinking…" });

  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
  // The flush timer is queued; nothing appended yet.
  assert.equal(fakeStream.appends.length, 1, "deltas buffered, not flushed yet");
  // Fire the batched flush.
  await T.fireTimer(T.timers[T.timers.length - 2].cleared ? T.timers.length - 1 : T.timers.length - 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fakeStream.appends[1], { markdown_text: "hello world" }, "batched flush emits combined text");
}

// Case 2: tool_execution_start / _end emit task_update chunks via chunks[]
// (Slack's chat.appendStream contract).
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C2", threadTs: "2.0",
    surface: "app_mention", requestId: "req_t2", ...T,
  });
  await sink.start({});
  sink.handle({ type: "tool_execution_start", toolCall: { toolCallId: "tc1", toolName: "read" } });
  sink.handle({ type: "tool_execution_end", toolCall: { toolCallId: "tc1", toolName: "read" } });
  await new Promise((r) => setImmediate(r));
  const taskChunks = fakeStream.appends
    .filter((a) => Array.isArray(a.chunks))
    .flatMap((a) => a.chunks)
    .filter((c) => c.type === "task_update");
  assert.equal(taskChunks.length, 2, "two task_update chunks");
  assert.equal(taskChunks[0].status, "in_progress");
  assert.equal(taskChunks[1].status, "complete");
  assert.equal(taskChunks[0].id, "tc1");
  assert.equal(taskChunks[0].title, "read");
}

// Case 2a: actual SDK top-level tool_execution_* fields also emit task updates.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C2a", threadTs: "2.05",
    surface: "app_mention", requestId: "req_t2a", ...T,
  });
  await sink.start({});
  sink.handle({ type: "tool_execution_start", toolCallId: "tc2", toolName: "grep" });
  sink.handle({ type: "tool_execution_end", toolCallId: "tc2", toolName: "grep", isError: true });
  await new Promise((r) => setImmediate(r));
  const taskChunks = fakeStream.appends
    .filter((a) => Array.isArray(a.chunks))
    .flatMap((a) => a.chunks)
    .filter((c) => c.type === "task_update");
  assert.equal(taskChunks.length, 2, "two task_update chunks for top-level SDK shape");
  assert.equal(taskChunks[0].id, "tc2");
  assert.equal(taskChunks[0].title, "grep");
  assert.equal(taskChunks[1].status, "error");
}

// Case 2b: subagent task cards display specific agent families when args identify them.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C2b", threadTs: "2.1",
    surface: "app_mention", requestId: "req_t2b", ...T,
  });
  await sink.start({});
  sink.handle({ type: "tool_execution_start", toolCallId: "tc_kimi", toolName: "subagent", args: { agent: "kimi-analyst" } });
  // End events may omit args; keep the title selected at start for the same tool call.
  sink.handle({ type: "tool_execution_end", toolCallId: "tc_kimi", toolName: "subagent" });
  sink.handle({
    type: "tool_execution_start",
    toolCall: {
      toolCallId: "tc_gemini",
      toolName: "subagent",
      arguments: JSON.stringify({ tasks: [{ agent: "gemini-reviewer", task: "Review this" }] }),
    },
  });
  sink.handle({ type: "tool_execution_end", toolCall: { toolCallId: "tc_gemini", toolName: "subagent" } });
  sink.handle({ type: "tool_execution_start", toolCallId: "tc_general", toolName: "subagent", args: { action: "list" } });
  await new Promise((r) => setImmediate(r));
  const taskChunks = fakeStream.appends
    .filter((a) => Array.isArray(a.chunks))
    .flatMap((a) => a.chunks)
    .filter((c) => c.type === "task_update");
  assert.equal(taskChunks.find((c) => c.id === "tc_kimi" && c.status === "in_progress")?.title, "kimi-agent");
  assert.equal(taskChunks.find((c) => c.id === "tc_kimi" && c.status === "complete")?.title, "kimi-agent");
  assert.equal(taskChunks.find((c) => c.id === "tc_gemini" && c.status === "in_progress")?.title, "gemini-agent");
  assert.equal(taskChunks.find((c) => c.id === "tc_general" && c.status === "in_progress")?.title, "subagent");
}

// Case 2c: planTitle opts the stream into plan mode + emits a plan_update.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: (args) => { fakeStream._args = args; return fakeStream; } });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C2b", threadTs: "2.1",
    surface: "app_mention", requestId: "req_t2b",
    planTitle: "Covent Pi · Spec / PRD draft", ...T,
  });
  await sink.start({});
  // chatStream() was called with task_display_mode="plan".
  assert.equal(fakeStream._args?.task_display_mode, "plan");
  // First append carries a plan_update chunk with the supplied title.
  const planChunks = fakeStream.appends
    .filter((a) => Array.isArray(a.chunks))
    .flatMap((a) => a.chunks)
    .filter((c) => c.type === "plan_update");
  assert.equal(planChunks.length, 1, "one plan_update chunk emitted at start");
  assert.equal(planChunks[0].title, "Covent Pi · Spec / PRD draft");
  // Caller can update the plan mid-run via the exposed helper.
  await sink.updatePlan("Covent Pi · Spec / PRD draft (revising)");
  const after = fakeStream.appends
    .filter((a) => Array.isArray(a.chunks))
    .flatMap((a) => a.chunks)
    .filter((c) => c.type === "plan_update");
  assert.equal(after.length, 2);
  assert.match(after[1].title, /revising/);
}

// Case 3: heartbeat emits a zero-width-space when idle exceeds threshold.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C3", threadTs: "3.0",
    surface: "app_mention", requestId: "req_t3",
    heartbeatMs: 1000, heartbeatThresholdMs: 800,
    ...T,
  });
  await sink.start({});
  // No activity for 1000 ms.
  T.advance(1000);
  // Fire the heartbeat interval timer.
  const heartbeatTimer = T.timers.find((t) => t.kind === "iv" && !t.cleared);
  await heartbeatTimer.fn();
  await new Promise((r) => setImmediate(r));
  const hbAppend = fakeStream.appends.find((a) => a.markdown_text === "​");
  assert.ok(hbAppend, "heartbeat appended zero-width space");
}

// Case 4: heartbeat does NOT fire if recent activity within threshold.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C4", threadTs: "4.0",
    surface: "app_mention", requestId: "req_t4",
    heartbeatMs: 1000, heartbeatThresholdMs: 800,
    ...T,
  });
  await sink.start({});
  T.advance(500);
  // Simulate recent activity.
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
  T.advance(100); // total 600ms idle (under 800ms threshold)
  const heartbeatTimer = T.timers.find((t) => t.kind === "iv" && !t.cleared);
  await heartbeatTimer.fn();
  await new Promise((r) => setImmediate(r));
  const hbAppend = fakeStream.appends.find((a) => a.markdown_text === "​");
  assert.equal(hbAppend, undefined, "no heartbeat when activity is fresh");
}

// Case 5: surface=assistant calls setStatus during heartbeat.
{
  const setStatusCalls = [];
  const setStatus = async (s) => { setStatusCalls.push(s); };
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client: makeFakeClient(),
    channel: "C5", threadTs: "5.0",
    surface: "assistant", setStatus, requestId: "req_t5",
    heartbeatMs: 1000, heartbeatThresholdMs: 800,
    ...T,
  });
  await sink.start({});
  T.advance(1000);
  const heartbeatTimer = T.timers.find((t) => t.kind === "iv" && !t.cleared);
  await heartbeatTimer.fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(setStatusCalls, ["is thinking…"], "assistant surface refreshes setStatus on heartbeat");
}

// Case 6: stop({result}) clears timers, flushes buffer, calls stream.stop().
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C6", threadTs: "6.0",
    surface: "app_mention", requestId: "req_t6", ...T,
  });
  await sink.start({});
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "buffered" } });
  // stop should flush the buffered text BEFORE closing the stream.
  await sink.stop({ result: "buffered" });
  const flushed = fakeStream.appends.find((a) => a.markdown_text === "buffered");
  assert.ok(flushed, "buffered text flushed at stop");
  assert.equal(fakeStream.stopCalls.length, 1, "stream.stop called once");
  // The heartbeat interval must be cleared so it doesn't tick post-stop.
  const intervals = T.timers.filter((t) => t.kind === "iv");
  assert.equal(intervals.length, 1, "exactly one heartbeat interval set during start()");
  assert.equal(intervals[0].cleared, true, "heartbeat interval cleared by stop()");
}

// Case 6a: text_end-only SDK output is appended before stop.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C6a", threadTs: "6.1",
    surface: "app_mention", requestId: "req_t6a", ...T,
  });
  await sink.start({ initialText: "thinking…" });
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "final via text_end" } });
  await sink.stop({ result: "final via text_end" });
  const markdown = fakeStream.appends.map((a) => a.markdown_text).filter(Boolean);
  const joined = markdown.join("");
  assert.ok(joined.includes("final via text_end"), "text_end-only final text appended");
  assert.equal((joined.match(/final via text_end/g) || []).length, 1, "text_end final text is not duplicated");
}

// Case 6b: stop({result}) appends final result when no assistant text streamed.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C6b", threadTs: "6.2",
    surface: "app_mention", requestId: "req_t6b", ...T,
  });
  await sink.start({ initialText: "thinking…" });
  await sink.stop({ result: "final fallback answer" });
  const markdown = fakeStream.appends.map((a) => a.markdown_text).filter(Boolean);
  assert.ok(markdown.includes("final fallback answer"), "final result fallback appended before stop");
}

// Case 7: stop({error}) appends a structured, actionable error chunk + marks error.slackStreamNotified.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C7", threadTs: "7.0",
    surface: "app_mention", requestId: "req_t7", ...T,
  });
  await sink.start({});
  const err = new Error("Pi timed out after 180000ms");
  await sink.stop({ error: err });
  const errAppend = fakeStream.appends.find((a) =>
    typeof a.markdown_text === "string" && a.markdown_text.includes("Pi run failed"),
  );
  assert.ok(errAppend, "structured error chunk appended on failure");
  assert.match(errAppend.markdown_text, /req_t7/);
  assert.match(errAppend.markdown_text, /category: `timeout`/);
  assert.match(errAppend.markdown_text, /try next:/);
  assert.equal(err.slackStreamNotified, true, "error tagged slackStreamNotified");
}

// Case 8: stream rotation when cumulative text exceeds maxStreamChars.
{
  const streams = [];
  const client = {
    chatStream: (args) => {
      const s = makeFakeStream();
      s._args = args;
      streams.push(s);
      return s;
    },
  };
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client,
    channel: "C8",
    threadTs: "8.0",
    recipient: { user_id: "U1", team_id: "T1" },
    surface: "app_mention",
    requestId: "req_t8",
    maxStreamChars: 100,
    appendBatchMs: 1,
    ...T,
  });

  await sink.start({ initialText: "x".repeat(30) });
  // Now push ~150 more chars; should trigger rotation before exceeding cap.
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y".repeat(80) } });
  // fire flush timer for first batch
  const t1 = T.timers.find((t) => t.kind === "to" && !t.cleared);
  if (t1) await t1.fn();
  await new Promise((r) => setImmediate(r));
  // push another batch that forces rotation
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "z".repeat(80) } });
  const t2 = T.timers.find((t) => t.kind === "to" && !t.cleared);
  if (t2) await t2.fn();
  await new Promise((r) => setImmediate(r));
  await sink.stop({ result: "done" });

  assert.ok(streams.length >= 2, `expected ≥ 2 chatStream calls, saw ${streams.length}`);
  // Second stream should have the same thread + recipient.
  assert.equal(streams[1]._args.thread_ts, "8.0");
  assert.equal(streams[1]._args.recipient_user_id, "U1");
  // Second stream should have received the continuation marker.
  const continuationMarker = streams[1].appends.find(
    (a) => typeof a.markdown_text === "string" && a.markdown_text.includes("continued"),
  );
  assert.ok(continuationMarker, "second stream received continuation marker");
}

// Case 9: appendMarkdown flushes any buffered text and appends while the stream is open.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C9", threadTs: "9.0",
    surface: "app_mention", requestId: "req_t9",
    appendBatchMs: 1000, ...T,
  });
  await sink.start({});
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "parent answer" } });
  await sink.appendMarkdown("\n\n---\n*Subagent canvases*\n• <https://example.test|team-scout — completed>\n");
  assert.deepEqual(fakeStream.appends.map((a) => a.markdown_text).filter(Boolean), [
    "parent answer",
    "\n\n---\n*Subagent canvases*\n• <https://example.test|team-scout — completed>\n",
  ]);
  await sink.stop({ result: "done" });
  assert.equal(fakeStream.stopCalls.length, 1);
}

// Case 9b: outbound markdown is redacted for initial, streamed, and footer text.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const redact = (text) => String(text).replaceAll("SECRET", "[REDACTED]");
  const sink = createSlackSink({
    client, channel: "C9b", threadTs: "9.1",
    surface: "app_mention", requestId: "req_t9b",
    appendBatchMs: 100, redact, ...T,
  });
  await sink.start({ initialText: "initial SECRET" });
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stream SECRET" } });
  const flushTimer = T.timers.find((t) => t.kind === "to" && !t.cleared);
  if (flushTimer) await flushTimer.fn();
  await sink.appendMarkdown("footer SECRET");
  await sink.stop({ result: "done" });
  const markdown = fakeStream.appends.map((a) => a.markdown_text).filter(Boolean).join("\n");
  assert.ok(!markdown.includes("SECRET"), "raw secret-like text not sent to Slack stream");
  assert.ok(markdown.includes("[REDACTED]"), "redacted marker appears");
}

// Case 9c: streaming redaction carries suspicious partial token prefixes across flushes.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C9c", threadTs: "9.2",
    surface: "app_mention", requestId: "req_t9c",
    appendBatchMs: 1,
    redact: (text) => String(text)
      .replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-[REDACTED]")
      .replace(/ghp_[A-Za-z0-9_]+/g, "gh[REDACTED]"),
    ...T,
  });
  await sink.start({});
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "sk" } });
  let flushTimer = T.timers.find((t) => t.kind === "to" && !t.cleared);
  if (flushTimer) await flushTimer.fn();
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "-proj-secretvalue " } });
  flushTimer = T.timers.find((t) => t.kind === "to" && !t.cleared);
  if (flushTimer) await flushTimer.fn();

  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ghp" } });
  flushTimer = T.timers.find((t) => t.kind === "to" && !t.cleared);
  if (flushTimer) await flushTimer.fn();
  sink.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "_secretvalue " } });
  flushTimer = T.timers.find((t) => t.kind === "to" && !t.cleared);
  if (flushTimer) await flushTimer.fn();
  await sink.stop({ result: "done" });
  const markdown = fakeStream.appends.map((a) => a.markdown_text).filter(Boolean).join("\n");
  assert.ok(!markdown.includes("sk-proj-secretvalue"), "split token is never posted raw");
  assert.ok(markdown.includes("sk-proj-[REDACTED]"), "split token is redacted after suffix arrives");
  assert.ok(!markdown.includes("ghp_secretvalue"), "split GitHub token is never posted raw");
  assert.ok(markdown.includes("gh[REDACTED]"), "split GitHub token is redacted after suffix arrives");
}

// Case 10: missing client.chatStream throws at factory time.
{
  assert.throws(
    () => createSlackSink({ client: {}, channel: "C", threadTs: "0", requestId: "x" }),
    /chatStream/,
  );
}

console.log("slack-sink tests passed");
