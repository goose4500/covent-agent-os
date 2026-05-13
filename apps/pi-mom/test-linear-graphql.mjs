// Tests for extensions/linear-graphql.ts.
//
// The factory registers ONE tool: linear_graphql. Tests inject a fake `pi`
// ExtensionAPI + a fake fetch + an env snapshot, then drive execute() with
// crafted GraphQL responses to verify the tool is dumb-but-correct: it posts
// {query, variables, operationName} to the configured URL with the
// API-key-style Authorization header, surfaces data verbatim on success,
// flags errors[] + extensions.code === "RATELIMITED" as isError, and redacts
// `lin_api_*` fragments from any error text it returns.

import assert from "node:assert/strict";
import { createLinearGraphqlFactory } from "../../extensions/linear-graphql.ts";

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
  LINEAR_API_KEY: "lin_api_TEST",
  LINEAR_TEAM_ID: "team-abc",
  LINEAR_PROJECT_ID: "project-xyz",
  LINEAR_STATE_ID: "state-backlog",
};

function makeFakeFetch(handler, recorded = []) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    recorded.push({ url, init, body });
    const response = await handler(body, recorded.length);
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      async json() { return response.payload || {}; },
    };
  };
}

// Case 1: factory registers exactly one tool named linear_graphql with the
// expected required parameter shape.
{
  const fakePi = makeFakePi();
  createLinearGraphqlFactory({ env: baseEnv })(fakePi);
  assert.equal(fakePi.registered.length, 1, "one tool registered");
  const tool = findTool(fakePi, "linear_graphql");
  assert.deepEqual(tool.parameters.required, ["query"]);
}

// Case 2: happy path posts to the right URL with the right headers and body,
// returns parsed JSON via details.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: { issue: { id: "i_1", identifier: "FE-1", title: "T", url: "https://linear.app/x/issue/FE-1" } },
    },
  }), calls);
  createLinearGraphqlFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "linear_graphql");
  const r = await tool.execute(
    "tc1",
    {
      query: "query Q($id:String!){ issue(id:$id){ id identifier title url } }",
      variables: { id: "FE-1" },
      operationName: "Q",
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.linear.app/graphql", "default endpoint");
  // Personal API key style: Authorization is the raw key, NO `Bearer` prefix.
  assert.equal(calls[0].init.headers.Authorization, "lin_api_TEST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].body.query.includes("issue(id:$id)"), true);
  assert.deepEqual(calls[0].body.variables, { id: "FE-1" });
  assert.equal(calls[0].body.operationName, "Q");
  // Parsed JSON surfaced in details.data.
  assert.equal(r.details.data.issue.identifier, "FE-1");
  // Text channel mentions the top-level data field for quick model scan.
  assert.match(r.content[0].text, /issue/);
}

// Case 3: LINEAR_API_URL override is honored.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({ payload: { data: {} } }), calls);
  const env = { ...baseEnv, LINEAR_API_URL: "https://example.test/graphql" };
  createLinearGraphqlFactory({ env, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "linear_graphql");
  await tool.execute("tc2", { query: "{ viewer { id } }" }, undefined, undefined, {});
  assert.equal(calls[0].url, "https://example.test/graphql");
}

// Case 4: missing LINEAR_API_KEY returns isError with a clear reason and does
// NOT call fetch.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({ payload: { data: {} } }), calls);
  const env = { ...baseEnv, LINEAR_API_KEY: undefined };
  createLinearGraphqlFactory({ env, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "linear_graphql");
  const r = await tool.execute("tc3", { query: "{ viewer { id } }" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /LINEAR_API_KEY/);
  assert.equal(calls.length, 0, "no fetch when API key missing");
}

// Case 5: RATELIMITED error (HTTP 200 with errors[].extensions.code) is
// surfaced as isError with retry guidance.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      errors: [
        { message: "Rate limited", extensions: { code: "RATELIMITED" } },
      ],
    },
  }));
  createLinearGraphqlFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "linear_graphql");
  const r = await tool.execute("tc4", { query: "{ viewer { id } }" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /rate-limited/i);
  assert.match(r.content[0].text, /RATELIMITED/);
  assert.match(r.content[0].text, /back off/i);
  // Raw errors surfaced in details for downstream reasoning.
  assert.equal(r.details.errors[0].extensions.code, "RATELIMITED");
}

// Case 6: GraphQL error response redacts `lin_api_*` fragments from text.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    payload: { errors: [{ message: "Bad token: lin_api_LEAKAGE", extensions: { code: "AUTHENTICATION_ERROR" } }] },
  }));
  createLinearGraphqlFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "linear_graphql");
  const r = await tool.execute("tc5", { query: "{ viewer { id } }" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.ok(!r.content[0].text.includes("LEAKAGE"), "secret redacted in error text");
  assert.match(r.content[0].text, /\[REDACTED\]/);
}

// Case 7: AbortSignal returns a clean isError with "aborted".
{
  const fakeFetch = async (_url, init) => {
    if (init?.signal?.aborted) {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }
    throw new Error("should not reach");
  };
  const fakePi = makeFakePi();
  createLinearGraphqlFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "linear_graphql");
  const ac = new AbortController(); ac.abort();
  const r = await tool.execute("tc6", { query: "{ viewer { id } }" }, ac.signal, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /aborted/i);
}

console.log("linear-graphql tests passed");
