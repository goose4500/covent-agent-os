// Tests for lib/intake-linear-create.mjs. The helper is the direct path the
// Approve / Edit-submit handlers in index.mjs use to file a Linear issue
// from an already-human-approved proposal payload (no Pi turn).

import assert from "node:assert/strict";
import { createLinearIssueFromProposal } from "./lib/intake-linear-create.mjs";

function fakeFetch(handler) {
  return async (url, init) => handler({ url, init });
}

function makeProposal(overrides = {}) {
  return {
    title: "Goodwill refund support",
    description: "Problem: Users complain.\nWhat to build: refund flow.",
    priority: 2,
    suggested_team_id: undefined,
    suggested_project_id: undefined,
    ...overrides,
  };
}

const baseEnv = {
  LINEAR_API_KEY: "lin_api_TEST",
  LINEAR_TEAM_ID: "env-team",
  LINEAR_PROJECT_ID: "env-project",
  LINEAR_STATE_ID: "env-state",
};

function okResponse(issue = { id: "i1", identifier: "FE-1", title: "x", url: "https://linear.app/x" }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { issueCreate: { success: true, issue } } }),
  };
}

// 1. Happy path with env defaults
{
  let seenInput;
  const fetchImpl = fakeFetch(async ({ init }) => {
    seenInput = JSON.parse(init.body).variables.input;
    return okResponse({ id: "i1", identifier: "FE-100", title: "t", url: "https://x" });
  });
  const res = await createLinearIssueFromProposal(makeProposal(), { env: baseEnv, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.issue.identifier, "FE-100");
  assert.equal(seenInput.teamId, "env-team");
  assert.equal(seenInput.projectId, "env-project");
  assert.equal(seenInput.stateId, "env-state");
  assert.equal(seenInput.priority, 2);
}

// 2. proposal.suggested_team_id wins over env
{
  let seenInput;
  const fetchImpl = fakeFetch(async ({ init }) => {
    seenInput = JSON.parse(init.body).variables.input;
    return okResponse();
  });
  await createLinearIssueFromProposal(
    makeProposal({ suggested_team_id: "team-from-ai" }),
    { env: baseEnv, fetchImpl },
  );
  assert.equal(seenInput.teamId, "team-from-ai");
}

// 3. proposal.suggested_project_id wins over env
{
  let seenInput;
  const fetchImpl = fakeFetch(async ({ init }) => {
    seenInput = JSON.parse(init.body).variables.input;
    return okResponse();
  });
  await createLinearIssueFromProposal(
    makeProposal({ suggested_project_id: "proj-from-ai" }),
    { env: baseEnv, fetchImpl },
  );
  assert.equal(seenInput.projectId, "proj-from-ai");
}

// 4. defaults.teamId layered above env when no suggestion
{
  let seenInput;
  const fetchImpl = fakeFetch(async ({ init }) => {
    seenInput = JSON.parse(init.body).variables.input;
    return okResponse();
  });
  await createLinearIssueFromProposal(makeProposal(), {
    env: baseEnv,
    fetchImpl,
    defaults: { teamId: "team-intake-default", projectId: "proj-intake-default" },
  });
  assert.equal(seenInput.teamId, "team-intake-default");
  assert.equal(seenInput.projectId, "proj-intake-default");
}

// 5. Missing LINEAR_API_KEY → error
{
  const res = await createLinearIssueFromProposal(makeProposal(), {
    env: { ...baseEnv, LINEAR_API_KEY: undefined },
    fetchImpl: fakeFetch(async () => { throw new Error("should not call"); }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /LINEAR_API_KEY/);
}

// 6. Missing teamId everywhere → error
{
  const res = await createLinearIssueFromProposal(makeProposal(), {
    env: { LINEAR_API_KEY: "lin_api_TEST" },
    fetchImpl: fakeFetch(async () => { throw new Error("should not call"); }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /team_id/);
}

// 7. Empty description → error
{
  const res = await createLinearIssueFromProposal(makeProposal({ description: "   " }), {
    env: baseEnv,
    fetchImpl: fakeFetch(async () => { throw new Error("should not call"); }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /description/);
}

// 8. Title clamped to 240 chars
{
  let seenInput;
  const fetchImpl = fakeFetch(async ({ init }) => {
    seenInput = JSON.parse(init.body).variables.input;
    return okResponse();
  });
  await createLinearIssueFromProposal(makeProposal({ title: "x".repeat(500) }), {
    env: baseEnv,
    fetchImpl,
  });
  assert.equal(seenInput.title.length, 240);
  assert.ok(seenInput.title.endsWith("..."));
}

// 9. priority outside 0..4 is dropped (not sent)
{
  let seenInput;
  const fetchImpl = fakeFetch(async ({ init }) => {
    seenInput = JSON.parse(init.body).variables.input;
    return okResponse();
  });
  await createLinearIssueFromProposal(makeProposal({ priority: 9 }), { env: baseEnv, fetchImpl });
  assert.equal(seenInput.priority, undefined);
}

// 10. priority unset → not included in payload
{
  let seenInput;
  const fetchImpl = fakeFetch(async ({ init }) => {
    seenInput = JSON.parse(init.body).variables.input;
    return okResponse();
  });
  await createLinearIssueFromProposal(makeProposal({ priority: undefined }), { env: baseEnv, fetchImpl });
  assert.equal(seenInput.priority, undefined);
}

// 11. GraphQL errors[] → ok=false with redacted message
{
  const fetchImpl = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ errors: [{ message: "bad team token lin_api_LEAK_ABCDEF" }] }),
  }));
  const res = await createLinearIssueFromProposal(makeProposal(), { env: baseEnv, fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /Linear issueCreate failed/);
  assert.ok(!res.error.includes("LEAK_ABCDEF"), "secret should be redacted");
}

// 12. HTTP non-2xx → ok=false
{
  const fetchImpl = fakeFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  const res = await createLinearIssueFromProposal(makeProposal(), { env: baseEnv, fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 401/);
}

// 13. AbortError → bespoke message
{
  const fetchImpl = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  const res = await createLinearIssueFromProposal(makeProposal(), { env: baseEnv, fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /aborted/);
}

// 14. Network throw (non-Abort) → ok=false with redacted message
{
  const fetchImpl = async () => {
    throw new Error("fetch failed: lin_api_LEAK_NETWORK");
  };
  const res = await createLinearIssueFromProposal(makeProposal(), { env: baseEnv, fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /request error/);
  assert.ok(!res.error.includes("LEAK_NETWORK"), "secret should be redacted");
}

console.log("intake-linear-create tests pass");
