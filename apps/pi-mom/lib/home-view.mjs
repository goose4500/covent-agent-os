// Stage 7 — App Home cockpit view.
//
// Pure builder that turns a snapshot of bridge state into a Slack Block Kit
// `home` view payload. Used by both `app_home_opened` (initial publish) and
// push updates triggered from runStore mutations + pendingApprovals add/remove.
//
// 2026-block fallback: Slack ships `table` / `alert` / `markdown` as dedicated
// blocks in newer SDKs, but @slack/web-api ^7.15.2 predates them. We emit
// `section` blocks with `mrkdwn` text instead. When the SDK is bumped, swap
// the helpers here — callers don't need to change.

const RUN_CAP = 8;
const ACTIVITY_CAP = 12;
const APPROVAL_CAP = 6;
const PROMPT_PREVIEW = 80;

const STATUS_EMOJI = {
  pending_confirmation: ":hourglass_flowing_sand:",
  running: ":runner:",
  succeeded: ":white_check_mark:",
  failed: ":x:",
  canceled: ":octagonal_sign:",
  interrupted: ":warning:",
};

function truncate(text, max) {
  const v = String(text ?? "").trim();
  if (!v) return "";
  return v.length <= max ? v : `${v.slice(0, Math.max(0, max - 1))}…`;
}

function formatRelative(now, iso) {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const sec = Math.floor(Math.max(0, now - then) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const isActive = (run = {}) => run.status === "pending_confirmation" || run.status === "running";
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text } });
const emoji = (s) => STATUS_EMOJI[s] || ":small_blue_diamond:";

function approvalsBlock(pendingApprovals = []) {
  const list = Array.isArray(pendingApprovals) ? pendingApprovals : [...(pendingApprovals.values?.() ?? [])];
  if (list.length === 0) return undefined;
  const shown = list.slice(0, APPROVAL_CAP);
  const lines = shown.map((e) => {
    const title = truncate(e?.title || "Approval required", 80);
    const req = e?.requestId ? ` · req \`${e.requestId}\`` : "";
    return `• *${title}* (${e?.type || "confirm"})${req}`;
  });
  if (list.length > shown.length) lines.push(`_…and ${list.length - shown.length} more_`);
  return section(`:warning: *${list.length} approval${list.length === 1 ? "" : "s"} waiting*\n${lines.join("\n")}`);
}

function runRow(run, now) {
  const prompt = truncate(run.prompt || "(no prompt)", PROMPT_PREVIEW).replace(/\n/g, " ");
  const requester = run.user ? `<@${run.user}>` : "—";
  const when = formatRelative(now, run.startedAt || run.createdAt);
  return section(`${emoji(run.status)} \`${run.id || "unknown"}\` — *${run.status || "unknown"}* · ${requester} · ${when}\n>${prompt}`);
}

function inflightBlocks(activeRuns, now) {
  const list = Array.isArray(activeRuns) ? activeRuns : [];
  if (list.length === 0) {
    return [section(":zzz: *No agent runs in flight.* Mention the bot with `agent: <task>` to start one.")];
  }
  const shown = list.slice(0, RUN_CAP);
  const blocks = [section(`:satellite_antenna: *${list.length} run${list.length === 1 ? "" : "s"} in flight*`), ...shown.map((r) => runRow(r, now))];
  if (list.length > shown.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `_…and ${list.length - shown.length} more not shown_` }] });
  }
  return blocks;
}

function activityBlock(recentRuns, now) {
  const list = Array.isArray(recentRuns) ? recentRuns : [];
  if (list.length === 0) return section("_No recent activity yet._");
  const lines = list.slice(0, ACTIVITY_CAP).map((r) => {
    const when = formatRelative(now, r.finishedAt || r.updatedAt || r.createdAt);
    const requester = r.user ? `<@${r.user}>` : "—";
    return `${emoji(r.status)} \`${r.id || "?"}\` ${r.status || "unknown"} · ${requester} · ${when}`;
  });
  return section(lines.join("\n"));
}

export function buildHomeView({ activeRuns = [], recentRuns = [], pendingApprovals = [], now = Date.now() } = {}) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "Covent Pi — Cockpit", emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Snapshot at ${new Date(now).toISOString()} · read-only view` }] },
  ];
  const alert = approvalsBlock(pendingApprovals);
  if (alert) blocks.push(alert, { type: "divider" });
  blocks.push(...inflightBlocks(activeRuns, now));
  blocks.push({ type: "divider" });
  blocks.push({ type: "header", text: { type: "plain_text", text: "Recent activity", emoji: true } });
  blocks.push(activityBlock(recentRuns, now));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Stage 7 cockpit · pushes update on run + approval state changes. Action affordances land in a later stage." }],
  });
  return { type: "home", blocks };
}

export function partitionRuns(runs = []) {
  const activeRuns = [];
  const recentRuns = [];
  for (const run of runs) {
    if (isActive(run)) activeRuns.push(run);
    else recentRuns.push(run);
  }
  return { activeRuns, recentRuns };
}
