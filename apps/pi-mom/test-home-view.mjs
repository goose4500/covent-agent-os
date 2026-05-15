import assert from "node:assert/strict";
import {
  buildHomeView,
  buildSettingsModalView,
} from "./lib/home-view.mjs";

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

// ---------- case 6: approvals carry Approve/Cancel buttons reusing existing action_ids ----------
{
  const view = buildHomeView({
    pendingApprovals: [{ approvalId: "appr_42", type: "confirm", title: "dangerous bash", requestId: "req_42" }],
    now: NOW,
  });
  const actionBlocks = view.blocks.filter((b) => b.type === "actions");
  const ids = new Set(actionBlocks.flatMap((b) => b.elements.map((e) => e.action_id)));
  assert.ok(ids.has("pi_uictx_confirm_approve"), "Approve button must reuse existing action_id");
  assert.ok(ids.has("pi_uictx_confirm_cancel"), "Cancel button must reuse existing action_id");
  // Approve button must carry the approvalId so the resolver can look it up.
  const approveBtn = actionBlocks
    .flatMap((b) => b.elements)
    .find((e) => e.action_id === "pi_uictx_confirm_approve");
  assert.equal(approveBtn?.value, "appr_42");
}

// ---------- case 7: tips section + filter + settings buttons present ----------
{
  const view = buildHomeView({
    pendingApprovals: [{ approvalId: "a", type: "confirm", title: "t", requestId: "r" }],
    now: NOW,
  });
  const allIds = new Set();
  for (const b of view.blocks) {
    if (b.type === "actions") for (const e of b.elements) allIds.add(e.action_id);
    if (b.type === "section" && b.accessory?.action_id) allIds.add(b.accessory.action_id);
  }
  assert.ok(!allIds.has("home_quick_route"), "route quick-launch buttons should be gone");
  assert.match(viewText(view), /just @-mention/i, "tips section explains the dynamic UX");
  assert.ok(allIds.has("home_filter_approvals"), "filter select must be present when approvals exist");
  assert.ok(allIds.has("home_settings_open"), "settings button must be present");
  assert.ok(allIds.has("home_refresh"), "refresh button must be present");
}

// ---------- case 8: filter narrows the rendered list but keeps total count ----------
{
  const pending = [
    { approvalId: "c1", type: "confirm", title: "confirm one", requestId: "r1" },
    { approvalId: "s1", type: "select", title: "select one", requestId: "r2" },
  ];
  const all = buildHomeView({ pendingApprovals: pending, filter: "all", now: NOW });
  const only = buildHomeView({ pendingApprovals: pending, filter: "confirm", now: NOW });
  assert.match(viewText(all), /2 approvals waiting/);
  // Filter doesn't change the total — total reflects unfiltered count.
  assert.match(viewText(only), /2 approvals waiting/);
  // But the select entry text should no longer appear in the filtered view's cards.
  assert.match(viewText(all), /select one/);
  assert.doesNotMatch(viewText(only), /select one/);
}

// ---------- case 9: recent-runs section shows entries when provided ----------
{
  const view = buildHomeView({
    pendingApprovals: [],
    recentRuns: [
      { outcome: "ok", durationMs: 2300, requestId: "req_a", permalink: "https://slack/permalink/a" },
      { outcome: "error", durationMs: 4100, requestId: "req_b" },
    ],
    now: NOW,
  });
  const text = viewText(view);
  assert.match(text, /Recent activity/);
  assert.match(text, /req_a/);
  assert.match(text, /open thread/);
  assert.match(text, /req_b/);
}

// ---------- case 10: status section reflects snapshot ----------
{
  const view = buildHomeView({
    pendingApprovals: [],
    status: {
      mode: "pi",
      linearConfigured: true,
      slackStreamingAvailable: true,
      browserUseConfigured: true,
      subagentsEnabled: true,
      uptimeSeconds: 42,
    },
    now: NOW,
  });
  const text = viewText(view);
  assert.match(text, /mode `pi`/);
  assert.match(text, /Slack :white_check_mark: streaming ok/);
  assert.match(text, /Browser Use key/);
  assert.match(text, /Linear :white_check_mark: configured/);
  assert.match(text, /team subagents :white_check_mark: enabled/);
  assert.match(text, /uptime 42s/);
}

// ---------- case 11: settings modal builder shape ----------
{
  const modal = buildSettingsModalView({
    status: { mode: "echo", linearConfigured: false, slackStreamingAvailable: false, browserUseConfigured: false, subagentsEnabled: false, traceEnabled: true, uptimeSeconds: 9 },
  });
  assert.equal(modal.type, "modal");
  assert.equal(modal.callback_id, "home_settings_modal");
  assert.ok(modal.blocks.length > 0);
  const text = JSON.stringify(modal);
  assert.match(text, /Mode/);
  assert.match(text, /echo/);
  assert.match(text, /Slack streaming/);
  assert.match(text, /Browser Use key/);
  assert.match(text, /missing key/);
  assert.match(text, /Team subagents/);
  assert.match(text, /disabled/);
}

console.log("home-view tests passed");
