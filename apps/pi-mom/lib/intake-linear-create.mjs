// Direct Linear IssueCreate path used by the intake Approve/Edit-submit
// button handlers in index.mjs. A button click is not the right surface to
// spin up a model loop, so we call Linear's GraphQL directly with the
// already-human-approved proposal. Reuses the canonical helpers from
// extensions/linear-tools.ts so this stays one source of truth.

import {
  ISSUE_CREATE_MUTATION,
  clampTitle,
  linearGraphQL,
} from "../../../extensions/linear-tools.ts";

// Resolve team_id / project_id / state_id (most specific wins):
//   1. proposal.suggested_*               (model suggestion)
//   2. defaults.{teamId,projectId,stateId} (channel intake defaults)
//   3. env.LINEAR_*                       (bot-wide defaults)
export async function createLinearIssueFromProposal(proposal, options = {}) {
  const env = options.env || process.env;
  const defaults = options.defaults || {};
  const teamId = pickFirstString(
    proposal?.suggested_team_id,
    defaults.teamId,
    env.LINEAR_TEAM_ID,
  );
  if (!teamId) {
    return { ok: false, error: "No team_id available (no suggested_team_id, INTAKE_DEFAULT_TEAM_ID, or LINEAR_TEAM_ID)." };
  }
  const projectId = pickFirstString(
    proposal?.suggested_project_id,
    defaults.projectId,
    env.LINEAR_PROJECT_ID,
  );
  const stateId = pickFirstString(defaults.stateId, env.LINEAR_STATE_ID);

  const title = clampTitle(proposal?.title);
  const description = String(proposal?.description || "").trim();
  if (!description) {
    return { ok: false, error: "Proposal description is empty." };
  }

  const input = { teamId, title, description };
  if (projectId) input.projectId = projectId;
  if (stateId) input.stateId = stateId;
  if (typeof proposal?.priority === "number" && proposal.priority >= 0 && proposal.priority <= 4) {
    input.priority = proposal.priority;
  }

  const result = await linearGraphQL(ISSUE_CREATE_MUTATION, { input }, {
    env,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    label: "issueCreate",
  });
  if ("error" in result) return { ok: false, error: result.error };
  const created = result.data?.issueCreate;
  if (!created?.success || !created?.issue) {
    return { ok: false, error: "Linear issueCreate returned success=false." };
  }
  return { ok: true, issue: created.issue };
}

function pickFirstString(...values) {
  for (const v of values) {
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}
