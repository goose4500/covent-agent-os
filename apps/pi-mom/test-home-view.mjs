import assert from "node:assert/strict";
import { buildHomeView } from "./lib/home-view.mjs";

const NOW = Date.parse("2026-05-11T20:00:00.000Z");

function viewText(view) {
  return JSON.stringify(view);
}

// ---------- case 1: empty state ----------
{
  const view = buildHomeView({ pendingApprovals: [], now: NOW });
  assert.equal(view.type, "home");
  assert.ok(Array.isArray(view.blocks) && view.blocks.length > 0, "empty view should still have blocks");
  const text = viewText(view);
  assert.match(text, /Covent Pi — Cockpit/);
  assert.match(text, /No approvals waiting/);
  assert.doesNotMatch(text, /approvals? waiting\*/);
  // 2026-block fallback: no `table`/`alert`/`markdown` block types in v7.15.2.
  for (const block of view.blocks) {
    assert.ok(!["table", "alert", "markdown"].includes(block.type), `unexpected 2026 block type: ${block.type}`);
  }
}

// ---------- case 2: approvals from a Map ----------
{
  const pending = new Map();
  pending.set("appr_x_1", { approvalId: "appr_x_1", type: "confirm", title: "rm -rf /tmp/foo", requestId: "req_abc" });
  pending.set("appr_y_2", { approvalId: "appr_y_2", type: "select", title: "Pick option", requestId: "req_def" });
  const view = buildHomeView({ pendingApprovals: pending, now: NOW });
  const text = viewText(view);
  assert.match(text, /2 approvals waiting/);
  assert.match(text, /rm -rf \/tmp\/foo/);
  assert.match(text, /Pick option/);
  assert.match(text, /req_abc/);
  assert.match(text, /\(select\)/);
}

// ---------- case 3: approvals from an array ----------
{
  const approvals = [
    { approvalId: "appr_1", type: "confirm", title: "Approve dangerous bash", requestId: "req_1" },
  ];
  const view = buildHomeView({ pendingApprovals: approvals, now: NOW });
  const text = viewText(view);
  assert.match(text, /1 approval waiting/);
  assert.match(text, /Approve dangerous bash/);
}

// ---------- case 4: state change between rebuilds produces distinct payloads ----------
{
  const empty = buildHomeView({ pendingApprovals: [], now: NOW });
  const one = buildHomeView({ pendingApprovals: [{ approvalId: "a", type: "confirm", title: "t", requestId: "r" }], now: NOW });
  const two = buildHomeView({
    pendingApprovals: [
      { approvalId: "a", type: "confirm", title: "t", requestId: "r" },
      { approvalId: "b", type: "select", title: "u", requestId: "s" },
    ],
    now: NOW,
  });
  assert.notEqual(viewText(empty), viewText(one));
  assert.notEqual(viewText(one), viewText(two));
}

// ---------- case 5: cap + truncation for many approvals ----------
{
  const many = Array.from({ length: 12 }, (_, i) => ({
    approvalId: `appr_${i}`,
    type: "confirm",
    title: "a".repeat(200),
    requestId: `req_${i}`,
  }));
  const view = buildHomeView({ pendingApprovals: many, now: NOW });
  const text = viewText(view);
  assert.match(text, /12 approvals waiting/);
  // APPROVAL_CAP=6 → expect "and N more" overflow line.
  assert.match(text, /…and 6 more/);
  assert.ok(!text.includes("a".repeat(150)), "long titles should be truncated");
  assert.ok(view.blocks.length < 30, `block count grew unexpectedly: ${view.blocks.length}`);
}

console.log("home-view tests passed");
