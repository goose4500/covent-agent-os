// Tests for extensions/linear-tools.ts.
//
// The factory registers FOUR tools: linear_list_teams,
// linear_search_issues, linear_create_issue, linear_add_comment. Tests
// inject a fake `pi` ExtensionAPI + a fake fetch + an env snapshot, then
// drive each tool's execute() with crafted GraphQL responses.

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

// Case 1: factory registers exactly four tools with the expected names.
{
  const fakePi = makeFakePi();
  createLinearToolsFactory({ env: baseEnv })(fakePi);
  assert.equal(fakePi.registered.length, 4, "four tools registered");
  assert.deepEqual(
    fakePi.registered.map((t) => t.name).sort(),
    ["linear_add_comment", "linear_create_issue", "linear_list_teams", "linear_search_issues"],
  );
  const create = findTool(fakePi, "linear_create_issue");
  assert.deepEqual(create.parameters.required, ["title", "description"]);
  // team_id and project_id MUST be optional so the env-default flow keeps working.
  assert.ok(!create.parameters.required.includes("team_id"), "team_id is optional");
  assert.ok(!create.parameters.required.includes("project_id"), "project_id is optional");
  const search = findTool(fakePi, "linear_search_issues");
  assert.deepEqual(search.parameters.required, ["query"]);
  assert.ok(!search.parameters.required.includes("team_id"), "search team_id is optional");
  const comment = findTool(fakePi, "linear_add_comment");
  assert.deepEqual(comment.parameters.required, ["issue_id", "body"]);
  const teams = findTool(fakePi, "linear_list_teams");
  // linear_list_teams takes no required params.
  assert.deepEqual(teams.parameters.required ?? [], []);
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

// Case 9: all four tools surface missing LINEAR_API_KEY as isError.
{
  const envNoKey = { ...baseEnv, LINEAR_API_KEY: undefined };
  for (const name of ["linear_list_teams", "linear_search_issues", "linear_create_issue", "linear_add_comment"]) {
    const fakePi = makeFakePi();
    createLinearToolsFactory({ env: envNoKey })(fakePi);
    const tool = findTool(fakePi, name);
    const args = name === "linear_create_issue"
      ? { title: "t", description: "d" }
      : name === "linear_add_comment"
        ? { issue_id: "abc", body: "b" }
        : name === "linear_list_teams"
          ? {}
          : { query: "q" };
    const r = await tool.execute("x", args, undefined, undefined, {});
    assert.equal(r.isError, true, `${name} returns isError when API key missing`);
    assert.match(r.content[0].text, /LINEAR_API_KEY/);
  }
}

// Case 10: AbortSignal aborts all four tools with a clear message.
{
  const fakeFetch = async (_url, init) => {
    if (init?.signal?.aborted) {
      const e = new Error("aborted"); e.name = "AbortError"; throw e;
    }
    throw new Error("should not reach");
  };
  for (const name of ["linear_list_teams", "linear_search_issues", "linear_create_issue", "linear_add_comment"]) {
    const fakePi = makeFakePi();
    createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
    const tool = findTool(fakePi, name);
    const ac = new AbortController(); ac.abort();
    const args = name === "linear_create_issue"
      ? { title: "t", description: "d" }
      : name === "linear_add_comment"
        ? { issue_id: "11111111-2222-3333-4444-555555555555", body: "b" }
        : name === "linear_list_teams"
          ? {}
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

// Case 12: linear_list_teams returns the four real Covent teams and caches.
{
  const fakePi = makeFakePi();
  const calls = [];
  const teamsPayload = {
    data: {
      teams: {
        nodes: [
          { id: "c0c3d247-e279-4928-b27c-ce1d32c33dce", key: "RND", name: "Research and Development", description: "Ideas + experiments" },
          { id: "a932029a-3599-4324-81e4-88244a5e9cbf", key: "HIS", name: "Historical Data", description: null },
          { id: "c9c8376e-7fd3-4921-9996-8c98fc2274f2", key: "FE", name: "Frontend Engineering", description: "UI + UX" },
          { id: "73c38bb9-46d4-45c6-a970-6800214a15a2", key: "BE", name: "Backend Engineering", description: "API + data pipeline" },
        ],
      },
    },
  };
  const fakeFetch = makeFakeFetch(() => ({ payload: teamsPayload }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const teams = findTool(fakePi, "linear_list_teams");
  const r1 = await teams.execute("tc12a", {}, undefined, undefined, {});
  assert.equal(r1.isError, undefined);
  assert.equal(r1.details.teams.length, 4);
  const teamKeys = r1.details.teams.map((t) => t.key).sort();
  assert.deepEqual(teamKeys, ["BE", "FE", "HIS", "RND"]);
  const beTeam = r1.details.teams.find((t) => t.key === "BE");
  assert.equal(beTeam.id, "73c38bb9-46d4-45c6-a970-6800214a15a2");
  assert.equal(r1.details.cached, false, "first call is not cached");
  assert.equal(calls.length, 1);

  // Second call should hit the cache, not the network.
  const r2 = await teams.execute("tc12b", {}, undefined, undefined, {});
  assert.equal(r2.isError, undefined);
  assert.equal(r2.details.cached, true, "second call returns cached payload");
  assert.equal(calls.length, 1, "no extra network call when cached");
  assert.match(r2.content[0].text, /cached/);
}

// Case 13: linear_create_issue with explicit team_id overrides env default.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_be_1", identifier: "BE-1", title: "Backend bug", url: "https://linear.app/x/issue/BE-1" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const beTeamId = "73c38bb9-46d4-45c6-a970-6800214a15a2";
  const r = await create.execute(
    "tc13",
    { title: "Backend bug", description: "API returns 500", team_id: beTeamId, project_id: "proj-be-1" },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(r.details.identifier, "BE-1");
  assert.equal(r.details.teamId, beTeamId, "details echo the explicit team_id");
  assert.equal(r.details.projectId, "proj-be-1", "details echo the explicit project_id");
  // Verify the payload that went over the wire used the BE team, not env default.
  const input = calls[0].body.variables.input;
  assert.equal(input.teamId, beTeamId, "Linear input.teamId uses explicit team_id");
  assert.equal(input.projectId, "proj-be-1", "Linear input.projectId uses explicit project_id");
  // stateId should NOT be applied because team_id != LINEAR_TEAM_ID (state IDs are team-scoped).
  assert.equal(input.stateId, undefined, "env LINEAR_STATE_ID is NOT forwarded when team_id differs from LINEAR_TEAM_ID");
}

// Case 14: linear_create_issue with no team_id uses env default + env state.
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
  const r = await create.execute("tc14", { title: "T", description: "D" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  const input = calls[0].body.variables.input;
  assert.equal(input.teamId, "team-abc", "falls back to LINEAR_TEAM_ID env var");
  assert.equal(input.projectId, "project-xyz", "falls back to LINEAR_PROJECT_ID env var");
  assert.equal(input.stateId, "state-backlog", "applies LINEAR_STATE_ID env var because team matches default");
  assert.equal(r.details.teamId, "team-abc");
  assert.equal(r.details.projectId, "project-xyz");
}

// Case 15: linear_create_issue with no team_id and no LINEAR_TEAM_ID env errors out.
{
  const envNoTeam = { ...baseEnv, LINEAR_TEAM_ID: undefined };
  const fakePi = makeFakePi();
  createLinearToolsFactory({ env: envNoTeam })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc15", { title: "T", description: "D" }, undefined, undefined, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /team_id/);
  assert.match(r.content[0].text, /linear_list_teams/);
}

// Case 16: linear_search_issues with explicit team_id overrides env default.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: { data: { issues: { nodes: [] } } },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const search = findTool(fakePi, "linear_search_issues");
  const beTeamId = "73c38bb9-46d4-45c6-a970-6800214a15a2";
  const r = await search.execute("tc16", { query: "bug", team_id: beTeamId }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].body.variables.filter.team.id.eq, beTeamId, "search filters by explicit team_id");
  assert.equal(r.details.teamId, beTeamId);
}

// Case 17: linear_create_issue with project_id="" opts out of env default project.
{
  const fakePi = makeFakePi();
  const calls = [];
  const fakeFetch = makeFakeFetch(() => ({
    payload: {
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i_np", identifier: "FE-3", title: "T", url: "https://linear.app/x/issue/FE-3" },
        },
      },
    },
  }), calls);
  createLinearToolsFactory({ env: baseEnv, fetchImpl: fakeFetch })(fakePi);
  const create = findTool(fakePi, "linear_create_issue");
  const r = await create.execute("tc17", { title: "T", description: "D", project_id: "" }, undefined, undefined, {});
  assert.equal(r.isError, undefined);
  const input = calls[0].body.variables.input;
  assert.equal(input.projectId, undefined, "empty project_id opts out of env default");
}

console.log("linear-tools tests passed");
