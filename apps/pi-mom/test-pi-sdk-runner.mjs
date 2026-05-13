import assert from "node:assert/strict";
import { createRunner } from "./lib/pi-sdk-runner.mjs";

function fakeSession({ script = [], throwOnPrompt } = {}) {
  const subs = [];
  const state = { aborted: 0, disposed: 0, prompts: 0 };
  return {
    state,
    subscribe(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    async prompt(text) {
      state.prompts += 1;
      state.lastPrompt = text;
      if (throwOnPrompt) throw throwOnPrompt;
      for (const evt of script) {
        for (const fn of [...subs]) fn(evt);
      }
    },
    async abort() { state.aborted += 1; },
    async dispose() { state.disposed += 1; },
  };
}

function fakeDeps({ model = { id: "fake-model" }, modelId = "fake/fake-model" } = {}) {
  return async () => ({ authStorage: {}, modelRegistry: {}, model, modelId });
}

// Case 1: happy path — three text_delta events, then agent_end, returns full string and streams each delta.
{
  const events = [
    { type: "agent_start" },
    { type: "message_start" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " ", contentIndex: 0 } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world", contentIndex: 0 } },
    { type: "message_end" },
    { type: "agent_end", messages: [] },
  ];
  const session = fakeSession({ script: events });
  let createCalls = 0;
  let capturedOptions;
  const { runPi } = createRunner({
    createSession: async (opts) => { createCalls += 1; capturedOptions = opts; return { session }; },
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({ marker: "loader" }),
  });

  const onOutputCalls = [];
  const result = await runPi("test prompt", { onOutput: (d) => onOutputCalls.push(d) });

  assert.equal(result, "hello world", "happy: aggregated text");
  assert.deepEqual(onOutputCalls, ["hello", " ", "world"], "happy: onOutput called per delta");
  assert.equal(createCalls, 1);
  assert.equal(session.state.prompts, 1);
  assert.equal(session.state.lastPrompt, "test prompt");
  assert.equal(session.state.aborted, 1, "happy: session.abort called during settle");
  assert.equal(session.state.disposed, 1, "happy: session.dispose called during settle");
  assert.equal(capturedOptions.noTools, "all", "happy: noTools posture applied by default");
  assert.ok(capturedOptions.resourceLoader, "happy: resourceLoader provided by default");
  assert.ok(capturedOptions.sessionManager, "happy: sessionManager passed");
  assert.equal(capturedOptions.thinkingLevel, "high", "happy: thinking level applied from default env");
}

// Case 2: hard timeout — no agent_end ever. Inject synchronous setTimeoutFn so the timeout fires immediately.
{
  const session = fakeSession({ script: [] });
  const { runPi } = createRunner({
    createSession: async () => ({ session }),
    getDeps: fakeDeps(),
    setTimeoutFn: (fn) => { Promise.resolve().then(fn); return Symbol("timer"); },
    clearTimeoutFn: () => {},
    buildResourceLoader: async () => ({}),
    timeoutMs: 123,
  });

  await assert.rejects(runPi("hang"), /Pi timed out after 123ms/);
  assert.equal(session.state.aborted, 1, "timeout: session.abort called");
  assert.equal(session.state.disposed, 1, "timeout: session.dispose called");
}

// Case 3: provider error — assistantMessageEvent.type === "error", then agent_end. Rejects with the error message.
{
  const events = [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial...", contentIndex: 0 } },
    { type: "message_update", assistantMessageEvent: { type: "error", reason: "error", error: { errorMessage: "rate limited" } } },
    { type: "agent_end", messages: [] },
  ];
  const session = fakeSession({ script: events });
  const { runPi } = createRunner({
    createSession: async () => ({ session }),
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({}),
  });
  await assert.rejects(runPi("hi"), /rate limited/);
  assert.equal(session.state.aborted, 1);
  assert.equal(session.state.disposed, 1);
}

// Case 4: tools/extensions posture — allowTools=true skips noTools but the
// resourceLoader is ALWAYS passed. The loader carries the inline
// linearTools factory, so it must be wired even when tools are allowed;
// otherwise createAgentSession synthesizes its own default loader and our
// inline extensions never load.
{
  const session = fakeSession({ script: [{ type: "agent_end", messages: [] }] });
  let captured;
  const { runPi } = createRunner({
    createSession: async (opts) => { captured = opts; return { session }; },
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({ marker: "loader" }),
    allowTools: true,
  });
  await runPi("noop");
  assert.equal(captured.noTools, undefined, "posture: noTools omitted when allowTools=true");
  assert.deepEqual(captured.resourceLoader, { marker: "loader" }, "posture: resourceLoader always passed (carries inline linearTools factory)");
}

// Case 5: model not found — getDeps returns no model, runPi rejects with PI_MOM_MODEL message.
{
  const { runPi } = createRunner({
    createSession: async () => ({ session: fakeSession() }),
    getDeps: async () => ({ authStorage: {}, modelRegistry: {}, model: undefined, modelId: "fake/missing" }),
    buildResourceLoader: async () => ({}),
  });
  await assert.rejects(runPi("hi"), /PI_MOM_MODEL 'fake\/missing' not found/);
}

// Case 6 (Stage 4): explicit `tools: []` → noTools:"all" posture (same as legacy
// PI_MOM_ALLOW_PI_TOOLS=false), even when the runner was constructed with allowTools=true.
{
  const session = fakeSession({ script: [{ type: "agent_end", messages: [] }] });
  let captured;
  const setActiveCalls = [];
  session.setActiveToolsByName = (names) => setActiveCalls.push(names);
  const { runPi } = createRunner({
    createSession: async (opts) => { captured = opts; return { session }; },
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({ marker: "loader" }),
    allowTools: true, // legacy posture would normally enable tools…
  });
  await runPi("noop", { tools: [] }); // …but explicit tools=[] overrides it.
  assert.equal(captured.noTools, "all", "tools=[] forces noTools posture");
  assert.ok(captured.resourceLoader, "tools=[] still passes the minimal resource loader");
  assert.deepEqual(setActiveCalls, [], "setActiveToolsByName not called for empty allowlist");
}

// Case 7 (Stage 4): explicit `tools: ['read']` → omits noTools and calls setActiveToolsByName(['read']).
{
  const session = fakeSession({ script: [{ type: "agent_end", messages: [] }] });
  let captured;
  const setActiveCalls = [];
  session.setActiveToolsByName = (names) => setActiveCalls.push(names);
  const { runPi } = createRunner({
    createSession: async (opts) => { captured = opts; return { session }; },
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({ marker: "loader" }),
    allowTools: false,
  });
  await runPi("with tools", { tools: ["read"] });
  assert.equal(captured.noTools, undefined, "non-empty tools omits noTools");
  assert.deepEqual(captured.resourceLoader, { marker: "loader" }, "non-empty tools still passes the resource loader (Stage 6.5: carries inline extensions)");
  assert.deepEqual(setActiveCalls, [["read"]], "setActiveToolsByName called once with the allowlist");
  assert.equal(session.state.prompts, 1, "prompt still issued after tool gating");
}

// Case 8 (Stage 4): explicit `tools: ['read','bash']` forwards the full allowlist verbatim.
{
  const session = fakeSession({ script: [{ type: "agent_end", messages: [] }] });
  const setActiveCalls = [];
  session.setActiveToolsByName = (names) => setActiveCalls.push(names);
  const { runPi } = createRunner({
    createSession: async () => ({ session }),
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({}),
  });
  await runPi("multi", { tools: ["read", "bash"] });
  assert.deepEqual(setActiveCalls, [["read", "bash"]]);
}

console.log("pi-sdk-runner tests passed");
