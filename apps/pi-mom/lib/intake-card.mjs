// PRD-intake Slack card builder.
//
// Pure functions that turn a single AI proposal (and the per-zip parent
// summary) into Slack Block Kit payloads. The intake orchestrator owns the
// state; this module just renders.
//
// Action IDs are stable contract with `index.mjs`:
//   pi_intake_approve       (style: primary) — create the Linear issue
//   pi_intake_cancel        (style: danger)  — mark the proposal dismissed
//   pi_intake_edit_launch   (unstyled)       — open the edit modal
//
// Every button's `value` is the approvalId so the action handler can resolve
// the pendingApprovals entry without parsing block_ids.

const ACTION_IDS = Object.freeze({
  APPROVE: "pi_intake_approve",
  CANCEL: "pi_intake_cancel",
  EDIT: "pi_intake_edit_launch",
});

const PRIORITY_LABELS = Object.freeze({
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
});

function clamp(text, max) {
  const v = String(text ?? "");
  if (!v) return "";
  return v.length <= max ? v : `${v.slice(0, Math.max(0, max - 1))}…`;
}

function trimmedTitle(title) {
  return clamp(String(title ?? "").trim() || "(untitled proposal)", 200);
}

function priorityLabel(priority) {
  if (priority == null) return "P0 (none)";
  const n = Number(priority);
  if (!Number.isFinite(n)) return "P0 (none)";
  const label = PRIORITY_LABELS[n] ?? "none";
  return `P${n} (${label})`;
}

function fmtSuggested(value, fallbackLabel = "default") {
  const v = String(value ?? "").trim();
  return v ? `\`${v}\`` : `\`${fallbackLabel}\``;
}

function headerText({ proposalIndex, proposalTotal, title }) {
  const t = trimmedTitle(title);
  if (proposalIndex && proposalTotal) {
    return clamp(`Proposal ${proposalIndex} of ${proposalTotal}: ${t}`, 150);
  }
  if (proposalIndex) {
    return clamp(`Proposal ${proposalIndex}: ${t}`, 150);
  }
  return clamp(t, 150);
}

function statusHeaderSuffix({ status, actorUserId }) {
  const who = actorUserId ? `<@${actorUserId}>` : "someone";
  switch (status) {
    case "approved":
      return `Approved by ${who}`;
    case "edited":
      return `Approved (edited) by ${who}`;
    case "canceled":
      return `Canceled by ${who}`;
    case "claimed":
      return `Being edited by ${who}…`;
    default:
      return null;
  }
}

export function buildProposalCardBlocks(proposal = {}, opts = {}) {
  const {
    approvalId = "",
    status = "pending",
    linearIssue,
    actorUserId,
    proposalIndex,
    proposalTotal,
  } = opts;

  const safeProposal = proposal && typeof proposal === "object" ? proposal : {};
  const title = trimmedTitle(safeProposal.title);
  const description = String(safeProposal.description ?? "").trim();
  const priority = safeProposal.priority;
  const teamId = safeProposal.suggested_team_id;
  const projectId = safeProposal.suggested_project_id;
  const requestId = opts.requestId;

  const blocks = [];

  // 1. Header: "Proposal N of M: <title>"
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: headerText({ proposalIndex, proposalTotal, title }),
      emoji: true,
    },
  });

  // 2. Optional status banner (for non-pending states).
  const statusLine = statusHeaderSuffix({ status, actorUserId });
  if (statusLine) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `*${statusLine}*` }],
    });
  }

  // 3. Description preview (first 800 chars). Slack section text is capped at
  //    3000; we stay well below so the rest is left for the edit modal.
  const preview = description ? clamp(description, 800) : "_(no description provided)_";
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: clamp(preview, 2900) },
  });

  // 4. Linear issue link when approved/edited.
  if ((status === "approved" || status === "edited") && linearIssue && linearIssue.url) {
    const ident = linearIssue.identifier ? `*${linearIssue.identifier}*` : "*Linear issue*";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:white_check_mark: ${ident} — <${linearIssue.url}|open in Linear>` },
    });
  }

  // 5. Action buttons — only while pending; hidden once acted on or claimed.
  if (status === "pending") {
    blocks.push({
      type: "actions",
      block_id: `pi_intake_actions_${approvalId || "x"}`.slice(0, 255),
      elements: [
        {
          type: "button",
          action_id: ACTION_IDS.APPROVE,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: String(approvalId),
        },
        {
          type: "button",
          action_id: ACTION_IDS.CANCEL,
          style: "danger",
          text: { type: "plain_text", text: "Cancel" },
          value: String(approvalId),
        },
        {
          type: "button",
          action_id: ACTION_IDS.EDIT,
          text: { type: "plain_text", text: "Edit" },
          value: String(approvalId),
        },
      ],
    });
  }

  // 6. Footer context line: req / approval / priority / team / project.
  const footerParts = [
    `req: \`${String(requestId ?? "").trim() || "?"}\``,
    `approval: \`${String(approvalId ?? "").trim() || "?"}\``,
    `priority: ${priorityLabel(priority)}`,
    `suggested team: ${fmtSuggested(teamId, "default")}`,
    `suggested project: ${fmtSuggested(projectId, "default")}`,
  ];
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: clamp(footerParts.join(" · "), 2900) }],
  });

  return blocks;
}

export function buildIntakeSummaryBlocks(opts = {}) {
  const {
    files = [],
    skipped = [],
    proposalCount = 0,
    requestId,
    zipFilename,
  } = opts;

  const safeFiles = Array.isArray(files) ? files : [];
  const safeSkipped = Array.isArray(skipped) ? skipped : [];
  const totalProposals = Number(proposalCount) || 0;

  const filenameLabel = zipFilename ? `*${clamp(String(zipFilename), 200)}*` : "*intake zip*";

  const headerLine = `:inbox_tray: ${filenameLabel} — extracted *${safeFiles.length}* file${
    safeFiles.length === 1 ? "" : "s"
  }, skipped *${safeSkipped.length}*, proposing *${totalProposals}* Linear issue${
    totalProposals === 1 ? "" : "s"
  }`;

  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: clamp(headerLine, 2900) } },
  ];

  if (safeFiles.length > 0) {
    const lines = safeFiles.slice(0, 20).map((f) => {
      const name = f?.relPath || f?.name || "(unnamed)";
      const bytes = Number(f?.sizeBytes);
      const trunc = f?.truncated ? " _(truncated)_" : "";
      const size = Number.isFinite(bytes) ? ` — ${bytes} bytes` : "";
      return `• \`${clamp(name, 120)}\`${size}${trunc}`;
    });
    if (safeFiles.length > 20) lines.push(`_…and ${safeFiles.length - 20} more_`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clamp(`*Files used:*\n${lines.join("\n")}`, 2900) },
    });
  }

  if (safeSkipped.length > 0) {
    const lines = safeSkipped.slice(0, 20).map((s) => {
      const name = s?.relPath || s?.name || "(unnamed)";
      const reason = s?.reason ? ` — ${s.reason}` : "";
      return `• \`${clamp(name, 120)}\`${reason}`;
    });
    if (safeSkipped.length > 20) lines.push(`_…and ${safeSkipped.length - 20} more_`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clamp(`*Skipped:*\n${lines.join("\n")}`, 2900) },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `req: \`${String(requestId ?? "").trim() || "?"}\` · ${totalProposals} proposal${
          totalProposals === 1 ? "" : "s"
        } follow${totalProposals === 1 ? "s" : ""} in this thread`,
      },
    ],
  });

  return blocks;
}

export const PI_INTAKE_ACTION_IDS = ACTION_IDS;
