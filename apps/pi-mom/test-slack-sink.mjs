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

// Case 2: tool_execution_start / _end emit task_update chunks with status.
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
  const tasks = fakeStream.appends.filter((a) => a.task_update);
  assert.equal(tasks.length, 2, "two task_update chunks");
  assert.equal(tasks[0].task_update.status, "in_progress");
  assert.equal(tasks[1].task_update.status, "complete");
  assert.equal(tasks[0].task_update.id, "tc1");
  assert.equal(tasks[0].task_update.title, "read");
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

// Case 7: stop({error}) appends error chunk + marks error.slackStreamNotified.
{
  const fakeStream = makeFakeStream();
  const client = makeFakeClient({ streamFactory: () => fakeStream });
  const T = makeFakeTimers();
  const sink = createSlackSink({
    client, channel: "C7", threadTs: "7.0",
    surface: "app_mention", requestId: "req_t7", ...T,
  });
  await sink.start({});
  const err = new Error("boom");
  await sink.stop({ error: err });
  const errAppend = fakeStream.appends.find((a) =>
    typeof a.markdown_text === "string" && a.markdown_text.includes("Pi encountered an error"),
  );
  assert.ok(errAppend, "error chunk appended on failure");
  assert.equal(err.slackStreamNotified, true, "error tagged slackStreamNotified");
}

// Case 8: missing client.chatStream throws at factory time.
{
  assert.throws(
    () => createSlackSink({ client: {}, channel: "C", threadTs: "0", requestId: "x" }),
    /chatStream/,
  );
}

console.log("slack-sink tests passed");
