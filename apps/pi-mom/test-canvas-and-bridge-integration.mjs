// Integration tests for the new Stage A wiring exposed via ctx.ui:
//   - ui.startCanvas (called by the slack_canvas_start tool)
//   - ui.stopCanvas  (called by the slack_canvas_finish tool)
//   - ui.bridgeHelp  (called by the bridge_help tool)
//   - ui.bridgeStatus (called by the bridge_status tool)
//
// These exercise the real `createSlackUIContext` against a real composite-sink
// and a stub canvas-sink factory, so the production code paths the tools
// invoke are fully covered. The tools themselves are .ts SDK extensions that
// just unwrap the ctx.ui call, so testing the closures covers the wiring
// end-to-end short of an actual Pi SDK round-trip.

import assert from "node:assert/strict";
import { createCompositeSink } from "./lib/composite-sink.mjs";
import { createSlackUIContext } from "./lib/slack-ui-context.mjs";

function makeFakeClient() {
  const postMessages = [];
  return {
    postMessages,
    chat: {
      postMessage: async (args) => {
        const ts = `${(postMessages.length + 1).toString().padStart(3, "0")}.0`;
        postMessages.push({ ...args, ts });
        return { ok: true, ts, channel: args.channel };
      },
      update: async () => ({ ok: true }),
    },
    views: { open: async () => ({ ok: true }) },
    // The canCanvas gate in slack-ui-context checks for client.canvases.create.
    // We don't actually call it (the canvas-sink is faked), but it has to be
    // a function for the gate to allow startCanvas to proceed.
    canvases: { create: async () => ({ ok: true }) },
  };
}

function makeFakeCanvasSinkFactory({ canvasId = "F_FAKE_CANVAS", url = "https://slack/canvas/fake" } = {}) {
  const created = [];
  const events = [];
  let stopped = false;
  function factory(opts) {
    const sink = {
      canvasId,
      url,
      _opts: opts,
      async start(start) { sink._started = start || null; return { canvasId, url }; },
      handle(event) { events.push(event); },
      async stop(stopArgs) {
        stopped = true;
        sink._stoppedWith = stopArgs;
        return { canvasId, url, streamedChars: 1234 };
      },
    };
    created.push(sink);
    return sink;
  }
  factory.created = created;
  factory.events = events;
  factory.isStopped = () => stopped;
  return factory;
}

function makeFakeSlackSink() {
  const events = [];
  return {
    events,
    async start() {},
    handle(event) { events.push(event); },
    async stop() {},
  };
}

// ---------- case 1: startCanvas creates+attaches a sink, posts link, returns ok ----------
{
  const client = makeFakeClient();
  const slackSink = makeFakeSlackSink();
  const composite = createCompositeSink([slackSink]);
  const canvasFactory = makeFakeCanvasSinkFactory();
  const traces = [];
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c1",
    pendingApprovals: new Map(), surface: "app_mention",
    trace: (event, data) => traces.push({ event, data }),
    compositeSink: composite,
    createCanvasSinkFn: canvasFactory,
    teamId: "T1", accessUserIds: ["U1"],
  });

  const res = await ui.startCanvas({ title: "Spec — req_c1" });
  assert.equal(res.ok, true, "startCanvas should succeed when wiring is complete");
  assert.equal(res.canvasId, "F_FAKE_CANVAS");
  assert.equal(res.url, "https://slack/canvas/fake");
  assert.equal(canvasFactory.created.length, 1, "canvas factory called exactly once");
  assert.equal(canvasFactory.created[0]._opts.title, "Spec — req_c1", "factory got the requested title");
  assert.equal(canvasFactory.created[0]._opts.channel, "C1");
  assert.equal(canvasFactory.created[0]._opts.teamId, "T1");
  assert.deepEqual(canvasFactory.created[0]._opts.accessUserIds, ["U1"]);
  assert.equal(composite.sinks.length, 2, "composite-sink now has slack+canvas");
  assert.ok(
    client.postMessages.some((m) => m.text?.includes("Streaming into a canvas") && m.text.includes("Spec")),
    "link post fired with the canvas URL and title",
  );
  assert.ok(traces.some((t) => t.event === "slack_ui.canvas_started"), "canvas_started trace emitted");
}

// ---------- case 2: text events between start and stop fan to BOTH slack-sink and canvas-sink ----------
{
  const client = makeFakeClient();
  const slackSink = makeFakeSlackSink();
  const composite = createCompositeSink([slackSink]);
  const canvasFactory = makeFakeCanvasSinkFactory();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c2",
    pendingApprovals: new Map(), surface: "app_mention",
    compositeSink: composite,
    createCanvasSinkFn: canvasFactory,
  });

  // Pre-canvas event: only slack-sink sees it.
  composite.handle({ type: "text_delta", text: "pre" });
  assert.equal(slackSink.events.length, 1);
  assert.equal(canvasFactory.events.length, 0);

  await ui.startCanvas({ title: "Doc" });

  // Mid-canvas event: both sinks see it.
  composite.handle({ type: "text_delta", text: "mid" });
  assert.equal(slackSink.events.length, 2);
  assert.equal(canvasFactory.events.length, 1);
  assert.equal(canvasFactory.events[0].text, "mid");

  await ui.stopCanvas();

  // Post-canvas event: only slack-sink sees it again (canvas-sink detached).
  composite.handle({ type: "text_delta", text: "post" });
  assert.equal(slackSink.events.length, 3);
  assert.equal(canvasFactory.events.length, 1, "no more events after stopCanvas");
}

// ---------- case 3: stopCanvas removes the sink and finalizes ----------
{
  const client = makeFakeClient();
  const slackSink = makeFakeSlackSink();
  const composite = createCompositeSink([slackSink]);
  const canvasFactory = makeFakeCanvasSinkFactory();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c3",
    pendingApprovals: new Map(), surface: "app_mention",
    compositeSink: composite,
    createCanvasSinkFn: canvasFactory,
  });

  await ui.startCanvas({ title: "Doc" });
  assert.equal(composite.sinks.length, 2);

  const res = await ui.stopCanvas({ finalMarkdown: "# Final\nContent" });
  assert.equal(res.ok, true);
  assert.equal(res.canvasId, "F_FAKE_CANVAS");
  assert.equal(res.streamedChars, 1234);
  assert.equal(composite.sinks.length, 1, "canvas-sink removed from composite");
  assert.equal(canvasFactory.isStopped(), true, "canvas-sink.stop was invoked");
  assert.equal(canvasFactory.created[0]._stoppedWith.result, "# Final\nContent");
}

// ---------- case 4: stopCanvas without startCanvas returns no_active_canvas ----------
{
  const client = makeFakeClient();
  const composite = createCompositeSink([makeFakeSlackSink()]);
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c4",
    pendingApprovals: new Map(), surface: "app_mention",
    compositeSink: composite,
    createCanvasSinkFn: makeFakeCanvasSinkFactory(),
  });

  const res = await ui.stopCanvas();
  assert.equal(res.ok, false);
  assert.equal(res.error, "no_active_canvas");
}

// ---------- case 5: double-start returns canvas_already_open with the existing ids ----------
{
  const client = makeFakeClient();
  const composite = createCompositeSink([makeFakeSlackSink()]);
  const canvasFactory = makeFakeCanvasSinkFactory();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c5",
    pendingApprovals: new Map(), surface: "app_mention",
    compositeSink: composite,
    createCanvasSinkFn: canvasFactory,
  });

  const first = await ui.startCanvas({ title: "A" });
  assert.equal(first.ok, true);
  const second = await ui.startCanvas({ title: "B" });
  assert.equal(second.ok, false);
  assert.equal(second.error, "canvas_already_open");
  assert.equal(second.canvasId, first.canvasId);
  assert.equal(canvasFactory.created.length, 1, "second start did not create a second sink");
}

// ---------- case 6: startCanvas without compositeSink/factory returns canvas_unavailable ----------
{
  const client = makeFakeClient();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c6",
    pendingApprovals: new Map(), surface: "app_mention",
    // no compositeSink, no createCanvasSinkFn → canvas is disabled.
  });
  const res = await ui.startCanvas({ title: "x" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "canvas_unavailable");
}

// ---------- case 7: dispose() with an open canvas auto-detaches and stops ----------
{
  const client = makeFakeClient();
  const composite = createCompositeSink([makeFakeSlackSink()]);
  const canvasFactory = makeFakeCanvasSinkFactory();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c7",
    pendingApprovals: new Map(), surface: "app_mention",
    compositeSink: composite,
    createCanvasSinkFn: canvasFactory,
  });

  await ui.startCanvas({ title: "Auto-clean" });
  assert.equal(composite.sinks.length, 2);

  ui.dispose("turn_end");
  // dispose() removes the canvas-sink synchronously; the sink.stop() promise
  // runs asynchronously, but the detach is what matters for fan-out hygiene.
  assert.equal(composite.sinks.length, 1, "dispose detaches the canvas-sink");

  // Subsequent composite events should not reach the canvas anymore.
  const eventsBefore = canvasFactory.events.length;
  composite.handle({ type: "text_delta", text: "after_dispose" });
  assert.equal(canvasFactory.events.length, eventsBefore, "no events after dispose");
}

// ---------- case 8: bridgeHelp returns the injected closure's output ----------
{
  const client = makeFakeClient();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c8",
    pendingApprovals: new Map(), surface: "app_mention",
    bridgeHelp: async () => "*help text* about Covent Pi",
  });
  const out = await ui.bridgeHelp();
  assert.match(out, /help text/);
}

// ---------- case 9: bridgeStatus returns the injected closure's output ----------
{
  const client = makeFakeClient();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c9",
    pendingApprovals: new Map(), surface: "app_mention",
    bridgeStatus: async () => "uptime 42s, mode pi",
  });
  const out = await ui.bridgeStatus();
  assert.match(out, /uptime 42s/);
  assert.match(out, /mode pi/);
}

// ---------- case 10: bridge helpers return a default message when not wired ----------
{
  const client = makeFakeClient();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c10",
    pendingApprovals: new Map(), surface: "app_mention",
  });
  const help = await ui.bridgeHelp();
  const status = await ui.bridgeStatus();
  assert.match(help, /not configured/i);
  assert.match(status, /not configured/i);
}

// ---------- case 11: bridge helpers catch closure throws and return a recovery message ----------
{
  const client = makeFakeClient();
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0", requestId: "req_c11",
    pendingApprovals: new Map(), surface: "app_mention",
    bridgeHelp: async () => { throw new Error("boom"); },
    bridgeStatus: async () => { throw new Error("kapow"); },
  });
  const help = await ui.bridgeHelp();
  const status = await ui.bridgeStatus();
  assert.match(help, /unavailable/);
  assert.match(help, /boom/);
  assert.match(status, /unavailable/);
  assert.match(status, /kapow/);
}

console.log("canvas-and-bridge-integration tests passed");
