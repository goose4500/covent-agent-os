// Tests for extensions/slack-api.ts.
//
// The factory registers ONE tool (slack_api) that fronts the Slack Web API.
// Tests inject a fake `pi` ExtensionAPI + a fake fetch + an env snapshot,
// then drive the tool's execute() with crafted method/params combinations
// to exercise: registration shape, happy-path read, happy-path write +
// mutation classification, as_user token selection, missing-env error,
// allowlist rejection, ok:false handling, 429 + Retry-After, and secret
// redaction.

import assert from "node:assert/strict";
import { createSlackApiFactory, __slackApiTest } from "../../extensions/slack-api.ts";

function makeFakePi() {
  const registered = [];
  return {
    registered,
    registerTool: (definition) => registered.push(definition),
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({}),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "high",
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  };
}

function findTool(pi, name) {
  const tool = pi.registered.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

const baseEnv = {
  SLACK_BOT_TOKEN: "xoxb-TEST-bot-token",
  SLACK_USER_TOKEN: "xoxp-TEST-user-token",
};

function makeFakeFetch(handler, recorded = []) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    recorded.push({ url, init, body, headers: init?.headers });
    const response = await handler({ url, body, init }, recorded.length);
    const headersMap = new Map(Object.entries(response.headers || {}));
    return {
      ok: response.ok ?? (response.status ?? 200) < 400,
      status: response.status ?? 200,
      headers: { get: (name) => headersMap.get(String(name).toLowerCase()) ?? null },
      async json() { return response.payload ?? {}; },
    };
  };
}

// Case 1: factory registers exactly one tool with the expected shape.
{
  const fakePi = makeFakePi();
  createSlackApiFactory({ env: baseEnv })(fakePi);
  assert.equal(fakePi.registered.length, 1, "one tool registered");
  const tool = findTool(fakePi, "slack_api");
  assert.equal(tool.name, "slack_api");
  assert.deepEqual(tool.parameters.required, ["method"]);
  assert.ok(tool.parameters.properties.method, "method param defined");
  assert.ok(tool.parameters.properties.params, "params param defined");
  assert.ok(tool.parameters.properties.as_user, "as_user param defined");
}

// Case 2: happy-path read (auth.test) — verify URL, method=POST, headers, body.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { ok: true, url: "https://covent.slack.com/", team: "Covent", user: "pi-mom", team_id: "T1", user_id: "U1", bot_id: "B1" },
  }), calls);
  createSlackApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute("tc1", { method: "auth.test" }, undefined, undefined, {});
  assert.equal(r.isError, undefined, "no error on happy path");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://slack.com/api/auth.test");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].headers.Authorization, "Bearer xoxb-TEST-bot-token");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(calls[0].body, {});
  assert.equal(r.details.method, "auth.test");
  assert.equal(r.details.mutation, false, "auth.test is not a mutation");
  assert.equal(r.details.as_user, false);
  assert.equal(r.details.response.team, "Covent");
  assert.match(r.content[0].text, /auth\.test ok/);
}

// Case 3: happy-path write (chat.postMessage) — mutation classification surfaced.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      ok: true,
      ts: "1715600001.000200",
      channel: "C0123456789",
      message: { text: "hello", ts: "1715600001.000200" },
    },
  }), calls);
  createSlackApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute(
    "tc2",
    { method: "chat.postMessage", params: { channel: "C0123456789", thread_ts: "1715600000.000100", text: "hello" } },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(r.details.mutation, true, "chat.postMessage classified as mutation");
  assert.equal(calls[0].body.channel, "C0123456789");
  assert.equal(calls[0].body.thread_ts, "1715600000.000100");
  assert.equal(calls[0].body.text, "hello");
  assert.match(r.content[0].text, /chat\.postMessage ok.*ts=1715600001\.000200/);
}

// Case 4: as_user:true uses SLACK_USER_TOKEN.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { ok: true, messages: { total: 0, matches: [] } },
  }), calls);
  createSlackApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute(
    "tc3",
    { method: "search.messages", params: { query: "canvas sink" }, as_user: true },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].headers.Authorization, "Bearer xoxp-TEST-user-token", "user token used when as_user:true");
  assert.equal(r.details.as_user, true);
  assert.equal(r.details.mutation, false);
}

// Case 5: missing SLACK_BOT_TOKEN returns isError.
{
  const fakePi = makeFakePi();
  const envNoBot = { ...baseEnv, SLACK_BOT_TOKEN: undefined };
  createSlackApiFactory({ env: envNoBot })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute("tc4", { method: "auth.test" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /SLACK_BOT_TOKEN is not set/);
}

// Case 5b: missing SLACK_USER_TOKEN when as_user:true returns isError.
{
  const fakePi = makeFakePi();
  const envNoUser = { ...baseEnv, SLACK_USER_TOKEN: undefined };
  createSlackApiFactory({ env: envNoUser })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute(
    "tc4b",
    { method: "search.messages", params: { query: "q" }, as_user: true },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /SLACK_USER_TOKEN is not set/);
}

// Case 6: disallowed method returns isError with allowlist hint.
{
  const fakePi = makeFakePi();
  createSlackApiFactory({ env: baseEnv })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute("tc5", { method: "admin.conversations.archive" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not in allowlist/);
  assert.match(r.content[0].text, /SLACK_METHOD_ALLOWLIST/);
}

// Case 6b: SLACK_METHOD_ALLOWLIST env override unlocks a non-default method.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({ payload: { ok: true } }), calls);
  const envWithAllow = { ...baseEnv, SLACK_METHOD_ALLOWLIST: "admin.conversations.archive,auth.test" };
  createSlackApiFactory({ env: envWithAllow, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute("tc5b", { method: "admin.conversations.archive", params: { channel_id: "C1" } }, undefined, undefined, {});
  assert.equal(r.isError, undefined, "env-allowed method goes through");
  // And the default allowlist's other methods are NOT implicitly allowed when override is set.
  const r2 = await tool.execute("tc5c", { method: "chat.postMessage", params: { channel: "C1", text: "x" } }, undefined, undefined, {});
  assert.equal(r2.isError, true, "override replaces the default list");
  assert.match(r2.content[0].text, /not in allowlist/);
}

// Case 7: ok:false response → isError with .error preserved.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      ok: false,
      error: "not_in_channel",
      response_metadata: { messages: ["The bot user is not a member of the channel."] },
    },
  }));
  createSlackApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute(
    "tc6",
    { method: "chat.postMessage", params: { channel: "C0123456789", text: "hi" } },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not_in_channel/);
  assert.match(r.content[0].text, /not a member/);
}

// Case 8: HTTP 429 → isError with Retry-After surfaced.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    status: 429,
    ok: false,
    headers: { "retry-after": "30" },
    payload: { ok: false, error: "ratelimited" },
  }));
  createSlackApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute(
    "tc7",
    { method: "chat.postMessage", params: { channel: "C0123456789", text: "spam" } },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /rate-limited/);
  assert.match(r.content[0].text, /Retry-After: 30/);
  assert.match(r.content[0].text, /Do NOT retry/);
}

// Case 9: xox*- fragments redacted in error messages.
{
  const fakePi = makeFakePi();
  const fakeFetch = async () => { throw new Error("Bad token: xoxb-LEAKED-1234 leaked"); };
  createSlackApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute("tc8", { method: "auth.test" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.ok(!r.content[0].text.includes("xoxb-LEAKED-1234"), "raw token redacted");
  assert.match(r.content[0].text, /xox\[REDACTED\]/);
}

// Case 9b: xoxp-, xoxa-, xoxr-, xoxs- all redacted via redactSecrets.
{
  const { redactSecrets } = __slackApiTest;
  const cases = ["xoxb-abc-123", "xoxp-abc-123", "xoxa-2-abc", "xoxr-deadbeef", "xoxs-foo"];
  for (const tok of cases) {
    const out = redactSecrets(`leaked ${tok} here`);
    assert.ok(!out.includes(tok), `${tok} redacted`);
    assert.match(out, /xox\[REDACTED\]/);
  }
  // Authorization header redacted too.
  const auth = redactSecrets("curl -H 'Authorization: Bearer xoxb-secret-token' ...");
  assert.match(auth, /Authorization: \[REDACTED\]/);
}

// Case 10: AbortSignal aborts cleanly with a clear message.
{
  const fakePi = makeFakePi();
  const fakeFetch = async (_url, init) => {
    if (init?.signal?.aborted) {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }
    throw new Error("should not reach");
  };
  createSlackApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const ac = new AbortController(); ac.abort();
  const r = await tool.execute("tc9", { method: "auth.test" }, ac.signal, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /aborted/i);
}

// Case 11: empty method is rejected with a clear message.
{
  const fakePi = makeFakePi();
  createSlackApiFactory({ env: baseEnv })(fakePi);
  const tool = findTool(fakePi, "slack_api");
  const r = await tool.execute("tc10", { method: "" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /method is required/);
}

// Case 12: DEFAULT_ALLOWLIST and MUTATION_METHODS sanity (export contract).
{
  const { DEFAULT_ALLOWLIST, MUTATION_METHODS } = __slackApiTest;
  assert.ok(DEFAULT_ALLOWLIST.includes("chat.postMessage"));
  assert.ok(DEFAULT_ALLOWLIST.includes("conversations.replies"));
  assert.ok(DEFAULT_ALLOWLIST.includes("search.messages"));
  assert.ok(MUTATION_METHODS.has("chat.postMessage"));
  assert.ok(MUTATION_METHODS.has("conversations.invite"));
  assert.ok(!MUTATION_METHODS.has("auth.test"));
  assert.ok(!MUTATION_METHODS.has("conversations.replies"));
  // Every mutation method must also be in the default allowlist.
  for (const m of MUTATION_METHODS) {
    assert.ok(DEFAULT_ALLOWLIST.includes(m), `mutation method ${m} also in default allowlist`);
  }
}

console.log("slack-api tests passed");
