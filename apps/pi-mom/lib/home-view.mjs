// Stage 7+ — App Home cockpit view (interactive foundation).
//
// Pure builders that turn a snapshot of bridge state into a Slack Block Kit
// `home` view payload plus the supporting settings modal. Used by
// `app_home_opened` (initial publish), pendingApprovals add/remove pushes,
// and the home_filter / home_refresh / home_settings_open action handlers.
//
// Section order:
//   1. Header           — title + last-updated context
//   2. Tips             — a short markdown block telling users to
//                         just @-mention the bot in a thread; the
//                         agent picks the right tool/skill itself.
//   3. Approvals        — pending Pi tool approvals with per-row
//                         Approve / Cancel buttons that reuse the
//                         `pi_uictx_confirm_approve` / `_cancel` handlers.
//                         A static_select in the section header filters
//                         the list (all / confirm / select / input).
//   4. Recent activity  — last N completed requests (outcome + duration +
//                         permalink). Empty until index.mjs feeds entries
//                         in; placeholder section meanwhile.
//   5. Status           — single-line bridge health.
//   6. Settings footer  — "Open settings" button → read-only settings
//                         modal showing current env-driven config.
//
// Action IDs (handled in index.mjs):
//   pi_uictx_confirm_approve   (existing — reused, value=approvalId)
//   pi_uictx_confirm_cancel    (existing — reused, value=approvalId)
//   home_filter_approvals      (selected_option.value=all|confirm|select|input)
//   home_refresh               (no value, just re-publish)
//   home_settings_open         (opens settings modal)
//
// 2026-block fallback: @slack/web-api ^7.15.2 predates `table` / `alert` /
// `markdown` blocks. We emit `section` + `mrkdwn` instead. Swap when the SDK
// is bumped; callers don't need to change.

const APPROVAL_CAP = 6;
const RECENT_CAP = 5;

const FILTER_OPTIONS = [
  { value: "all", label: "All approvals" },
  { value: "confirm", label: "Confirm only" },
  { value: "select", label: "Select only" },
  { value: "input", label: "Input only" },
];

const TIPS_BODY =
  ":zap: *Tip* — just @-mention me in a thread and ask. The agent picks the right tool/skill:\n" +
  "• _draft a spec_ → streams into a Slack canvas\n" +
  "• _summarize this thread_ / _agenda for tomorrow_\n" +
  "• _file a Linear issue_ → search-before-create\n" +
  "• _use a subagent to …_ → spawns subagents with per-agent canvases";

function truncate(text, max) {
  const v = String(text ?? "").trim();
  if (!v) return "";
  return v.length <= max ? v : `${v.slice(0, Math.max(0, max - 1))}…`;
}

const section = (text, accessory) => {
  const block = { type: "section", text: { type: "mrkdwn", text } };
  if (accessory) block.accessory = accessory;
  return block;
};
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const divider = () => ({ type: "divider" });
const button = (action_id, text, opts = {}) => {
  const el = { type: "button", action_id, text: { type: "plain_text", text } };
  if (opts.value !== undefined) el.value = String(opts.value);
  if (opts.style) el.style = opts.style;
  if (opts.url) el.url = opts.url;
  return el;
};

function approvalsAsList(pendingApprovals) {
  if (Array.isArray(pendingApprovals)) return pendingApprovals;
  return [...(pendingApprovals?.values?.() ?? [])];
}

function filterApprovals(list, filter) {
  if (!filter || filter === "all") return list;
  return list.filter((e) => (e?.type || "confirm") === filter);
}

function filterAccessory(filter) {
  const current = FILTER_OPTIONS.find((o) => o.value === filter) || FILTER_OPTIONS[0];
  return {
    type: "static_select",
    action_id: "home_filter_approvals",
    placeholder: { type: "plain_text", text: "Filter" },
    initial_option: {
      text: { type: "plain_text", text: current.label },
      value: current.value,
    },
    options: FILTER_OPTIONS.map((o) => ({
      text: { type: "plain_text", text: o.label },
      value: o.value,
    })),
  };
}

function headerBlocks({ now }) {
  return [
    { type: "header", text: { type: "plain_text", text: "Covent Pi — Cockpit", emoji: true } },
    context(`Snapshot at ${new Date(now).toISOString()} · click any button to act`),
  ];
}

function tipsBlocks() {
  return [section(TIPS_BODY)];
}

function approvalsBlocks({ list, totalCount, filter }) {
  const headerLine =
    totalCount === 0
      ? section(":sparkles: *No approvals waiting.* The cockpit pushes a new state whenever an extension asks for one.")
      : section(
          `:warning: *${totalCount} approval${totalCount === 1 ? "" : "s"} waiting* · showing ${list.length}`,
          filterAccessory(filter),
        );

  if (totalCount === 0) return [headerLine];

  const shown = list.slice(0, APPROVAL_CAP);
  const cards = shown.flatMap((e) => {
    const title = truncate(e?.title || "Approval required", 80);
    const type = e?.type || "confirm";
    const req = e?.requestId ? ` · req \`${e.requestId}\`` : "";
    const approvalId = e?.approvalId || "";
    const head = section(`• *${title}* (${type})${req}`);
    if (type === "confirm") {
      return [
        head,
        {
          type: "actions",
          elements: [
            button("pi_uictx_confirm_approve", "Approve", { value: approvalId, style: "primary" }),
            button("pi_uictx_confirm_cancel", "Cancel", { value: approvalId, style: "danger" }),
          ],
        },
      ];
    }
    // select/input approvals carry their interactive surface in-thread; from
    // Home we surface them but link the user back via context rather than
    // duplicate the per-option buttons here.
    return [head, context("Resolve from the request thread (per-option buttons live there).")];
  });

  if (list.length > shown.length) {
    cards.push(section(`_…and ${list.length - shown.length} more_`));
  }

  return [headerLine, ...cards];
}

function recentRunsBlocks({ recentRuns }) {
  if (!Array.isArray(recentRuns) || recentRuns.length === 0) {
    return [section(":hourglass_flowing_sand: *Recent activity* — none yet this session.")];
  }
  const head = section(":hourglass_flowing_sand: *Recent activity*");
  const rows = recentRuns.slice(0, RECENT_CAP).map((r) => {
    const icon = r?.outcome === "ok" ? ":white_check_mark:" : r?.outcome === "error" ? ":x:" : ":hourglass:";
    const reqId = r?.requestId ? `\`${r.requestId}\`` : "request";
    const dur = Number.isFinite(r?.durationMs) ? ` · ${Math.round(r.durationMs / 100) / 10}s` : "";
    const link = r?.permalink ? ` · <${r.permalink}|open thread>` : "";
    return section(`${icon} ${reqId}${dur}${link}`);
  });
  return [head, ...rows];
}

function statusBlocks({ status }) {
  if (!status) {
    return [section(":satellite_antenna: *Status* — open settings for full bridge configuration.")];
  }
  const linear = status.linearConfigured ? ":white_check_mark: configured" : ":warning: missing key";
  const slackStream = status.slackStreamingAvailable ? ":white_check_mark: streaming ok" : ":warning: streaming unchecked/missing";
  const browserUse = status.browserUseConfigured ? ":white_check_mark: Browser Use key" : ":warning: Browser Use key missing";
  const subagents = status.subagentsEnabled ? ":white_check_mark: enabled" : ":pause_button: disabled";
  const uptime = Number.isFinite(status.uptimeSeconds) ? `${status.uptimeSeconds}s` : "—";
  return [
    section(
      `:satellite_antenna: *Status* · mode \`${status.mode || "?"}\`` +
        ` · Slack ${slackStream}` +
        ` · ${browserUse}` +
        ` · Linear ${linear}` +
        ` · team subagents ${subagents}` +
        ` · uptime ${uptime}`,
    ),
  ];
}

function settingsFooterBlocks() {
  return [
    {
      type: "actions",
      elements: [
        button("home_settings_open", ":gear: Open settings"),
        button("home_refresh", ":arrows_counterclockwise: Refresh"),
      ],
    },
  ];
}

export function buildHomeView({
  pendingApprovals = [],
  recentRuns = [],
  status = null,
  filter = "all",
  now = Date.now(),
} = {}) {
  const all = approvalsAsList(pendingApprovals);
  const filtered = filterApprovals(all, filter);

  return {
    type: "home",
    blocks: [
      ...headerBlocks({ now }),
      divider(),
      ...tipsBlocks(),
      divider(),
      ...approvalsBlocks({ list: filtered, totalCount: all.length, filter }),
      divider(),
      ...recentRunsBlocks({ recentRuns }),
      divider(),
      ...statusBlocks({ status }),
      ...settingsFooterBlocks(),
    ],
  };
}

export function buildSettingsModalView({ status, prefs } = {}) {
  const lines = [];
  if (status) {
    lines.push(`*Mode*: \`${status.mode || "?"}\``);
    lines.push(`*Pi model*: \`${status.piModel || "?"}\` (thinking \`${status.piThinking || "?"}\`)`);
    lines.push(`*Slack streaming*: ${status.slackStreamingAvailable ? ":white_check_mark: client.chatStream available" : ":warning: client.chatStream missing/unchecked"}`);
    lines.push(`*Browser Use key*: ${status.browserUseConfigured ? ":white_check_mark: configured" : ":warning: missing"}`);
    lines.push(`*Linear*: ${status.linearConfigured ? ":white_check_mark: configured" : ":warning: missing key"}`);
    lines.push(`*Team subagents*: ${status.subagentsEnabled ? ":white_check_mark: enabled" : ":pause_button: disabled"}`);
    lines.push(`*Trace*: \`${status.traceEnabled ? "on" : "off"}\``);
    if (Number.isFinite(status.uptimeSeconds)) lines.push(`*Uptime*: \`${status.uptimeSeconds}s\``);
  } else {
    lines.push("_Status not provided._");
  }
  if (prefs && typeof prefs === "object") {
    lines.push("");
    lines.push("*Your preferences*");
    for (const [k, v] of Object.entries(prefs)) {
      lines.push(`• \`${k}\` = \`${String(v)}\``);
    }
  }
  return {
    type: "modal",
    callback_id: "home_settings_modal",
    title: { type: "plain_text", text: "Covent Pi settings" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      section(lines.join("\n")),
      context("Read-only view of current bridge config · interactive prefs land in a later stage."),
    ],
  };
}

