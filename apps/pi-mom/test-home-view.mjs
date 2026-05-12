import assert from "node:assert/strict";
import { buildHomeView, partitionRuns } from "./lib/home-view.mjs";

const NOW = Date.parse("2026-05-11T20:00:00.000Z");

function findBlock(view, predicate) {
  return view.blocks.find(predicate);
}

function viewText(view) {
  return JSON.stringify(view);
}

// ---------- case 1: empty state ----------
{
  const view = buildHomeView({ activeRuns: [], recentRuns: [], pendingApprovals: [], now: NOW });
  assert.equal(view.type, "home");
  assert.ok(Array.isArray(view.blocks) && view.blocks.length > 0, "empty view should still have blocks");
  const text = viewText(view);
  assert.match(text, /Covent Pi — Cockpit/);
  assert.match(text, /No agent runs in flight/);
  assert.match(text, /No recent activity yet/);
  // No approval alert when zero approvals.
  assert.doesNotMatch(text, /approvals? waiting/);
  // 2026-block fallback: no "table"/"alert" block types.
  for (const block of view.blocks) {
    assert.ok(!["table", "alert", "markdown"].includes(block.type), `unexpected 2026 block type: ${block.type}`);
  }
}

// ---------- case 2: runs only (active + recent split) ----------
{
  const runs = [
    { id: "run_a", status: "running", user: "U1", prompt: "fix the bug", startedAt: new Date(NOW - 5_000).toISOString() },
    { id: "run_b", status: "pending_confirmation", user: "U2", prompt: "deploy", createdAt: new Date(NOW - 30_000).toISOString() },
    { id: "run_c", status: "succeeded", user: "U3", prompt: "earlier task", finishedAt: new Date(NOW - 600_000).toISOString() },
    { id: "run_d", status: "failed", user: "U4", prompt: "oops", finishedAt: new Date(NOW - 7_200_000).toISOString() },
  ];
  const { activeRuns, recentRuns } = partitionRuns(runs);
  assert.equal(activeRuns.length, 2);
  assert.equal(recentRuns.length, 2);
  const view = buildHomeView({ activeRuns, recentRuns, pendingApprovals: [], now: NOW });
  const text = viewText(view);
  assert.match(text, /2 runs in flight/);
  assert.match(text, /run_a/);
  assert.match(text, /run_b/);
  assert.match(text, /run_c/);
  assert.match(text, /run_d/);
  assert.match(text, /just now|5s ago/); // run_a is 5s old
  assert.match(text, /1h ago|10m ago/); // run_c finished 10 min ago
  // No approvals alert when zero approvals.
  assert.doesNotMatch(text, /waiting/);
}

// ---------- case 3: approvals only ----------
{
  const pending = new Map();
  pending.set("appr_x_1", { approvalId: "appr_x_1", type: "confirm", title: "rm -rf /tmp/foo", requestId: "req_abc" });
  pending.set("appr_y_2", { approvalId: "appr_y_2", type: "select", title: "Pick option", requestId: "req_def" });
  const view = buildHomeView({ activeRuns: [], recentRuns: [], pendingApprovals: pending, now: NOW });
  const text = viewText(view);
  assert.match(text, /2 approvals waiting/);
  assert.match(text, /rm -rf \/tmp\/foo/);
  assert.match(text, /Pick option/);
  assert.match(text, /req_abc/);
  assert.match(text, /\(select\)/);
  assert.match(text, /No agent runs in flight/);
}

// ---------- case 4: both runs + approvals (and array form for approvals) ----------
{
  const approvals = [
    { approvalId: "appr_1", type: "confirm", title: "Approve dangerous bash", requestId: "req_1" },
  ];
  const activeRuns = [
    { id: "run_live", status: "running", user: "U99", prompt: "ship it", startedAt: new Date(NOW - 60_000).toISOString() },
  ];
  const recentRuns = [
    { id: "run_done", status: "succeeded", user: "U99", prompt: "done", finishedAt: new Date(NOW - 120_000).toISOString() },
  ];
  const view = buildHomeView({ activeRuns, recentRuns, pendingApprovals: approvals, now: NOW });
  const text = viewText(view);
  assert.match(text, /1 approval waiting/);
  assert.match(text, /1 run in flight/);
  assert.match(text, /run_live/);
  assert.match(text, /run_done/);
  assert.match(text, /ship it/);
}

// ---------- case 5: state-change rebuild (run progresses pending → running → succeeded) ----------
{
  const baseRun = {
    id: "run_state",
    user: "U7",
    prompt: "promote v2",
    createdAt: new Date(NOW - 30_000).toISOString(),
  };

  const v1 = buildHomeView({
    ...partitionRuns([{ ...baseRun, status: "pending_confirmation" }]),
    pendingApprovals: [],
    now: NOW,
  });
  assert.match(viewText(v1), /pending_confirmation/);
  assert.match(viewText(v1), /1 run in flight/);

  const v2 = buildHomeView({
    ...partitionRuns([{ ...baseRun, status: "running", startedAt: new Date(NOW - 5_000).toISOString() }]),
    pendingApprovals: [],
    now: NOW,
  });
  assert.match(viewText(v2), /\*running\*/);
  assert.match(viewText(v2), /1 run in flight/);
  // While the run is still active it should NOT yet appear in recent activity.
  assert.doesNotMatch(viewText(v2), /succeeded/);

  const v3 = buildHomeView({
    ...partitionRuns([{ ...baseRun, status: "succeeded", finishedAt: new Date(NOW - 1_000).toISOString() }]),
    pendingApprovals: [],
    now: NOW,
  });
  assert.match(viewText(v3), /No agent runs in flight/);
  assert.match(viewText(v3), /run_state/);
  assert.match(viewText(v3), /succeeded/);

  // The three rebuilds must produce distinct payloads (cockpit reflects state).
  assert.notEqual(viewText(v1), viewText(v2));
  assert.notEqual(viewText(v2), viewText(v3));
}

// ---------- case 6: caps + truncation ----------
{
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `run_${i}`,
    status: "running",
    user: "U1",
    prompt: "a".repeat(200),
    startedAt: new Date(NOW - i * 1000).toISOString(),
  }));
  const view = buildHomeView({ activeRuns: many, recentRuns: [], pendingApprovals: [], now: NOW });
  const text = viewText(view);
  assert.match(text, /20 runs in flight/);
  // Prompt should be truncated (we set PROMPT_PREVIEW=80; ellipsis or cap).
  assert.ok(!text.includes("a".repeat(150)), "long prompt should be truncated");
  // RUN_CAP=8 → only 8 row sections, plus "…and N more" context.
  assert.match(text, /…and 12 more not shown/);
  // Block count remains under Slack's 100-block limit.
  assert.ok(view.blocks.length < 30, `block count grew unexpectedly: ${view.blocks.length}`);
}

// ---------- case 7: partitionRuns is deterministic + safe with empties ----------
{
  assert.deepEqual(partitionRuns([]), { activeRuns: [], recentRuns: [] });
  assert.deepEqual(partitionRuns(), { activeRuns: [], recentRuns: [] });
  const { activeRuns, recentRuns } = partitionRuns([
    { id: "x", status: "interrupted" },
    { id: "y", status: "running" },
    { id: "z" }, // missing status → recent bucket
  ]);
  assert.equal(activeRuns.length, 1);
  assert.equal(activeRuns[0].id, "y");
  assert.equal(recentRuns.length, 2);
}

console.log("home-view tests passed");
