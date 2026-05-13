import assert from "node:assert/strict";
import {
  buildEditModalView,
  parseEditModalSubmission,
  PI_INTAKE_EDIT_BLOCKS,
  PI_INTAKE_EDIT_ACTIONS,
} from "./lib/intake-edit-modal.mjs";

const sampleProposal = {
  title: "Auto-cancel inactive accounts after 3 months",
  description:
    "Problem: low-usage trial accounts linger forever.\nWhat to build: a nightly cron that cancels.",
  priority: 2,
  suggested_team_id: "team-uuid-FE",
  suggested_project_id: "project-uuid-billing",
  confidence: 0.8,
};

function findBlock(view, blockId) {
  return view.blocks.find((b) => b.block_id === blockId);
}

function buildSubmissionValues({
  title,
  description,
  priority,
  team_id,
  project_id,
}) {
  const values = {};
  if (title !== undefined) {
    values[PI_INTAKE_EDIT_BLOCKS.TITLE] = {
      [PI_INTAKE_EDIT_ACTIONS.TITLE]: { type: "plain_text_input", value: title },
    };
  }
  if (description !== undefined) {
    values[PI_INTAKE_EDIT_BLOCKS.DESCRIPTION] = {
      [PI_INTAKE_EDIT_ACTIONS.DESCRIPTION]: { type: "plain_text_input", value: description },
    };
  }
  if (priority !== undefined) {
    values[PI_INTAKE_EDIT_BLOCKS.PRIORITY] = {
      [PI_INTAKE_EDIT_ACTIONS.PRIORITY]: {
        type: "static_select",
        selected_option: { value: String(priority), text: { type: "plain_text", text: "p" } },
      },
    };
  }
  if (team_id !== undefined) {
    values[PI_INTAKE_EDIT_BLOCKS.TEAM] = {
      [PI_INTAKE_EDIT_ACTIONS.TEAM]: { type: "plain_text_input", value: team_id },
    };
  }
  if (project_id !== undefined) {
    values[PI_INTAKE_EDIT_BLOCKS.PROJECT] = {
      [PI_INTAKE_EDIT_ACTIONS.PROJECT]: { type: "plain_text_input", value: project_id },
    };
  }
  return { state: { values } };
}

// ---------- case 1: callback_id, private_metadata, notify_on_close ----------
{
  const view = buildEditModalView({
    approvalId: "appr_abc_1",
    proposal: sampleProposal,
    defaultTeamId: "default-team-uuid",
    defaultProjectId: "default-project-uuid",
  });
  assert.equal(view.type, "modal", "view.type must be 'modal'");
  assert.equal(view.callback_id, "pi_intake_edit_modal", "callback_id must be pi_intake_edit_modal");
  assert.equal(view.private_metadata, "appr_abc_1", "private_metadata must equal approvalId");
  assert.equal(view.notify_on_close, true, "notify_on_close must be true");
}

// ---------- case 2: title + description pre-fill ----------
{
  const view = buildEditModalView({
    approvalId: "appr_abc_1",
    proposal: sampleProposal,
    defaultTeamId: "default-team-uuid",
    defaultProjectId: "default-project-uuid",
  });
  const titleBlock = findBlock(view, PI_INTAKE_EDIT_BLOCKS.TITLE);
  const descBlock = findBlock(view, PI_INTAKE_EDIT_BLOCKS.DESCRIPTION);
  assert.ok(titleBlock, "title block must exist");
  assert.ok(descBlock, "description block must exist");
  assert.equal(titleBlock.element.type, "plain_text_input");
  assert.equal(titleBlock.element.initial_value, sampleProposal.title);
  assert.equal(descBlock.element.type, "plain_text_input");
  assert.equal(descBlock.element.multiline, true, "description must be multiline");
  assert.equal(descBlock.element.initial_value, sampleProposal.description);
}

// ---------- case 3: priority static_select has 5 options with values "0".."4" ----------
{
  const view = buildEditModalView({
    approvalId: "appr_abc_1",
    proposal: sampleProposal,
  });
  const priBlock = findBlock(view, PI_INTAKE_EDIT_BLOCKS.PRIORITY);
  assert.ok(priBlock, "priority block must exist");
  assert.equal(priBlock.element.type, "static_select");
  const values = priBlock.element.options.map((o) => o.value);
  assert.deepEqual(values, ["0", "1", "2", "3", "4"], "priority options must be values 0..4");
  assert.equal(priBlock.element.options.length, 5, "must have exactly 5 priority options");
  // Initial option corresponds to proposal.priority (=2).
  assert.equal(priBlock.element.initial_option.value, "2", "initial_option must match priority=2");

  // labels mention none/urgent/high/medium/low
  const labels = priBlock.element.options.map((o) => String(o.text?.text || "").toLowerCase()).join("|");
  for (const word of ["none", "urgent", "high", "medium", "low"]) {
    assert.ok(labels.includes(word), `priority labels must include "${word}" — got ${labels}`);
  }

  // priority undefined → defaults to "none" (value "0")
  const viewNone = buildEditModalView({ approvalId: "x", proposal: { title: "t", description: "d" } });
  const priBlockNone = findBlock(viewNone, PI_INTAKE_EDIT_BLOCKS.PRIORITY);
  assert.equal(
    priBlockNone.element.initial_option.value,
    "0",
    "missing priority defaults to none (0)",
  );
}

// ---------- case 4: team_id / project_id pre-filled; placeholder mentions default UUID ----------
{
  const view = buildEditModalView({
    approvalId: "appr_abc_1",
    proposal: sampleProposal,
    defaultTeamId: "default-team-uuid",
    defaultProjectId: "default-project-uuid",
  });
  const teamBlock = findBlock(view, PI_INTAKE_EDIT_BLOCKS.TEAM);
  const projBlock = findBlock(view, PI_INTAKE_EDIT_BLOCKS.PROJECT);
  assert.ok(teamBlock, "team block must exist");
  assert.ok(projBlock, "project block must exist");
  assert.equal(teamBlock.element.initial_value, "team-uuid-FE", "team prefill");
  assert.equal(projBlock.element.initial_value, "project-uuid-billing", "project prefill");

  // When missing on proposal, placeholder should mention default UUID.
  const viewMissing = buildEditModalView({
    approvalId: "appr_2",
    proposal: { title: "t", description: "d" },
    defaultTeamId: "default-team-uuid",
    defaultProjectId: "default-project-uuid",
  });
  const teamMissing = findBlock(viewMissing, PI_INTAKE_EDIT_BLOCKS.TEAM);
  const projMissing = findBlock(viewMissing, PI_INTAKE_EDIT_BLOCKS.PROJECT);
  assert.equal(teamMissing.element.initial_value, undefined, "no team value when missing");
  assert.equal(projMissing.element.initial_value, undefined, "no project value when missing");
  assert.match(
    String(teamMissing.element.placeholder?.text || ""),
    /default-team-uuid/,
    "team placeholder must mention default team UUID",
  );
  assert.match(
    String(projMissing.element.placeholder?.text || ""),
    /default-project-uuid/,
    "project placeholder must mention default project UUID",
  );
}

// ---------- case 5: round-trip parseEditModalSubmission ----------
{
  const submissionView = buildSubmissionValues({
    title: "  My title  ",
    description: "  the body\nmultiline\n  ",
    priority: 3,
    team_id: "team-xyz",
    project_id: "project-abc",
  });
  const parsed = parseEditModalSubmission(submissionView);
  assert.equal(parsed.title, "My title", "title should be trimmed");
  assert.equal(parsed.description, "the body\nmultiline", "description should be trimmed");
  assert.equal(parsed.priority, 3, "priority should round-trip as number");
  assert.equal(parsed.team_id, "team-xyz", "team_id should round-trip");
  assert.equal(parsed.project_id, "project-abc", "project_id should round-trip");
}

// ---------- case 6: priority="2" → number 2 ----------
{
  const submissionView = buildSubmissionValues({
    title: "x",
    description: "y",
    priority: 2,
    team_id: "t",
    project_id: "p",
  });
  const parsed = parseEditModalSubmission(submissionView);
  assert.equal(typeof parsed.priority, "number", "priority must be a number, not a string");
  assert.equal(parsed.priority, 2, "priority must be 2");
}

// ---------- case 7: empty team_id → undefined ----------
{
  const submissionView = buildSubmissionValues({
    title: "x",
    description: "y",
    priority: 0,
    team_id: "",
    project_id: "   ",
  });
  const parsed = parseEditModalSubmission(submissionView);
  assert.equal(parsed.team_id, undefined, "empty team_id returns undefined");
  assert.equal(parsed.project_id, undefined, "whitespace-only project_id returns undefined");
  assert.equal(parsed.priority, 0, "priority=0 is preserved");
}

// ---------- case 8: BLOCKS/ACTIONS keys are consistent ----------
{
  assert.ok(PI_INTAKE_EDIT_BLOCKS && typeof PI_INTAKE_EDIT_BLOCKS === "object", "BLOCKS export must be an object");
  assert.ok(PI_INTAKE_EDIT_ACTIONS && typeof PI_INTAKE_EDIT_ACTIONS === "object", "ACTIONS export must be an object");
  const blockKeys = Object.keys(PI_INTAKE_EDIT_BLOCKS).sort();
  const actionKeys = Object.keys(PI_INTAKE_EDIT_ACTIONS).sort();
  assert.deepEqual(blockKeys, actionKeys, "every block key must have a matching action key");
  for (const k of blockKeys) {
    assert.ok(
      typeof PI_INTAKE_EDIT_BLOCKS[k] === "string" && PI_INTAKE_EDIT_BLOCKS[k].length > 0,
      `BLOCKS.${k} must be a non-empty string`,
    );
    assert.ok(
      typeof PI_INTAKE_EDIT_ACTIONS[k] === "string" && PI_INTAKE_EDIT_ACTIONS[k].length > 0,
      `ACTIONS.${k} must be a non-empty string`,
    );
  }
  // expected canonical block_ids
  assert.equal(PI_INTAKE_EDIT_BLOCKS.TITLE, "pi_intake_edit_title");
  assert.equal(PI_INTAKE_EDIT_BLOCKS.DESCRIPTION, "pi_intake_edit_description");
  assert.equal(PI_INTAKE_EDIT_BLOCKS.PRIORITY, "pi_intake_edit_priority");
  assert.equal(PI_INTAKE_EDIT_BLOCKS.TEAM, "pi_intake_edit_team");
  assert.equal(PI_INTAKE_EDIT_BLOCKS.PROJECT, "pi_intake_edit_project");
}

console.log("intake-edit-modal tests pass");
