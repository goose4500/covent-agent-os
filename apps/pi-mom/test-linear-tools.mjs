// Tests for extensions/linear-tools.ts.
//
// The factory registers THREE tools: linear_search_issues,
// linear_create_issue, linear_add_comment. Tests inject a fake `pi`
// ExtensionAPI + a fake fetch + an env snapshot, then drive each tool's
// execute() with crafted GraphQL responses.

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

// Case 1: factory registers exactly three tools with the expected names.
{
  const fakePi = makeFakePi();
  createLinearToolsFactory({ env: baseEnv })(fakePi);
  assert.equal(fakePi.registered.length, 3, "three tools registered");
  assert.deepEqual(
    fakePi.registered.map((t) => t.name).sort(),
    ["linear_add_comment", "linear_create_issue", "linear_search_issues"],
  );
  const create = findTool(fakePi, "linear_create_issue");
  assert.deepEqual(create.parameters.required, ["title", "description"]);
  const search = findTool(fakePi, "linear_search_issues");
  assert.deepEqual(search.parameters.required, ["query"]);
  const comment = findTool(fakePi, "linear_add_comment");
  assert.deepEqual(comment.parameters.required, ["issue_id", "body"]);
}

// Case 2: linear_create_issue happy path.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_1", identifier: "FE-1", title: "T", url: "https://linear.app/x/issue/FE-1" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc1", { title: "T", description: "D", priority: 2 }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(r.details.identifier, "FE-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.variables.input.priority, 2);
  assert.equal(calls[0].body.variables.input.projectId, "project-xyz");
}

// Case 3: linear_search_issues — happy path returns ranked list.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issues: {
          nodes: [
            { id: "i_1", identifier: "FE-100", title: "Stream rotation bug", url: "https://linear.app/x/issue/FE-100", state: { name: "Backlog" }, priority: 2, updatedAt: "2026-05-12T00:00:00Z" },
            { id: "i_2", identifier: "FE-99", title: "Slack streaming retry", url: "https://linear.app/x/issue/FE-99", state: { name: "In Progress" }, priority: 1, updatedAt: "2026-05-11T00:00:00Z" },
          ],
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const search = findTool(fakePi, "linear_search_issues");
  const r = await search.execute("tc2", { query: "streaming", limit: 5 }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(r.details.matches.length, 2);
  assert.equal(r.details.matches[0].identifier, "FE-100");
  assert.match(r.content[0].text, /FE-100/);
  assert.match(r.content[0].text, /FE-99/);
  // Search filter built correctly.
  const body = calls[0].body;
  assert.equal(body.variables.filter.searchableContent.contains, "streaming");
  assert.equal(body.variables.filter.team.id.eq, "team-abc", "team filter applied by default");
  assert.equal(body.variables.first, 5);
}

// Case 4: linear_search_issues — no matches returns a helpful "safe to create" hint.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    payload: { data: { issues: { nodes: [] } } },
  }));
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const search = findTool(fakePi, "linear_search_issues");
  const r = await search.execute("tc3", { query: "obscure topic" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(r.details.matches.length, 0);
  assert.match(r.content[0].text, /No Linear issues matched/);
  assert.match(r.content[0].text, /Safe to create/);
}

// Case 5: linear_search_issues with team_only=false drops the team filter.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { data: { issues: { nodes: [] } } },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const search = findTool(fakePi, "linear_search_issues");
  await search.execute("tc4", { query: "x", team_only: false }, undefined, undefined, {});
  assert.equal(calls[0].body.variables.filter.team, undefined, "team filter omitted when team_only=false");
}

// Case 6: linear_add_comment via GraphQL UUID — single mutation call.
{
  const fakePi = makeFakePi();
  const calls = [];
  const uuid = "11111111-2222-3333-4444-555555555555";
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        commentCreate: {
          success: true,
          comment: { id: "c_1", url: "https://linear.app/x/issue/FE-1#comment-c_1", body: "Hi" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const comment = findTool(fakePi, "linear_add_comment");
  const r = await comment.execute("tc5", { issue_id: uuid, body: "Adding context from Slack thread X." }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(r.details.url, "https://linear.app/x/issue/FE-1#comment-c_1");
  assert.equal(calls.length, 1, "no lookup call when UUID is passed");
  assert.equal(calls[0].body.variables.input.issueId, uuid);
}

// Case 7: linear_add_comment via human identifier (FE-99) does a lookup then comment.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch((body) => {
    if (body.query.includes("IssueLookup")) {
      return { payload: { data: { issue: { id: "uuid-resolved-99", identifier: "FE-99" } } } };
    }
    return {
      payload: {
        data: {
          commentCreate: {
            success: true,
            comment: { id: "c_2", url: "https://linear.app/x/issue/FE-99#comment-c_2", body: "Body" },
          },
        },
      },
    };
  }, calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const comment = findTool(fakePi, "linear_add_comment");
  const r = await comment.execute("tc6", { issue_id: "FE-99", body: "Body" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 2, "lookup then commentCreate");
  assert.equal(calls[0].body.variables.id, "FE-99");
  assert.equal(calls[1].body.variables.input.issueId, "uuid-resolved-99", "comment uses resolved UUID");
}

// Case 8: linear_add_comment lookup miss returns isError.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch((body) => {
    if (body.query.includes("IssueLookup")) {
      return { payload: { data: { issue: null } } };
    }
    throw new Error("commentCreate should not be called when lookup misses");
  });
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const comment = findTool(fakePi, "linear_add_comment");
  const r = await comment.execute("tc7", { issue_id: "FE-NOPE", body: "Body" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not found/i);
}

// Case 9: all three tools surface missing LINEAR_API_KEY as isError.
{
  const envNoKey = { ...baseEnv, LINEAR_API_KEY: undefined };
  for (const name of ["linear_search_issues", "linear_create_issue", "linear_add_comment"]) {
    const fakePi = makeFakePi();
    createLinearToolsFactory({ env: envNoKey })(fakePi);
    const tool = findTool(fakePi, name);
    const args = name === "linear_create_issue"
      ? { title: "t", description: "d" }
      : name === "linear_add_comment"
        ? { issue_id: "abc", body: "b" }
        : { query: "q" };
    const r = await tool.execute("x", args, undefined, undefined, {});
    assert.equal(r.isError, true, `${name} returns isError when API key missing`);
    assert.match(r.content[0].text, /LINEAR_API_KEY/);
  }
}

// Case 10: AbortSignal aborts all three tools with a clear message.
{
  const fakeFetch = async (_url, init) => {
    if (init?.signal?.aborted) {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }
    throw new Error("should not reach");
  };
  for (const name of ["linear_search_issues", "linear_create_issue", "linear_add_comment"]) {
    const fakePi = makeFakePi();
    createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
    const tool = findTool(fakePi, name);
    const ac = new AbortController(); ac.abort();
    const args = name === "linear_create_issue"
      ? { title: "t", description: "d" }
      : name === "linear_add_comment"
        ? { issue_id: "11111111-2222-3333-4444-555555555555", body: "b" }
        : { query: "q" };
    const r = await tool.execute("x", args, ac.signal, undefined, {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /aborted/i);
  }
}

// Case 11: GraphQL error response is redacted and surfaced as isError.
{
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => ({
    payload: { errors: [{ message: "Bad token: lin_api_LEAKAGE" }] },
  }));
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const search = findTool(fakePi, "linear_search_issues");
  const r = await search.execute("x", { query: "q" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.ok(!r.content[0].text.includes("LEAKAGE"), "secret redacted in error path");
  assert.match(r.content[0].text, /\[REDACTED\]/);
}

// Case 12: linear_create_issue with params.team_id overrides env.LINEAR_TEAM_ID.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_2", identifier: "FE-2", title: "T", url: "https://linear.app/x/issue/FE-2" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc12", { title: "T", description: "D", team_id: "team-override-1" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].body.variables.input.teamId, "team-override-1", "team_id param overrides env");
  assert.notEqual(calls[0].body.variables.input.teamId, "team-abc");
}

// Case 13: linear_create_issue with params.project_id overrides env.LINEAR_PROJECT_ID.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_3", identifier: "FE-3", title: "T", url: "https://linear.app/x/issue/FE-3" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc13", { title: "T", description: "D", project_id: "project-override-1" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].body.variables.input.projectId, "project-override-1", "project_id param overrides env");
  assert.notEqual(calls[0].body.variables.input.projectId, "project-xyz");
}

// Case 14: linear_create_issue with BOTH team_id and project_id overrides.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_4", identifier: "FE-4", title: "T", url: "https://linear.app/x/issue/FE-4" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute(
    "tc14",
    { title: "T", description: "D", team_id: "team-both", project_id: "project-both" },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].body.variables.input.teamId, "team-both");
  assert.equal(calls[0].body.variables.input.projectId, "project-both");
}

// Case 15: linear_create_issue with EMPTY-STRING team_id falls back to env.LINEAR_TEAM_ID.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_5", identifier: "FE-5", title: "T", url: "https://linear.app/x/issue/FE-5" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc15", { title: "T", description: "D", team_id: "" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].body.variables.input.teamId, "team-abc", "empty string falls back to env");
}

// Case 16: linear_create_issue with whitespace-only project_id falls back to env.LINEAR_PROJECT_ID.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_6", identifier: "FE-6", title: "T", url: "https://linear.app/x/issue/FE-6" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc16", { title: "T", description: "D", project_id: "   " }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].body.variables.input.projectId, "project-xyz", "whitespace-only falls back to env");
}

// Case 17: linear_create_issue with no env.LINEAR_TEAM_ID AND no params.team_id → isError.
{
  const envNoTeam = { ...baseEnv, LINEAR_TEAM_ID: undefined };
  const fakePi = makeFakePi();
  const fakeFetch = makeFakeFetch(() => {
    throw new Error("fetch should not be called when team is missing");
  });
  createLinearToolsFactory({ env: envNoTeam, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc17", { title: "T", description: "D" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /LINEAR_TEAM_ID is not set/);
}

// Case 18: linear_create_issue with no env.LINEAR_TEAM_ID but params.team_id="team-xyz" succeeds.
{
  const envNoTeam = { ...baseEnv, LINEAR_TEAM_ID: undefined };
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_7", identifier: "FE-7", title: "T", url: "https://linear.app/x/issue/FE-7" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: envNoTeam, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc18", { title: "T", description: "D", team_id: "team-xyz" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].body.variables.input.teamId, "team-xyz");
}

console.log("linear-tools tests passed");
