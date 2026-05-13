// Tests for extensions/github-api.ts.
//
// The factory registers ONE tool: github_api. Tests inject a fake `pi`
// ExtensionAPI + a fake fetch + an env snapshot, then drive the tool's
// execute() with crafted REST and GraphQL responses.

import assert from "node:assert/strict";
import { createGithubApiFactory } from "../../extensions/github-api.ts";

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
  GITHUB_TOKEN: "ghp_TESTTOKEN_FAKE_VALUE_FOR_UNIT_TESTS",
};

// Wrap a handler that returns { ok?, status?, payload?, contentType?, headers? }
// into a fetch-compatible function. `recorded` captures (url, init) for asserts.
function makeFakeFetch(handler, recorded = []) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    recorded.push({ url, init, body });
    const response = await handler({ url, init, body }, recorded.length);
    const status = response.status ?? 200;
    const contentType = response.contentType ?? "application/json";
    const responseHeaders = new Map(
      Object.entries({ "content-type": contentType, ...(response.headers || {}) })
        .map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    const headers = {
      get: (k) => responseHeaders.get(String(k).toLowerCase()) ?? null,
      forEach: (cb) => { for (const [k, v] of responseHeaders) cb(v, k); },
      entries: () => responseHeaders.entries(),
    };
    const rawText = response.payload == null
      ? ""
      : typeof response.payload === "string"
        ? response.payload
        : JSON.stringify(response.payload);
    return {
      ok: response.ok ?? (status >= 200 && status < 300),
      status,
      headers,
      async text() { return rawText; },
    };
  };
}

// Case 1: factory registers exactly one tool named github_api.
{
  const fakePi = makeFakePi();
  createGithubApiFactory({ env: baseEnv })(fakePi);
  assert.equal(fakePi.registered.length, 1, "one tool registered");
  const tool = findTool(fakePi, "github_api");
  assert.deepEqual(tool.parameters.required, ["path"]);
}

// Case 2: REST GET happy path — URL composition (with leading /), standard
// headers present, no Content-Type when no body.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { number: 7, title: "Hello PR", state: "open" },
  }), calls);
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute("tc2", { path: "/repos/o/r/pulls/7" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/o/r/pulls/7");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${baseEnv.GITHUB_TOKEN}`);
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0].init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(calls[0].init.headers["Content-Type"], undefined, "no Content-Type without body");
  assert.equal(r.details.mutation, false);
  assert.equal(r.details.body.number, 7);

  // Without leading slash works too.
  const calls2 = [];
  const fakeFetch2 = makeFakeFetch(() => ({ payload: { ok: true } }), calls2);
  const fakePi2 = makeFakePi();
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch2 })(fakePi2);
  const tool2 = findTool(fakePi2, "github_api");
  await tool2.execute("tc2b", { path: "repos/o/r/pulls/7" }, undefined, undefined, {});
  assert.equal(calls2[0].url, "https://api.github.com/repos/o/r/pulls/7", "path without leading / still resolves");
}

// Case 3: REST POST with body — Content-Type set, body JSON, mutation:true.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    status: 201,
    payload: { id: 42, body: "Hi from Pi" },
  }), calls);
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute(
    "tc3",
    {
      method: "POST",
      path: "/repos/o/r/issues/7/comments",
      body: { body: "Hi from Pi" },
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(calls[0].body, { body: "Hi from Pi" });
  assert.equal(r.details.mutation, true);
  assert.equal(r.details.status, 201);
}

// Case 4: GraphQL routing via path="graphql" — POST to /graphql endpoint,
// body {query, variables}, mutation:true when query contains "mutation".
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { data: { addComment: { commentEdge: { node: { id: "c_1" } } } } },
  }), calls);
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute(
    "tc4",
    {
      path: "graphql",
      body: {
        query: "mutation AddComment($subjectId: ID!, $body: String!) { addComment(input: {subjectId: $subjectId, body: $body}) { commentEdge { node { id } } } }",
        variables: { subjectId: "x", body: "Hi" },
      },
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].body.variables.subjectId, "x");
  assert.equal(r.details.mutation, true, "GraphQL mutation classified");
  assert.ok(r.details.data?.addComment, "data preserved");
}

// Case 5: GraphQL routing via path="/graphql" works the same as "graphql".
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { data: { viewer: { login: "octocat" } } },
  }), calls);
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute(
    "tc5",
    { path: "/graphql", body: { query: "query { viewer { login } }" } },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].url, "https://api.github.com/graphql");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(r.details.mutation, false, "query (no mutation keyword) classified as read");
}

// Case 6: custom headers merge over defaults — caller wins.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { data: { node: null } },
  }), calls);
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  await tool.execute(
    "tc6",
    {
      path: "graphql",
      body: { query: "query { __typename }" },
      headers: { "GraphQL-Features": "sub_issues", Accept: "application/vnd.github.special+json" },
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(calls[0].init.headers["GraphQL-Features"], "sub_issues");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github.special+json", "caller header overrides default");
  // Defaults still present where not overridden.
  assert.equal(calls[0].init.headers["X-GitHub-Api-Version"], "2022-11-28");
}

// Case 7: missing GITHUB_TOKEN → isError.
{
  const fakePi = makeFakePi();
  createGithubApiFactory({ env: { ...baseEnv, GITHUB_TOKEN: undefined } })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute("tc7", { path: "/octocat" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /GITHUB_TOKEN/);
}

// Case 8: GITHUB_API_URL override is respected (e.g. GitHub Enterprise).
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({ payload: { ok: true } }), calls);
  const env = { ...baseEnv, GITHUB_API_URL: "https://ghe.corp.example/api/v3" };
  createGithubApiFactory({ env, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  await tool.execute("tc8a", { path: "/repos/o/r" }, undefined, undefined, {});
  assert.equal(calls[0].url, "https://ghe.corp.example/api/v3/repos/o/r", "REST hits override base");

  // And GraphQL too.
  await tool.execute(
    "tc8b",
    { path: "graphql", body: { query: "query { viewer { login } }" } },
    undefined,
    undefined,
    {},
  );
  assert.equal(calls[1].url, "https://ghe.corp.example/api/v3/graphql", "GraphQL hits override base");
}

// Case 9: REST 4xx → isError with parsed body preserved.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    ok: false,
    status: 404,
    payload: { message: "Not Found", documentation_url: "https://docs.github.com/rest" },
  }));
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute("tc9", { path: "/repos/o/r/nope" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /404/);
  assert.equal(r.details.status, 404);
  assert.equal(r.details.body.message, "Not Found");
}

// Case 10: GraphQL errors[] non-empty → isError with data AND errors preserved.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: { repository: null },
      errors: [{ message: "Could not resolve to a Repository with the name 'o/r'." }],
    },
  }));
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute(
    "tc10",
    { path: "graphql", body: { query: "query { repository(owner: \"o\", name: \"r\") { name } }" } },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Could not resolve/);
  assert.deepEqual(r.details.data, { repository: null }, "partial data preserved");
  assert.equal(r.details.errors.length, 1);
}

// Case 11: 403 with Retry-After → isError surfacing the header.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    ok: false,
    status: 403,
    headers: { "Retry-After": "60" },
    payload: { message: "You have exceeded a secondary rate limit." },
  }));
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute(
    "tc11",
    { method: "POST", path: "/repos/o/r/issues", body: { title: "spam" } },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /rate limit/i);
  assert.match(r.content[0].text, /Retry-After: 60s/);
  assert.equal(r.details.retryAfter, "60");
  assert.equal(r.details.mutation, true);
}

// Case 12: token fragments redacted in error messages.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    ok: false,
    status: 401,
    payload: { message: "Bad credentials: ghp_LEAKEDTOKEN1234567890" },
  }));
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const r = await tool.execute("tc12", { path: "/user" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.ok(!r.content[0].text.includes("LEAKEDTOKEN"), "ghp_ token fragment redacted in error path");
  assert.match(r.content[0].text, /\[REDACTED\]/);

  // ghs_ tokens get redacted too.
  const fakePi2 = makeFakePi();
  const fakeFetch2 = makeFakeFetch(() => ({
    ok: false,
    status: 401,
    payload: { message: "ghs_SERVERSIDETOKENVALUE bad" },
  }));
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch2 })(fakePi2);
  const tool2 = findTool(fakePi2, "github_api");
  const r2 = await tool2.execute("tc12b", { path: "/user" }, undefined, undefined, {});
  assert.equal(r2.isError, true);
  assert.ok(!r2.content[0].text.includes("SERVERSIDETOKENVALUE"), "ghs_ token fragment redacted");
}

// Case 13: AbortSignal aborts the request with a clear message.
{
  const fakePi = makeFakePi();
  const fakeFetch = async (_url, init) => {
    if (init?.signal?.aborted) {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }
    throw new Error("should not reach");
  };
  createGithubApiFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const tool = findTool(fakePi, "github_api");
  const ac = new AbortController(); ac.abort();
  const r = await tool.execute("tc13", { path: "/octocat" }, ac.signal, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /aborted/i);
}

console.log("github-api tests passed");
