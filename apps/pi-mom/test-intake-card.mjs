import assert from "node:assert/strict";
import {
  buildProposalCardBlocks,
  buildIntakeSummaryBlocks,
  PI_INTAKE_ACTION_IDS,
} from "./lib/intake-card.mjs";

function asText(blocks) {
  return JSON.stringify(blocks);
}

function findActionsBlock(blocks) {
  return blocks.find((b) => b.type === "actions");
}

function findHeaderText(blocks) {
  const header = blocks.find((b) => b.type === "header");
  return header?.text?.text || "";
}

function findContextTexts(blocks) {
  return blocks
    .filter((b) => b.type === "context")
    .flatMap((b) => (b.elements || []).map((e) => e.text || ""));
}

const sampleProposal = {
  title: "Auto-cancel inactive accounts after 3 months",
  description: "Problem: low-usage trial accounts linger forever.\nWhat to build: cron job that cancels.",
  priority: 2,
  suggested_team_id: "team-uuid-FE",
  suggested_project_id: "project-uuid-billing",
  confidence: 0.8,
};

// ---------- case 1: pending status returns 3 buttons with right action_ids + value ----------
{
  const blocks = buildProposalCardBlocks(sampleProposal, {
    approvalId: "appr_abc_1",
    status: "pending",
    requestId: "req_xyz",
    proposalIndex: 1,
    proposalTotal: 3,
  });
  const actions = findActionsBlock(blocks);
  assert.ok(actions, "pending card should have an actions block");
  assert.equal(actions.elements.length, 3, "pending card should have 3 buttons");

  const ids = actions.elements.map((b) => b.action_id);
  assert.deepEqual(
    ids.sort(),
    [PI_INTAKE_ACTION_IDS.APPROVE, PI_INTAKE_ACTION_IDS.CANCEL, PI_INTAKE_ACTION_IDS.EDIT].sort(),
    "action_ids must be the documented set",
  );
  for (const el of actions.elements) {
    assert.equal(el.value, "appr_abc_1", "every button.value must equal approvalId");
  }
}

// ---------- case 2: button styles ----------
{
  const blocks = buildProposalCardBlocks(sampleProposal, {
    approvalId: "appr_abc_1",
    status: "pending",
    requestId: "req_xyz",
  });
  const actions = findActionsBlock(blocks);
  const approve = actions.elements.find((e) => e.action_id === PI_INTAKE_ACTION_IDS.APPROVE);
  const cancel = actions.elements.find((e) => e.action_id === PI_INTAKE_ACTION_IDS.CANCEL);
  const edit = actions.elements.find((e) => e.action_id === PI_INTAKE_ACTION_IDS.EDIT);
  assert.equal(approve.style, "primary", "Approve must be primary");
  assert.equal(cancel.style, "danger", "Cancel must be danger");
  assert.equal(edit.style, undefined, "Edit must be unstyled");
}

// ---------- case 3: approved + linearIssue removes buttons and shows the URL ----------
{
  const blocks = buildProposalCardBlocks(sampleProposal, {
    approvalId: "appr_abc_1",
    status: "approved",
    requestId: "req_xyz",
    linearIssue: { identifier: "FE-101", url: "https://linear.app/foo/issue/FE-101" },
    actorUserId: "U123",
  });
  assert.equal(findActionsBlock(blocks), undefined, "approved card must not have action buttons");
  const text = asText(blocks);
  assert.match(text, /FE-101/);
  assert.match(text, /https:\/\/linear\.app\/foo\/issue\/FE-101/);
  assert.match(text, /Approved by <@U123>/);
}

// ---------- case 4: canceled status header + actorUserId rendered as <@U…> ----------
{
  const blocks = buildProposalCardBlocks(sampleProposal, {
    approvalId: "appr_abc_1",
    status: "canceled",
    requestId: "req_xyz",
    actorUserId: "U999",
  });
  assert.equal(findActionsBlock(blocks), undefined, "canceled card must not have buttons");
  const text = asText(blocks);
  assert.match(text, /Canceled by <@U999>/);
}

// ---------- case 5: claimed status mentions "Being edited by" + buttons hidden ----------
{
  const blocks = buildProposalCardBlocks(sampleProposal, {
    approvalId: "appr_abc_1",
    status: "claimed",
    requestId: "req_xyz",
    actorUserId: "U555",
  });
  assert.equal(findActionsBlock(blocks), undefined, "claimed card must not show action buttons");
  const text = asText(blocks);
  assert.match(text, /Being edited by <@U555>/);
}

// ---------- case 6: proposalIndex + proposalTotal show in header ----------
{
  const blocks = buildProposalCardBlocks(sampleProposal, {
    approvalId: "appr_abc_1",
    status: "pending",
    requestId: "req_xyz",
    proposalIndex: 2,
    proposalTotal: 4,
  });
  const header = findHeaderText(blocks);
  assert.match(header, /Proposal 2 of 4/);
  assert.match(header, /Auto-cancel inactive accounts/);
}

// ---------- case 7: context block has requestId, approvalId, priority, team, project ----------
{
  const blocks = buildProposalCardBlocks(sampleProposal, {
    approvalId: "appr_zzz_9",
    status: "pending",
    requestId: "req_alpha",
  });
  const ctxJoined = findContextTexts(blocks).join("\n");
  assert.match(ctxJoined, /req_alpha/, "context must show requestId");
  assert.match(ctxJoined, /appr_zzz_9/, "context must show approvalId");
  assert.match(ctxJoined, /priority:\s*P2/, "context must show priority P2");
  assert.match(ctxJoined, /team-uuid-FE/, "context must show suggested team");
  assert.match(ctxJoined, /project-uuid-billing/, "context must show suggested project");
}

// ---------- case 7b: graceful defaults when fields missing ----------
{
  const blocks = buildProposalCardBlocks({ title: "minimal" }, {
    approvalId: "appr_min_1",
    requestId: "req_min",
  });
  const ctxJoined = findContextTexts(blocks).join("\n");
  assert.match(ctxJoined, /default/, "missing team/project should fall back to default");
  assert.match(ctxJoined, /priority:\s*P0/, "missing priority should default to P0");
}

// ---------- case 8: buildIntakeSummaryBlocks shows files / skipped / proposal counts ----------
{
  const blocks = buildIntakeSummaryBlocks({
    files: [
      { relPath: "spec/a.md", sizeBytes: 1200 },
      { relPath: "spec/b.md", sizeBytes: 2400 },
      { relPath: "spec/c.md", sizeBytes: 800 },
    ],
    skipped: [
      { relPath: "spec/diagram.png", reason: "binary not supported" },
      { relPath: "spec/overview.pdf", reason: "pdf not supported" },
    ],
    proposalCount: 4,
    requestId: "req_intake_1",
    zipFilename: "prd-handoff-billing.zip",
  });
  const text = asText(blocks);
  assert.match(text, /prd-handoff-billing\.zip/);
  assert.match(text, /\b3\b/, "should mention 3 files");
  assert.match(text, /\b2\b/, "should mention 2 skipped");
  assert.match(text, /\b4\b/, "should mention 4 proposals");
  assert.match(text, /spec\/a\.md/);
  assert.match(text, /spec\/diagram\.png/);
  assert.match(text, /req_intake_1/);
}

console.log("intake-card tests pass");
