import assert from "node:assert/strict";
import { createCanvasSink } from "./lib/canvas-sink.mjs";

function makeFakeClient({ createImpl, editImpl } = {}) {
  const creates = [];
  const edits = [];
  return {
    creates,
    edits,
    canvases: {
      create: async (args) => {
        creates.push(args);
        if (createImpl) return createImpl(args, creates.length);
        return { ok: true, canvas_id: `canvas_${creates.length}`, canvas: { id: `canvas_${creates.length}`, url: `https://app.slack.com/docs/T1/canvas_${creates.length}` } };
      },
      edit: async (args) => {
        edits.push(args);
        if (editImpl) return editImpl(args, edits.length);
        return { ok: true };
      },
    },
  };
}

function makeFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn: (fn, ms) => { const id = timers.length; timers.push({ id, fn, ms, cleared: false }); return id; },
    clearTimeoutFn: (id) => { if (timers[id]) timers[id].cleared = true; },
    fire: async (id) => { const t = timers[id]; if (t && !t.cleared) await t.fn(); },
    fireAll: async () => {
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t && !t.cleared) await t.fn();
      }
    },
  };
}

const delta = (text) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });

// Case 1: start() creates a canvas with [streaming] title prefix and returns id+url.
{
  const client = makeFakeClient();
  const T = makeFakeTimers();
  const sink = createCanvasSink({
    client, channel: "C1", title: "Spec draft", requestId: "req_c1", ...T,
  });
  const out = await sink.start({});
  assert.equal(out.canvasId, "canvas_1");
  assert.equal(out.url, "https://app.slack.com/docs/T1/canvas_1");
  assert.equal(sink.canvasId, "canvas_1");
  assert.equal(client.creates.length, 1);
  assert.match(client.creates[0].title, /^\[streaming\] /);
  assert.match(client.creates[0].title, /Spec draft$/);
  assert.equal(client.creates[0].channel_id, "C1");
  assert.equal(client.creates[0].document_content.type, "markdown");
}

// Case 2: handle text_delta buffers until flushMs timer fires → insert_at_end.
{
  const client = makeFakeClient();
  const T = makeFakeTimers();
  const sink = createCanvasSink({
    client, channel: "C2", title: "Spec",
    requestId: "req_c2", flushMs: 3000, flushBytes: 10000, ...T,
  });
  await sink.start({});
  sink.handle(delta("hello "));
  sink.handle(delta("world"));
  assert.equal(client.edits.length, 0, "no flush until timer fires");
  await T.fireAll();
  await new Promise((r) => setImmediate(r));
  assert.equal(client.edits.length, 1, "single insert_at_end after timer");
  const edit = client.edits[0];
  assert.equal(edit.canvas_id, "canvas_1");
  assert.equal(edit.changes[0].operation, "insert_at_end");
  assert.equal(edit.changes[0].document_content.markdown, "hello world");
}

// Case 3: byte threshold triggers immediate flush (no waiting on timer).
{
  const client = makeFakeClient();
  const T = makeFakeTimers();
  const sink = createCanvasSink({
    client, channel: "C3", title: "Spec",
    requestId: "req_c3", flushMs: 60_000, flushBytes: 20, ...T,
  });
  await sink.start({});
  sink.handle(delta("a".repeat(25)));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(client.edits.length, 1, "byte threshold flushed immediately");
  assert.equal(client.edits[0].changes[0].document_content.markdown.length, 25);
}

// Case 4: rate-limit error re-queues the chunk and schedules a backoff retry.
{
  let editCalls = 0;
  const client = makeFakeClient({
    editImpl: async () => {
      editCalls += 1;
      if (editCalls === 1) {
        const err = new Error("ratelimited");
        err.data = { error: "ratelimited" };
        throw err;
      }
      return { ok: true };
    },
  });
  const T = makeFakeTimers();
  const sink = createCanvasSink({
    client, channel: "C4", title: "Spec",
    requestId: "req_c4", flushMs: 1000, flushBytes: 5,
    rateLimitBackoffMs: 200, ...T,
  });
  await sink.start({});
  sink.handle(delta("hi there"));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(client.edits.length, 1, "first flush attempted");
  // Fire the rate-limit backoff timer (the last setTimeout call).
  const backoffTimer = T.timers[T.timers.length - 1];
  await backoffTimer.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(client.edits.length, 2, "second flush after backoff");
  assert.equal(client.edits[1].changes[0].document_content.markdown, "hi there", "full chunk re-queued, no data lost");
}

// Case 5: stop() drains buffer, sends replace with full text, then rename to clean title.
{
  const client = makeFakeClient();
  const T = makeFakeTimers();
  const sink = createCanvasSink({
    client, channel: "C5", title: "Spec",
    requestId: "req_c5", flushMs: 1000, flushBytes: 10000, ...T,
  });
  await sink.start({});
  sink.handle(delta("part one. "));
  sink.handle(delta("part two."));
  await sink.stop({ result: "Final cleaned markdown for the spec." });

  // edits[0] = the drained buffer (insert_at_end)
  // edits[1] = the replace with the result
  // edits[2] = the rename
  assert.equal(client.edits.length, 3);
  assert.equal(client.edits[0].changes[0].operation, "insert_at_end");
  assert.equal(client.edits[1].changes[0].operation, "replace");
  assert.equal(client.edits[1].changes[0].document_content.markdown, "Final cleaned markdown for the spec.");
  assert.equal(client.edits[2].changes[0].operation, "rename");
  assert.equal(client.edits[2].changes[0].title, "Spec");
}

// Case 6: stop() falls back to accumulated fullText when result is omitted.
{
  const client = makeFakeClient();
  const T = makeFakeTimers();
  const sink = createCanvasSink({
    client, channel: "C6", title: "Spec",
    requestId: "req_c6", flushMs: 1000, flushBytes: 10000, ...T,
  });
  await sink.start({});
  sink.handle(delta("only "));
  sink.handle(delta("fullText "));
  sink.handle(delta("survives."));
  await sink.stop({});
  const replaceEdit = client.edits.find((e) => e.changes[0].operation === "replace");
  assert.ok(replaceEdit, "replace op fired");
  assert.equal(replaceEdit.changes[0].document_content.markdown, "only fullText survives.");
}

// Case 7: stop({error}) appends an error note as a final insert_at_end.
{
  const client = makeFakeClient();
  const T = makeFakeTimers();
  const sink = createCanvasSink({
    client, channel: "C7", title: "Spec",
    requestId: "req_c7", flushMs: 1000, flushBytes: 10000, ...T,
  });
  await sink.start({});
  sink.handle(delta("partial output"));
  await sink.stop({ error: new Error("Pi blew up") });
  const errEdit = client.edits.find(
    (e) => e.changes[0].operation === "insert_at_end" &&
           /encountered an error/i.test(String(e.changes[0].document_content?.markdown || "")),
  );
  assert.ok(errEdit, "error note appended");
  assert.match(errEdit.changes[0].document_content.markdown, /req_c7/);
}

// Case 8: canvases.create failure → start returns undefined, handle/stop are no-ops.
{
  const client = makeFakeClient({
    createImpl: async () => {
      const err = new Error("not_authed");
      err.data = { error: "not_authed" };
      throw err;
    },
  });
  const T = makeFakeTimers();
  const sink = createCanvasSink({
    client, channel: "C8", title: "Spec",
    requestId: "req_c8", ...T,
  });
  const out = await sink.start({});
  assert.equal(out, undefined, "start returns undefined on failure");
  sink.handle(delta("never makes it"));
  await sink.stop({ result: "irrelevant" });
  assert.equal(client.edits.length, 0, "no edits after failed create");
}

// Case 9: missing canvases methods throws at factory time.
{
  assert.throws(() => createCanvasSink({
    client: {},
    channel: "C9", title: "Spec", requestId: "req_c9",
  }), /canvases/);
  assert.throws(() => createCanvasSink({
    client: { canvases: { create: () => {} } }, // missing edit
    channel: "C9b", title: "Spec", requestId: "req_c9b",
  }), /canvases/);
}

// Case 10: title is clamped to Slack's 80-char canvas title limit.
{
  const client = makeFakeClient();
  const T = makeFakeTimers();
  const longTitle = "a".repeat(120);
  const sink = createCanvasSink({
    client, channel: "C10", title: longTitle,
    requestId: "req_c10", ...T,
  });
  await sink.start({});
  await sink.stop({ result: "x" });
  assert.ok(client.creates[0].title.length <= 80, "create title clamped");
  const rename = client.edits.find((e) => e.changes[0].operation === "rename");
  assert.ok(rename.changes[0].title.length <= 80, "rename title clamped");
}

console.log("canvas-sink tests passed");
