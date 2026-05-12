// Stage 7 — App Home cockpit view.
//
// Pure builder that turns a snapshot of bridge state into a Slack Block Kit
// `home` view payload. Used by both `app_home_opened` (initial publish) and
// push updates triggered from pendingApprovals add/remove.
//
// 2026-block fallback: Slack ships `table` / `alert` / `markdown` as dedicated
// blocks in newer SDKs, but @slack/web-api ^7.15.2 predates them. We emit
// `section` blocks with `mrkdwn` text instead. When the SDK is bumped, swap
// the helpers here — callers don't need to change.

const APPROVAL_CAP = 6;

function truncate(text, max) {
  const v = String(text ?? "").trim();
  if (!v) return "";
  return v.length <= max ? v : `${v.slice(0, Math.max(0, max - 1))}…`;
}

const section = (text) => ({ type: "section", text: { type: "mrkdwn", text } });

function approvalsBlock(pendingApprovals = []) {
  const list = Array.isArray(pendingApprovals) ? pendingApprovals : [...(pendingApprovals.values?.() ?? [])];
  if (list.length === 0) {
    return section(":sparkles: *No approvals waiting.* The cockpit pushes a new state whenever an extension asks for one.");
  }
  const shown = list.slice(0, APPROVAL_CAP);
  const lines = shown.map((e) => {
    const title = truncate(e?.title || "Approval required", 80);
    const req = e?.requestId ? ` · req \`${e.requestId}\`` : "";
    return `• *${title}* (${e?.type || "confirm"})${req}`;
  });
  if (list.length > shown.length) lines.push(`_…and ${list.length - shown.length} more_`);
  return section(`:warning: *${list.length} approval${list.length === 1 ? "" : "s"} waiting*\n${lines.join("\n")}`);
}

export function buildHomeView({ pendingApprovals = [], now = Date.now() } = {}) {
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Covent Pi — Cockpit", emoji: true } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Snapshot at ${new Date(now).toISOString()} · read-only view` }] },
      { type: "divider" },
      approvalsBlock(pendingApprovals),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Cockpit pushes update on approval state changes. Action affordances land in a later stage." }],
      },
    ],
  };
}
