// Tests for lib/intake-proposal-store.mjs — the wrapper that registers
// per-issue proposals into the global `pendingApprovals` Map, supports a
// claimed-by lock to serialize Edit-modal clicks, and finalizes entries
// once a button resolves.

import assert from "node:assert/strict";
import {
  _resetIntakeApprovalCounterForTests,
  _CLAIM_TTL_MS_FOR_TESTS,
  claim,
  finalize,
  getProposal,
  markStatus,
  nextIntakeApprovalId,
  registerProposal,
  release,
} from "./lib/intake-proposal-store.mjs";

function makeMap() {
  return new Map();
}

function makeProposal(overrides = {}) {
  return {
    title: "Goodwill refund support",
    description: "Problem ...\nWhat to build ...\nAcceptance criteria ...",
    priority: 3,
    suggested_team_id: "team-frontend",
    suggested_project_id: "proj-distribution",
    ...overrides,
  };
}

function makeEntry(overrides = {}) {
  return {
    approvalId: overrides.approvalId || nextIntakeApprovalId("req_test"),
    channel: "C123",
    threadTs: "1700000000.000100",
    parentMessageTs: "1700000000.000200",
    cardMessageTs: "1700000000.000300",
    requestId: "req_test",
    proposalIndex: 1,
    proposalTotal: 3,
    proposal: makeProposal(),
    ...overrides,
  };
}

// 1. nextIntakeApprovalId is monotonically unique
{
  _resetIntakeApprovalCounterForTests();
  const a = nextIntakeApprovalId("req_x");
  const b = nextIntakeApprovalId("req_x");
  assert.notEqual(a, b, "IDs must be unique");
  assert.match(a, /^intake_req_x_1_/);
  assert.match(b, /^intake_req_x_2_/);
}

// 2. registerProposal stores entry under approvalId with type=intake_proposal
{
  const map = makeMap();
  const stored = registerProposal(map, makeEntry({ approvalId: "appr-1" }));
  assert.equal(stored.type, "intake_proposal");
  assert.equal(stored.status, "pending");
  assert.equal(stored.title, "Intake proposal — Goodwill refund support");
  assert.equal(map.get("appr-1"), stored);
}

// 3. registerProposal without approvalId throws
{
  assert.throws(() => registerProposal(makeMap(), {}), /approvalId required/);
}

// 4. getProposal returns the entry only when type matches
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-2" }));
  map.set("foreign", { type: "confirm" });
  assert.ok(getProposal(map, "appr-2"));
  assert.equal(getProposal(map, "foreign"), undefined);
  assert.equal(getProposal(map, "missing"), undefined);
}

// 5. claim happy path: marks status=claimed, sets claimedBy + claimedAt
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-3" }));
  const res = claim(map, "appr-3", "U_alice", { now: 1_000_000 });
  assert.equal(res.ok, true);
  assert.equal(res.entry.claimedBy, "U_alice");
  assert.equal(res.entry.claimedAt, 1_000_000);
  assert.equal(res.entry.status, "claimed");
}

// 6. claim by same user re-claims fine
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-4" }));
  claim(map, "appr-4", "U_alice", { now: 1_000_000 });
  const res2 = claim(map, "appr-4", "U_alice", { now: 1_000_500 });
  assert.equal(res2.ok, true);
  assert.equal(res2.entry.claimedAt, 1_000_500);
}

// 7. claim by different user within TTL is blocked
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-5" }));
  claim(map, "appr-5", "U_alice", { now: 1_000_000 });
  const res2 = claim(map, "appr-5", "U_bob", { now: 1_000_000 + 1000 });
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "claimed");
  assert.equal(res2.claimedBy, "U_alice");
}

// 8. claim by different user after TTL is allowed
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-6" }));
  claim(map, "appr-6", "U_alice", { now: 1_000_000 });
  const res2 = claim(map, "appr-6", "U_bob", { now: 1_000_000 + _CLAIM_TTL_MS_FOR_TESTS + 1 });
  assert.equal(res2.ok, true);
  assert.equal(res2.entry.claimedBy, "U_bob");
}

// 9. claim on finalized entries returns reason=finalized
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-7" }));
  markStatus(map, "appr-7", "approved");
  const res = claim(map, "appr-7", "U_alice", { now: 2_000_000 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "finalized");
  assert.equal(res.status, "approved");
}

// 10. claim on missing entry returns reason=missing
{
  const map = makeMap();
  const res = claim(map, "no-such-id", "U_alice");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing");
}

// 11. release clears claim and resets status to pending
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-8" }));
  claim(map, "appr-8", "U_alice", { now: 3_000_000 });
  release(map, "appr-8");
  const entry = getProposal(map, "appr-8");
  assert.equal(entry.claimedBy, undefined);
  assert.equal(entry.status, "pending");
}

// 12. release does not flip a finalized status back to pending
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-9" }));
  markStatus(map, "appr-9", "approved");
  release(map, "appr-9");
  assert.equal(getProposal(map, "appr-9").status, "approved");
}

// 13. markStatus applies extras
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-10" }));
  markStatus(map, "appr-10", "approved", { linearIssue: { identifier: "FE-555", url: "https://linear.app/x" } });
  const entry = getProposal(map, "appr-10");
  assert.equal(entry.status, "approved");
  assert.equal(entry.linearIssue.identifier, "FE-555");
}

// 14. finalize deletes the entry
{
  const map = makeMap();
  registerProposal(map, makeEntry({ approvalId: "appr-11" }));
  assert.ok(getProposal(map, "appr-11"));
  finalize(map, "appr-11");
  assert.equal(getProposal(map, "appr-11"), undefined);
}

console.log("✅ intake-proposal-store tests pass");
