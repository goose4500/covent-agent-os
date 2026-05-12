import assert from "node:assert/strict";
import { createDispatcher } from "./lib/dispatch.mjs";

// Case 1: app_mention surface → handleRequest called with mode="app_mention".
{
  let captured;
  const { dispatchToAction } = createDispatcher({
    handleRequest: async (args) => { captured = args; },
  });
  const event = { channel: "C0B05VBGJKF", text: "<@U123> ping", user: "U123", ts: "1.2" };
  const client = { chat: { postMessage: async () => {} } };
  await dispatchToAction({ surface: "app_mention", event, client });
  assert.equal(captured.mode, "app_mention", "app_mention: mode forwarded");
  assert.equal(captured.event, event, "app_mention: event forwarded");
  assert.equal(captured.client, client, "app_mention: client forwarded");
}

// Case 2: assistant surface → setStatus called before and cleared after.
{
  const statusCalls = [];
  const utilities = { setStatus: async (s) => { statusCalls.push(s); } };
  const { dispatchToAction } = createDispatcher({ handleRequest: async () => {} });
  await dispatchToAction({
    surface: "assistant",
    event: { channel: "D123", text: "hello" },
    client: {},
    utilities,
  });
  assert.deepEqual(statusCalls, ["is thinking…", ""], "assistant: setStatus open + close");
}

// Case 3: setStatus only called for assistant surface, never app_mention or DM.
{
  const statusCalls = [];
  const utilities = { setStatus: async (s) => { statusCalls.push(s); } };
  const { dispatchToAction } = createDispatcher({ handleRequest: async () => {} });
  await dispatchToAction({
    surface: "app_mention",
    event: { channel: "C123" },
    client: {},
    utilities,
  });
  await dispatchToAction({
    surface: "direct_message",
    event: { channel: "D456" },
    client: {},
    utilities,
  });
  assert.equal(statusCalls.length, 0, "non-assistant surfaces never call setStatus");
}

// Case 4: setStatus("") still fires even if handleRequest throws.
{
  const statusCalls = [];
  const utilities = { setStatus: async (s) => { statusCalls.push(s); } };
  const { dispatchToAction } = createDispatcher({
    handleRequest: async () => { throw new Error("boom"); },
  });
  await assert.rejects(
    dispatchToAction({
      surface: "assistant",
      event: { channel: "D789" },
      client: {},
      utilities,
    }),
    /boom/,
    "assistant: handleRequest error propagates",
  );
  assert.deepEqual(
    statusCalls,
    ["is thinking…", ""],
    "assistant: setStatus closed in finally even on error",
  );
}

// Case 5: setStatus failure does not block handleRequest.
{
  let routed = false;
  const utilities = { setStatus: async () => { throw new Error("slack 503"); } };
  const { dispatchToAction } = createDispatcher({
    handleRequest: async () => { routed = true; },
  });
  await dispatchToAction({
    surface: "assistant",
    event: { channel: "D000" },
    client: {},
    utilities,
  });
  assert.equal(routed, true, "assistant: setStatus failure tolerated; handleRequest still ran");
}

// Case 6: trace fires dispatch.start + dispatch.end with surface tag.
{
  const traceCalls = [];
  const { dispatchToAction } = createDispatcher({
    handleRequest: async () => {},
    trace: (event, data) => traceCalls.push({ event, data }),
  });
  await dispatchToAction({
    surface: "app_mention",
    event: { channel: "C123", ts: "1.5", thread_ts: "1.2" },
    client: {},
  });
  assert.equal(traceCalls.length, 2, "trace fires twice");
  assert.equal(traceCalls[0].event, "dispatch.start");
  assert.equal(traceCalls[0].data.surface, "app_mention");
  assert.equal(traceCalls[0].data.channel, "C123");
  assert.equal(traceCalls[0].data.threadTs, "1.2");
  assert.equal(traceCalls[1].event, "dispatch.end");
  assert.equal(traceCalls[1].data.surface, "app_mention");
}

// Case 7: surface required.
{
  const { dispatchToAction } = createDispatcher({ handleRequest: async () => {} });
  await assert.rejects(
    dispatchToAction({ event: {}, client: {} }),
    /surface/,
    "no surface → throw",
  );
}

// Case 8: handleRequest required at factory time.
{
  assert.throws(() => createDispatcher({}), /handleRequest/);
  assert.throws(() => createDispatcher({ handleRequest: "not-a-fn" }), /handleRequest/);
}

console.log("dispatch tests passed");
