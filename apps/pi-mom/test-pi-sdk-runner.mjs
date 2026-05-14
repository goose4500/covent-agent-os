import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { applyWebAccessSafetyToToolCall } from "../../extensions/pi-web-access-safety.ts";
import { applySlackTeamSubagentSafetyToToolCall } from "../../extensions/slack-team-subagent-safety.ts";
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

// Case 9: default workdir prefers the app checkout over HOME so project `.agents/` are discoverable.
{
  assert.equal(resolvePiWorkdir({ HOME: "/root" }, "/app/apps/pi-mom"), "/app/apps/pi-mom");
  assert.equal(resolvePiWorkdir({ PI_WORKDIR: "/workspace", HOME: "/root" }, "/app/apps/pi-mom"), "/workspace");
}

// Case 10: subagents and web-access loader flags are opt-in.
{
  assert.equal(subagentsEnabledFromEnv({}), false, "subagents disabled by default");
  assert.equal(subagentsEnabledFromEnv({ PI_MOM_SUBAGENTS_ENABLED: "true" }), true, "true enables subagents");
  assert.equal(webAccessEnabledFromEnv({}), false, "web access disabled by default");
  assert.equal(webAccessEnabledFromEnv({ PI_MOM_WEB_ACCESS_ENABLED: "true" }), true, "true enables web access");

  let loadCalls = 0;
  const fakeSubagentExtension = function fakeSubagentExtension() {};
  const loadSubagents = async () => { loadCalls += 1; return fakeSubagentExtension; };

  const disabledFactories = await buildPiMomExtensionFactories({
    env: { PI_MOM_SUBAGENTS_ENABLED: "false" },
    loadSubagents,
  });
  assert.equal(disabledFactories.length, 2, "disabled: only linear + Slack interactive factories");
  assert.equal(loadCalls, 0, "disabled: does not import pi-subagents");

  const enabledFactories = await buildPiMomExtensionFactories({
    env: { PI_MOM_SUBAGENTS_ENABLED: "true" },
    loadSubagents,
  });
  assert.equal(enabledFactories.length, 4, "subagents enabled: appends pi-subagents factory + safety guard");
  assert.equal(enabledFactories[2], fakeSubagentExtension, "subagents enabled: pi-subagents factory is before safety guard");
  assert.equal(loadCalls, 1, "enabled: imports pi-subagents exactly once for this loader build");

  const webEnabledFactories = await buildPiMomExtensionFactories({
    env: { PI_MOM_WEB_ACCESS_ENABLED: "true" },
    loadSubagents,
  });
  assert.equal(webEnabledFactories.length, 3, "web enabled: appends only the safety extension factory inline");
  assert.equal(loadCalls, 1, "web enabled: does not import pi-subagents");

  const bothEnabledFactories = await buildPiMomExtensionFactories({
    env: { PI_MOM_SUBAGENTS_ENABLED: "true", PI_MOM_WEB_ACCESS_ENABLED: "true" },
    loadSubagents,
  });
  assert.equal(bothEnabledFactories.length, 5, "both enabled: linear + Slack + subagents + subagent safety + web safety");
  assert.equal(bothEnabledFactories[2], fakeSubagentExtension, "both enabled: subagents remains before safety guards");
  assert.equal(loadCalls, 2, "both enabled: imports pi-subagents once for this loader build");
}

// Case 11: default resource loader options keep ambient discovery disabled even when subagents are enabled.
{
  const fakeSubagentExtension = function fakeSubagentExtension() {};
  const options = await buildResourceLoaderOptions({
    cwd: "/tmp/pi-mom-test",
    agentDir: "/tmp/pi-agent-test",
    env: { PI_MOM_SUBAGENTS_ENABLED: "true" },
    loadSubagents: async () => fakeSubagentExtension,
  });
  assert.equal(options.cwd, "/tmp/pi-mom-test");
  assert.equal(options.agentDir, "/tmp/pi-agent-test");
  assert.equal(options.noExtensions, true, "ambient extension discovery remains disabled");
  assert.equal(options.noSkills, true, "ambient user/global skill discovery remains disabled");
  assert.deepEqual(
    options.additionalSkillPaths,
    [resolveProjectSkillsDir()],
    "project skills are loaded from an explicit repo-owned path",
  );
  assert.equal(options.noPromptTemplates, true);
  assert.equal(options.noThemes, true);
  assert.equal(options.noContextFiles, true);
  assert.equal(options.extensionFactories.length, 4);
  assert.equal(options.extensionFactories[2], fakeSubagentExtension);
  assert.equal(options.additionalExtensionPaths, undefined, "web extension path absent unless web access is enabled");
}

// Case 12: web access resource paths resolve from the app dependency and are explicitly loaded without ambient discovery.
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
    env: { PI_MOM_WEB_ACCESS_ENABLED: "true" },
  });
  assert.equal(options.noExtensions, true, "web enabled still disables ambient extension discovery");
  assert.deepEqual(options.additionalExtensionPaths, [paths.extensionPath]);
  assert.deepEqual(options.additionalSkillPaths, [resolveProjectSkillsDir(), paths.skillsPath]);
  assert.equal(options.extensionFactories.length, 3, "web enabled adds only safety guard as inline factory");
}

// Case 13: web access safety guard forces no-browser workflow and blocks local/private fetches by default.
{
  const searchEvent = { toolName: "web_search", input: { query: "public docs", workflow: "summary-review" } };
  assert.equal(applyWebAccessSafetyToToolCall(searchEvent, {}), undefined);
  assert.equal(searchEvent.input.workflow, "none", "web_search workflow forced to none by default");

  const allowedSearchEvent = { toolName: "web_search", input: { query: "public docs", workflow: "summary-review" } };
  assert.equal(applyWebAccessSafetyToToolCall(allowedSearchEvent, { PI_MOM_WEB_ACCESS_ALLOW_BROWSER_WORKFLOW: "true" }), undefined);
  assert.equal(allowedSearchEvent.input.workflow, "summary-review", "operator opt-in can preserve browser workflow");

  assert.equal(applyWebAccessSafetyToToolCall({ toolName: "fetch_content", input: { url: "https://example.com/docs" } }, {}), undefined);
  assert.match(
    applyWebAccessSafetyToToolCall({ toolName: "fetch_content", input: { url: "file:///etc/passwd" } }, {})?.reason || "",
    /file\/local paths are blocked/,
  );
  assert.match(
    applyWebAccessSafetyToToolCall({ toolName: "fetch_content", input: { url: "http://127.0.0.1:8080" } }, {})?.reason || "",
    /private-network/,
  );
  assert.match(
    applyWebAccessSafetyToToolCall({ toolName: "web_search", input: { query: "xoxb-secret-token" } }, {})?.reason || "",
    /secret or credential/,
  );
  assert.match(
    applyWebAccessSafetyToToolCall({ toolName: "code_search", input: { query: "sk-secret-token-1234567890" } }, {})?.reason || "",
    /secret or credential/,
  );
  assert.match(
    applyWebAccessSafetyToToolCall({ toolName: "fetch_content", input: { url: "https://example.com", prompt: "OPENAI_API_KEY=sk-secret-token-1234567890" } }, {})?.reason || "",
    /secret or credential/,
  );
}

// Case 13b: Slack team subagent safety guard enforces curated foreground project presets.
{
  assert.equal(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { action: "doctor" } }),
    undefined,
    "team: doctor is allowed",
  );
  assert.equal(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { agent: "team-scout", task: "inspect", agentScope: "project", context: "fresh", async: false } }),
    undefined,
    "single approved project team agent is allowed",
  );
  assert.equal(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { chain: [{ agent: "team-scout" }, { agent: "team-planner" }], agentScope: "project", context: "fresh", async: false, clarify: false } }),
    undefined,
    "approved scout -> planner chain is allowed",
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { action: "create", config: { name: "x" } } })?.reason || "",
    /only subagent action allowed is doctor/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { agent: "worker", task: "edit", agentScope: "project", context: "fresh", async: false } })?.reason || "",
    /only run project team agents/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { agent: "team-scout", task: "inspect", agentScope: "user", context: "fresh", async: false } })?.reason || "",
    /agentScope: project/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { agent: "team-scout", task: "inspect", context: "fresh", async: false } })?.reason || "",
    /explicitly use agentScope: project/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { agent: "team-scout", task: "inspect", agentScope: "project", async: false } })?.reason || "",
    /explicitly use fresh context/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { agent: "team-scout", task: "inspect", agentScope: "project", context: "fresh" } })?.reason || "",
    /async: false/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { agent: "team-scout", task: "inspect", agentScope: "project", context: "fresh", async: true } })?.reason || "",
    /async: false/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { agent: "team-scout", task: "inspect", agentScope: "project", context: "fresh", async: false, sessionDir: "./tmp" } })?.reason || "",
    /sessionDir is not allowed/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { chain: [{ agent: "team-scout" }, { agent: "team-planner" }], agentScope: "project", context: "fresh", async: false } })?.reason || "",
    /clarify: false/,
  );
  assert.match(
    applySlackTeamSubagentSafetyToToolCall({ toolName: "subagent", input: { chain: [{ agent: "team-scout" }, { agent: "team-planner" }], agentScope: "project", context: "fresh", async: false, clarify: false, chainDir: "./tmp" } })?.reason || "",
    /chainDir is not allowed/,
  );
}

// Case 14: SDK loader smoke — noExtensions:true plus additionalExtensionPaths registers pi-web-access tools.
{
  const options = await buildResourceLoaderOptions({
    cwd: process.cwd(),
    agentDir: "/tmp/pi-agent-web-registration-test",
    env: { PI_MOM_WEB_ACCESS_ENABLED: "true" },
  });
  const loader = new DefaultResourceLoader(options);
  await loader.reload();
  const extensionResult = loader.getExtensions();
  assert.deepEqual(extensionResult.errors, [], "pi-web-access should load through the SDK loader without alias errors");
  const registeredTools = new Set(extensionResult.extensions.flatMap((extension) => [...extension.tools.keys()]));
  for (const tool of ["web_search", "fetch_content", "get_search_content", "code_search"]) {
    assert.ok(registeredTools.has(tool), `registered web access tool: ${tool}`);
  }
  const skillNames = loader.getSkills().skills.map((skill) => skill.name);
  assert.ok(skillNames.includes("librarian"), "bundled pi-web-access librarian skill loaded");
}

console.log("pi-sdk-runner tests passed");
