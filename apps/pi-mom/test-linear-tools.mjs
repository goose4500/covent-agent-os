// Tests for extensions/linear-tools.ts.
//
// We test the factory + execute() in isolation using a fake `pi` ExtensionAPI
// that captures registerTool() calls, plus an injected fake `fetch` and env.
// No Pi SDK boot, no network.

import assert from "node:assert/strict";
import { createLinearToolsFactory } from "../../extensions/linear-tools.ts";

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

const baseEnv = {
  LINEAR_API_KEY: "lin_api_TEST",
  LINEAR_TEAM_ID: "team-abc",
  LINEAR_PROJECT_ID: "project-xyz",
  LINEAR_STATE_ID: "state-backlog",
};

function makeFetchOk(issue, recordedCalls = []) {
  return async (url, init) => {
    recordedCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { issueCreate: { success: true, issue } } };
      },
    };
  };
}

// Case 1: factory registers exactly one tool with the expected name + schema.
{
  const fakePi = makeFakePi();
  const factory = createLinearToolsFactory({ env: baseEnv });
  factory(fakePi);
  assert.equal(fakePi.registered.length, 1, "exactly one tool registered");
  const tool = fakePi.registered[0];
  assert.equal(tool.name, "linear_create_issue");
  assert.equal(tool.label, "Create Linear issue");
  assert.ok(tool.parameters?.properties?.title, "schema has title");
  assert.ok(tool.parameters?.properties?.description, "schema has description");
  assert.deepEqual(tool.parameters.required, ["title", "description"]);
  assert.ok(Array.isArray(tool.promptGuidelines), "promptGuidelines present");
  assert.ok(tool.description.length > 80, "description tells the model when to use it");
}

// Case 2: happy path — execute() returns content with identifier + URL.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFetchOk(
    { id: "issue_1", identifier: "DIS-42", title: "Stream rotation flakiness", url: "https://linear.app/example/issue/DIS-42" },
    calls,
  );
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = fakePi.registered[0];

  const result = await tool.execute(
    "tc_1",
    {
      title: "  Stream rotation flakiness  ",
      description: "## Problem\nStreaming sometimes errors past 11k.\n\n## ACs\n- No msg_too_long",
      priority: 2,
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(result.isError, undefined, "no error flag on success");
  assert.equal(result.details.identifier, "DIS-42");
  assert.equal(result.details.url, "https://linear.app/example/issue/DIS-42");
  assert.match(result.content[0].text, /DIS-42/);
  assert.match(result.content[0].text, /https:\/\/linear\.app\/example\/issue\/DIS-42/);

  // Verify the fetch call carried the right headers + variables.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "lin_api_TEST");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.variables.input.teamId, "team-abc");
  assert.equal(body.variables.input.projectId, "project-xyz");
  assert.equal(body.variables.input.stateId, "state-backlog");
  assert.equal(body.variables.input.priority, 2);
  assert.equal(body.variables.input.title, "Stream rotation flakiness", "title trimmed");
}

// Case 3: title longer than 240 chars gets clamped.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFetchOk(
    { id: "i2", identifier: "DIS-43", title: "long", url: "https://linear.app/x/issue/DIS-43" },
    calls,
  );
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = fakePi.registered[0];
  const longTitle = "a".repeat(400);
  await tool.execute("tc_2", { title: longTitle, description: "x" }, undefined, undefined, {});
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.variables.input.title.length, 240, "title clamped to 240");
  assert.ok(body.variables.input.title.endsWith("..."), "ellipsis suffix on clamp");
}

// Case 4: missing LINEAR_API_KEY → isError, human-readable text.
{
  const fakePi = makeFakePi();
  createLinearToolsFactory({ env: { ...baseEnv, LINEAR_API_KEY: undefined } })(fakePi);
  const tool = fakePi.registered[0];
  const r = await tool.execute("tc_3", { title: "x", description: "y" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /LINEAR_API_KEY/);
}

// Case 5: missing LINEAR_TEAM_ID → isError, human-readable text.
{
  const fakePi = makeFakePi();
  createLinearToolsFactory({ env: { ...baseEnv, LINEAR_TEAM_ID: undefined } })(fakePi);
  const tool = fakePi.registered[0];
  const r = await tool.execute("tc_4", { title: "x", description: "y" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /LINEAR_TEAM_ID/);
}

// Case 6: GraphQL error response → isError, redacted reason.
{
  const fakePi = makeFakePi();
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { errors: [{ message: "Argument 'input' is invalid" }] };
    },
  });
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = fakePi.registered[0];
  const r = await tool.execute("tc_5", { title: "x", description: "y" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Argument 'input' is invalid/);
}

// Case 7: HTTP error (non-2xx) → isError with status text.
{
  const fakePi = makeFakePi();
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    async json() {
      return {};
    },
  });
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = fakePi.registered[0];
  const r = await tool.execute("tc_6", { title: "x", description: "y" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /HTTP 401/);
}

// Case 8: AbortSignal → isError with "aborted" text.
{
  const fakePi = makeFakePi();
  const fakeFetch = async (_url, init) => {
    // Mimic real fetch behavior on abort: reject with AbortError.
    if (init?.signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    throw new Error("should not have been called without abort");
  };
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = fakePi.registered[0];
  const ac = new AbortController();
  ac.abort();
  const r = await tool.execute("tc_7", { title: "x", description: "y" }, ac.signal, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /aborted/i);
}

// Case 9: project + state are omitted from input when env vars are unset.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFetchOk(
    { id: "i3", identifier: "DIS-44", title: "t", url: "https://linear.app/x/issue/DIS-44" },
    calls,
  );
  createLinearToolsFactory({
    env: { LINEAR_API_KEY: "lin_api_TEST", LINEAR_TEAM_ID: "team-abc" },
    fetchImpl: fakeFetch,
  })(fakePi);
  const tool = fakePi.registered[0];
  await tool.execute("tc_8", { title: "x", description: "y" }, undefined, undefined, {});
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.variables.input.projectId, undefined);
  assert.equal(body.variables.input.stateId, undefined);
  assert.equal(body.variables.input.priority, undefined);
}

// Case 10: secrets are redacted in error text (defense in depth even though
// Linear wouldn't normally echo the API key — guard against future changes).
{
  const fakePi = makeFakePi();
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { errors: [{ message: "Bad Authorization: lin_api_SECRETLEAK" }] };
    },
  });
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = fakePi.registered[0];
  const r = await tool.execute("tc_9", { title: "x", description: "y" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.ok(!r.content[0].text.includes("SECRETLEAK"), "secret redacted from error path");
  assert.match(r.content[0].text, /\[REDACTED\]/);
}

console.log("linear-tools tests passed");
