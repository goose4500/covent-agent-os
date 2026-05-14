import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  buildPiMomExtensionFactories,
  buildResourceLoaderOptions,
  createRunner,
  resolvePiWorkdir,
  resolveProjectSkillsDir,
  resolveWebAccessResourcePaths,
  subagentsEnabledFromEnv,
  webAccessEnabledFromEnv,
} from "./lib/pi-sdk-runner.mjs";

function fakeSession({ script = [], throwOnPrompt, allTools = ["read", "bash", "edit", "write", "grep", "find", "linear_create_issue"] } = {}) {
  const subs = [];
  const state = { aborted: 0, disposed: 0, prompts: 0, activeToolCalls: [] };
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
    getAllTools() { return allTools.map((name) => ({ name })); },
    setActiveToolsByName(names) { state.activeToolCalls.push(names); },
    async abort() { state.aborted += 1; },
    async dispose() { state.disposed += 1; },
  };
}

function fakeDeps({ model = { id: "fake-model" }, modelId = "fake/fake-model" } = {}) {
  return async () => ({ authStorage: {}, modelRegistry: {}, model, modelId });
}

function fakeAssistantTextMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 0,
  };
}

function fakeAssistantErrorMessage(message) {
  return {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: message,
    timestamp: 0,
  };
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
  assert.equal(capturedOptions.noTools, undefined, "happy: tools are enabled by default");
  assert.deepEqual(session.state.activeToolCalls, [["read", "bash", "edit", "write", "grep", "find", "linear_create_issue"]], "happy: all registered tools activated by default");
  assert.ok(capturedOptions.resourceLoader, "happy: resourceLoader provided by default");
  assert.ok(capturedOptions.sessionManager, "happy: sessionManager passed");
  assert.equal(capturedOptions.thinkingLevel, "high", "happy: thinking level applied from default env");
}

// Case 1a: SDK may emit successful final text via text_end without text_delta.
{
  const final = fakeAssistantTextMessage("final via text_end");
  const events = [
    { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: fakeAssistantTextMessage("") } },
    { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "final via text_end", partial: final } },
    { type: "agent_end", messages: [] },
  ];
  const session = fakeSession({ script: events });
  const onOutputCalls = [];
  const { runPi } = createRunner({
    createSession: async () => ({ session }),
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({}),
  });

  const result = await runPi("hi", { onOutput: (d) => onOutputCalls.push(d) });
  assert.equal(result, "final via text_end");
  assert.deepEqual(onOutputCalls, ["final via text_end"], "text_end fallback streams missing final text");
}

// Case 1b: SDK may expose final assistant text only on message_end/agent_end.
{
  const final = fakeAssistantTextMessage("final via agent_end");
  const events = [
    { type: "message_start", message: final },
    { type: "message_end", message: final },
    { type: "agent_end", messages: [final] },
  ];
  const session = fakeSession({ script: events });
  const { runPi } = createRunner({
    createSession: async () => ({ session }),
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({}),
  });

  const result = await runPi("hi");
  assert.equal(result, "final via agent_end");
}

// Case 1c: text_end after deltas appends only the suffix the deltas missed.
{
  const events = [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial", contentIndex: 0 } },
    { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "partial answer" } },
    { type: "agent_end", messages: [] },
  ];
  const session = fakeSession({ script: events });
  const onOutputCalls = [];
  const { runPi } = createRunner({
    createSession: async () => ({ session }),
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({}),
  });

  const result = await runPi("hi", { onOutput: (d) => onOutputCalls.push(d) });
  assert.equal(result, "partial answer");
  assert.deepEqual(onOutputCalls, ["partial", " answer"], "text_end suffix fallback avoids duplicate deltas");
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

// Case 3a: provider errors can arrive as final message_end/agent_end messages when no text stream started.
{
  const final = fakeAssistantErrorMessage("invalid tool schema");
  const events = [
    { type: "message_start", message: final },
    { type: "message_end", message: final },
    { type: "turn_end", message: final, toolResults: [] },
    { type: "agent_end", messages: [final] },
  ];
  const session = fakeSession({ script: events });
  const { runPi } = createRunner({
    createSession: async () => ({ session }),
    getDeps: fakeDeps(),
    buildResourceLoader: async () => ({}),
  });
  await assert.rejects(runPi("hi"), /invalid tool schema/);
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

// Case 6: explicit `tools: []` → noTools:"all" posture, even when the runner
// was constructed with allowTools=true.
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

// Case 9: default workdir prefers the app checkout over HOME so project `.agents/` are discoverable.
{
  assert.equal(resolvePiWorkdir({ HOME: "/root" }, "/app/apps/pi-mom"), "/app/apps/pi-mom");
  assert.equal(resolvePiWorkdir({ PI_WORKDIR: "/workspace", HOME: "/root" }, "/app/apps/pi-mom"), "/workspace");
}

// Case 10: subagents and web access are default-on; app factories load all app extensions.
{
  assert.equal(subagentsEnabledFromEnv({}), true, "subagents enabled by default");
  assert.equal(subagentsEnabledFromEnv({ PI_MOM_SUBAGENTS_ENABLED: "false" }), true, "env no longer disables subagents");
  assert.equal(webAccessEnabledFromEnv({}), true, "web access enabled by default");
  assert.equal(webAccessEnabledFromEnv({ PI_MOM_WEB_ACCESS_ENABLED: "false" }), true, "env no longer disables web access");

  let loadCalls = 0;
  const fakeSubagentExtension = function fakeSubagentExtension() {};
  const loadSubagents = async () => { loadCalls += 1; return fakeSubagentExtension; };

  const factories = await buildPiMomExtensionFactories({ loadSubagents });
  assert.equal(factories.length, 5, "default factories: Linear + Slack UI + Browser Use + git checkpoint + subagents");
  assert.equal(factories[4], fakeSubagentExtension, "subagents factory is default-on");
  assert.equal(loadCalls, 1, "imports pi-subagents exactly once for this loader build");
}

// Case 11: default resource loader makes app-approved extensions and skills default-on.
{
  const fakeSubagentExtension = function fakeSubagentExtension() {};
  const paths = resolveWebAccessResourcePaths();
  const options = await buildResourceLoaderOptions({
    cwd: "/tmp/pi-mom-test",
    agentDir: "/tmp/pi-agent-test",
    env: { PI_MOM_SUBAGENTS_ENABLED: "false", PI_MOM_WEB_ACCESS_ENABLED: "false" },
    loadSubagents: async () => fakeSubagentExtension,
  });
  assert.equal(options.cwd, "/tmp/pi-mom-test");
  assert.equal(options.agentDir, "/tmp/pi-agent-test");
  assert.equal(options.noExtensions, true, "ambient package install/discovery remains off; app extensions are explicit");
  assert.equal(options.noSkills, false, "skill discovery is enabled");
  assert.deepEqual(options.additionalSkillPaths, [resolveProjectSkillsDir(), paths.skillsPath]);
  assert.equal(options.noPromptTemplates, false);
  assert.equal(options.noThemes, false);
  assert.equal(options.noContextFiles, false);
  assert.equal(options.extensionFactories.length, 5);
  assert.equal(options.extensionFactories[4], fakeSubagentExtension);
  assert.deepEqual(options.additionalExtensionPaths, [paths.extensionPath]);
}

// Case 12: web access resource paths resolve from the app dependency and are always loaded.
{
  const paths = resolveWebAccessResourcePaths();
  assert.ok(paths.packageJsonPath.endsWith("pi-web-access/package.json"), "resolves pi-web-access package.json");
  assert.ok(paths.extensionPath.endsWith("pi-web-access/index.ts"), "resolves pi-web-access extension entrypoint");
  assert.ok(paths.skillsPath.endsWith("pi-web-access/skills"), "resolves pi-web-access bundled skills dir");
  assert.ok(existsSync(paths.extensionPath), "resolved extension entrypoint exists");
  assert.ok(existsSync(paths.skillsPath), "resolved skills dir exists");

  const options = await buildResourceLoaderOptions({
    cwd: process.cwd(),
    agentDir: "/tmp/pi-agent-web-test",
  });
  assert.deepEqual(options.additionalExtensionPaths, [paths.extensionPath]);
  assert.deepEqual(options.additionalSkillPaths, [resolveProjectSkillsDir(), paths.skillsPath]);
}

// Case 13: SDK loader smoke — default-on extensions register expected tools.
{
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    const options = await buildResourceLoaderOptions({
      cwd: process.cwd(),
      agentDir: "/tmp/pi-agent-default-all-registration-test",
    });
    const loader = new DefaultResourceLoader(options);
    await loader.reload();
    const extensionResult = loader.getExtensions();
    assert.deepEqual(extensionResult.errors, [], "default app extensions should load without errors");
    const registeredTools = new Set(extensionResult.extensions.flatMap((extension) => [...extension.tools.keys()]));
    for (const tool of [
      "linear_search_issues", "linear_create_issue", "linear_add_comment",
      "slack_approval_card", "slack_choice_card", "slack_input_request",
      "browser_use_run",
      "subagent",
      "web_search", "fetch_content", "get_search_content", "code_search",
    ]) {
      assert.ok(registeredTools.has(tool), `registered default-on tool: ${tool}`);
    }
    const skillNames = loader.getSkills().skills.map((skill) => skill.name);
    assert.ok(skillNames.includes("librarian"), "bundled pi-web-access librarian skill loaded");
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
  }
}

console.log("pi-sdk-runner tests passed");
