import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  buildApifyMcpServerFromEnv,
  buildManagedMcpServersFromEnv,
  buildPiMomExtensionFactories,
  buildResourceLoaderOptions,
  buildSlackMcpConfigFromEnv,
  createRunner,
  discoverMcpConfigForReconciliation,
  reconcileManagedMcpServersFromEnv,
  resolvePiWorkdir,
  resolveProjectSkillsDir,
  resolveWebAccessResourcePaths,
  seedMcpJsonFromEnv,
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

// Case 10: subagents, web access, and MCP adapter are default-on; app factories load every app extension.
{
  assert.equal(subagentsEnabledFromEnv({}), true, "subagents enabled by default");
  assert.equal(subagentsEnabledFromEnv({ PI_MOM_SUBAGENTS_ENABLED: "false" }), true, "env no longer disables subagents");
  assert.equal(webAccessEnabledFromEnv({}), true, "web access enabled by default");
  assert.equal(webAccessEnabledFromEnv({ PI_MOM_WEB_ACCESS_ENABLED: "false" }), true, "env no longer disables web access");

  let subagentLoads = 0;
  let mcpLoads = 0;
  const fakeSubagentExtension = function fakeSubagentExtension() {};
  const fakeMcpAdapter = function fakeMcpAdapter() {};
  const loadSubagents = async () => { subagentLoads += 1; return fakeSubagentExtension; };
  const loadMcpAdapter = async () => { mcpLoads += 1; return fakeMcpAdapter; };

  const factories = await buildPiMomExtensionFactories({ loadSubagents, loadMcpAdapter });
  assert.equal(factories.length, 10, "default factories: Linear + GitHub PR + Slack UI + Slack canvas + bridge + Browser Use + X fetch + git checkpoint + pi-mcp-adapter + subagents");
  assert.equal(factories[8], fakeMcpAdapter, "pi-mcp-adapter factory is default-on, placed before subagents");
  assert.equal(factories[9], fakeSubagentExtension, "subagents factory remains default-on (last)");
  assert.equal(subagentLoads, 1, "imports pi-subagents exactly once for this loader build");
  assert.equal(mcpLoads, 1, "imports pi-mcp-adapter exactly once for this loader build");
}

// Case 11: default resource loader makes app-approved extensions and skills default-on.
{
  const fakeSubagentExtension = function fakeSubagentExtension() {};
  const fakeMcpAdapter = function fakeMcpAdapter() {};
  const paths = resolveWebAccessResourcePaths();
  const options = await buildResourceLoaderOptions({
    cwd: "/tmp/pi-mom-test",
    agentDir: "/tmp/pi-agent-test",
    env: { PI_MOM_SUBAGENTS_ENABLED: "false", PI_MOM_WEB_ACCESS_ENABLED: "false" },
    loadSubagents: async () => fakeSubagentExtension,
    loadMcpAdapter: async () => fakeMcpAdapter,
  });
  assert.equal(options.cwd, "/tmp/pi-mom-test");
  assert.equal(options.agentDir, "/tmp/pi-agent-test");
  assert.equal(options.noExtensions, true, "ambient package install/discovery remains off; app extensions are explicit");
  assert.equal(options.noSkills, false, "skill discovery is enabled");
  assert.deepEqual(options.additionalSkillPaths, [resolveProjectSkillsDir(), paths.skillsPath]);
  assert.equal(options.noPromptTemplates, false);
  assert.equal(options.noThemes, false);
  assert.equal(options.noContextFiles, false);
  assert.equal(options.extensionFactories.length, 10);
  assert.equal(options.extensionFactories[8], fakeMcpAdapter);
  assert.equal(options.extensionFactories[9], fakeSubagentExtension);
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
      "github_get_pr", "github_pr_comment", "github_create_pr", "github_merge_pr",
      "slack_approval_card", "slack_choice_card", "slack_input_request",
      "browser_use_run",
      "x_fetch_post",
      "subagent",
      "web_search", "fetch_content", "get_search_content", "code_search",
      "mcp",
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

// Case 14: Slack MCP preset is opt-in and stores only an env-var reference.
{
  assert.equal(buildSlackMcpConfigFromEnv({}), null, "Slack MCP preset is disabled by default");
  const config = buildSlackMcpConfigFromEnv({
    SLACK_MCP_ENABLED: "1",
    SLACK_MCP_BEARER_TOKEN_ENV: "MY_SLACK_MCP_TOKEN",
    SLACK_MCP_DIRECT_TOOLS: "true",
    SLACK_MCP_IDLE_TIMEOUT_MINUTES: "7",
  });
  assert.equal(config.mcpServers.slack.url, "https://mcp.slack.com/mcp");
  assert.equal(config.mcpServers.slack.auth, "bearer");
  assert.equal(config.mcpServers.slack.bearerTokenEnv, "MY_SLACK_MCP_TOKEN");
  assert.equal(config.mcpServers.slack.directTools, true);
  assert.equal(config.mcpServers.slack.idleTimeout, 7);
  assert.equal(JSON.stringify(config).includes("xox"), false, "preset must not embed Slack token values");
}

// Case 15: mcp.json seeding honors PI_MCP_JSON_B64 first, otherwise uses Slack MCP preset.
{
  const agentDir = mkdtempSync(join(tmpdir(), "pi-mom-mcp-seed-"));
  try {
    const seeded = seedMcpJsonFromEnv({
      agentDir,
      env: { SLACK_MCP_ENABLED: "true", SLACK_MCP_BEARER_TOKEN_ENV: "SLACK_MCP_TOKEN" },
      log: { log() {}, error() {} },
    });
    assert.equal(seeded.seeded, true);
    assert.equal(seeded.source, "SLACK_MCP_ENABLED");
    const written = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(written.mcpServers.slack.url, "https://mcp.slack.com/mcp");
    assert.equal(written.mcpServers.slack.bearerTokenEnv, "SLACK_MCP_TOKEN");

    const skipped = seedMcpJsonFromEnv({
      agentDir,
      env: { PI_MCP_JSON_B64: Buffer.from('{"mcpServers":{}}').toString("base64") },
      log: { log() {}, error() {} },
    });
    assert.equal(skipped.seeded, false, "existing mcp.json is never overwritten");
    assert.equal(skipped.reason, "exists");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// Case 16: managed Apify MCP config is derived from env without embedding token values.
{
  assert.equal(buildApifyMcpServerFromEnv({}), null, "Apify MCP is disabled when APIFY_API_TOKEN is absent");
  const apify = buildApifyMcpServerFromEnv({
    APIFY_API_TOKEN: "apify_api_fake_secret",
    APIFY_MCP_DIRECT_TOOLS: "true",
    APIFY_MCP_IDLE_TIMEOUT_MINUTES: "12",
  });
  assert.equal(apify.url, "https://mcp.apify.com/");
  assert.equal(apify.auth, "bearer");
  assert.equal(apify.bearerTokenEnv, "APIFY_API_TOKEN");
  assert.equal(apify.directTools, true);
  assert.equal(apify.idleTimeout, 12);
  assert.equal(JSON.stringify(apify).includes("apify_api_fake_secret"), false, "managed config stores env var names, not token values");

  const managed = buildManagedMcpServersFromEnv({
    APIFY_API_TOKEN: "apify_api_fake_secret",
    SLACK_MCP_ENABLED: "1",
    SLACK_MCP_BEARER_TOKEN_ENV: "SLACK_MCP_TOKEN",
  });
  assert.deepEqual(Object.keys(managed).sort(), ["apify", "slack"]);
}

// Case 17: managed MCP reconciliation adds missing env-enabled servers to the canonical Pi global config.
{
  const root = mkdtempSync(join(tmpdir(), "pi-mom-mcp-reconcile-"));
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const mcpPath = join(agentDir, "mcp.json");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(mcpPath, JSON.stringify({
    mcpServers: {
      github: {
        url: "https://api.githubcopilot.com/mcp/",
        auth: "bearer",
        bearerTokenEnv: "GITHUB_MCP_PAT",
      },
    },
  }, null, 2));
  try {
    const result = reconcileManagedMcpServersFromEnv({
      env: { APIFY_API_TOKEN: "apify_api_fake_secret" },
      agentDir,
      cwd,
      homeDir,
      log: { log() {}, warn() {}, error() {} },
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.added, ["apify"]);
    const writtenText = readFileSync(mcpPath, "utf8");
    const written = JSON.parse(writtenText);
    assert.ok(written.mcpServers.github, "existing GitHub MCP server is preserved");
    assert.equal(written.mcpServers.apify.url, "https://mcp.apify.com/");
    assert.equal(written.mcpServers.apify.bearerTokenEnv, "APIFY_API_TOKEN");
    assert.equal(written.mcpServers.apify.directTools, false);
    assert.equal(writtenText.includes("apify_api_fake_secret"), false, "reconciled file never stores the Apify token value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Case 18: reconciliation discovers project/imported MCP config and avoids duplicating servers into Pi global config.
{
  const root = mkdtempSync(join(tmpdir(), "pi-mom-mcp-discover-"));
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", "mcp.json"), JSON.stringify({
    mcpServers: {
      importedDocs: { command: "docs-mcp", args: [] },
    },
  }, null, 2));
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
    imports: ["claude-code"],
    mcpServers: {
      apify: {
        url: "https://mcp.apify.com/",
        auth: "bearer",
        bearerTokenEnv: "APIFY_API_TOKEN",
      },
    },
  }, null, 2));
  try {
    const discovered = discoverMcpConfigForReconciliation({ agentDir, cwd, homeDir, log: { warn() {} } });
    assert.ok(discovered.config.mcpServers.apify, "project .mcp.json contributes to effective MCP config");
    assert.ok(discovered.config.mcpServers.importedDocs, "project imports contribute to effective MCP config");
    const result = reconcileManagedMcpServersFromEnv({
      env: { APIFY_API_TOKEN: "apify_api_fake_secret" },
      agentDir,
      cwd,
      homeDir,
      log: { log() {}, warn() {}, error() {} },
    });
    assert.equal(result.changed, false);
    assert.equal(result.reason, "already-configured");
    assert.equal(existsSync(join(agentDir, "mcp.json")), false, "no duplicate Pi global file is written when discovered config already provides Apify");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Case 19: when a managed server already exists in Pi global config, defaults fill gaps without clobbering operator overrides.
{
  const root = mkdtempSync(join(tmpdir(), "pi-mom-mcp-preserve-"));
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const mcpPath = join(agentDir, "mcp.json");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(mcpPath, JSON.stringify({
    mcpServers: {
      apify: {
        url: "https://custom-apify.example/mcp",
        directTools: true,
        customField: "keep-me",
      },
    },
  }, null, 2));
  try {
    const result = reconcileManagedMcpServersFromEnv({
      env: { APIFY_API_TOKEN: "apify_api_fake_secret" },
      agentDir,
      cwd,
      homeDir,
      log: { log() {}, warn() {}, error() {} },
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.updated, ["apify"]);
    const written = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.equal(written.mcpServers.apify.url, "https://custom-apify.example/mcp", "operator URL override is preserved");
    assert.equal(written.mcpServers.apify.directTools, true, "operator directTools override is preserved");
    assert.equal(written.mcpServers.apify.customField, "keep-me");
    assert.equal(written.mcpServers.apify.auth, "bearer", "missing managed defaults are filled");
    assert.equal(written.mcpServers.apify.bearerTokenEnv, "APIFY_API_TOKEN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("pi-sdk-runner tests passed");
