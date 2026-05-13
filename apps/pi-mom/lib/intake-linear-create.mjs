// Direct Linear IssueCreate helper used by the intake Approve/Edit button
// handlers in index.mjs. We use a direct GraphQL call (not a Pi tool round
// trip) here because we already have a fully-formed proposal payload from
// the human-approved card and a button click is not the right surface to
// spin up a model loop.
//
// Mirrors the env contract and redaction discipline from
// extensions/linear-tools.ts (LINEAR_API_KEY, LINEAR_TEAM_ID,
// LINEAR_PROJECT_ID, LINEAR_STATE_ID, LINEAR_API_URL) so an approved intake
// proposal lands in the same place a model-driven `linear_create_issue`
// call would.

const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title url }
    }
  }
`;

function redactSecrets(text) {
  return String(text || "")
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]")
    .replace(/Authorization:\s*[^\s'"`]+/gi, "Authorization: [REDACTED]");
}

function clampTitle(title) {
  const oneLine = String(title || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "Untitled issue";
  return oneLine.length <= 240 ? oneLine : `${oneLine.slice(0, 237)}...`;
}

// Create one Linear issue from an intake proposal.
//
// proposal = { title, description, priority?, suggested_team_id?, suggested_project_id? }
// options:
//   env          — defaults to process.env
//   fetchImpl    — defaults to global fetch
//   signal       — AbortSignal forwarded to fetch
//   defaults     — { teamId, projectId, stateId } fallbacks layered ABOVE env
//
// Resolution order for team_id / project_id / state_id (most specific wins):
//   1. proposal.suggested_team_id / suggested_project_id   (model suggestion)
//   2. defaults.teamId / defaults.projectId / defaults.stateId   (channel intake defaults)
//   3. env.LINEAR_TEAM_ID / env.LINEAR_PROJECT_ID / env.LINEAR_STATE_ID
//
// Returns { ok: true, issue: { identifier, url, id, title } }
//      or { ok: false, error: "..." }.
export async function createLinearIssueFromProposal(proposal, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const defaults = options.defaults || {};
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "LINEAR_API_KEY is not set; cannot file the issue." };
  }

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

  const apiUrl = env.LINEAR_API_URL || DEFAULT_LINEAR_API_URL;
  try {
    const response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: ISSUE_CREATE_MUTATION, variables: { input } }),
      signal: options.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (Array.isArray(payload?.errors) && payload.errors.length > 0)) {
      const reason = (payload?.errors || []).map((e) => e?.message).filter(Boolean).join("; ")
        || `HTTP ${response.status}`;
      return { ok: false, error: `Linear issueCreate failed: ${redactSecrets(reason)}` };
    }
    const created = payload?.data?.issueCreate;
    if (!created?.success || !created?.issue) {
      return { ok: false, error: "Linear issueCreate returned success=false." };
    }
    return { ok: true, issue: created.issue };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, error: "Linear issueCreate aborted before completion." };
    }
    return { ok: false, error: `Linear issueCreate request error: ${redactSecrets(err?.message || String(err))}` };
  }
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
