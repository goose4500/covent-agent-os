const PROMPT_PREVIEW_CHARS = 1500;

export function parseAgentRequest(text = "") {
  const prompt = String(text || "").trim();
  if (!prompt) return undefined;
  return { prompt };
}

function truncate(text = "", max = PROMPT_PREVIEW_CHARS) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 20)}… (truncated)`;
}

function statusEmoji(status = "") {
  return {
    pending_confirmation: "⏳",
    running: "🏃",
    succeeded: "✅",
    failed: "❌",
    canceled: "🛑",
    interrupted: "⚠️",
  }[status] || "•";
}

export function formatRunSummary(run = {}) {
  const status = run.status || "unknown";
  return `${statusEmoji(status)} Agent run ${run.id || "unknown"}: ${status}`;
}

function field(text) {
  return { type: "mrkdwn", text };
}

function runFields(run) {
  return [
    field(`*Run ID*\n\`${run.id}\``),
    field(`*Status*\n\`${run.status || "unknown"}\``),
    field(`*Runner*\n\`${run.runnerMode || "fake"}\``),
    field(`*Requester*\n${run.user ? `<@${run.user}>` : "unknown"}`),
  ];
}

function eventLines(run) {
  const events = Array.isArray(run.events) ? run.events.slice(-5) : [];
  if (!events.length) return "No events yet.";
  return events.map((event) => `• ${event.ts || ""} ${event.text || event.type || "event"}`.trim()).join("\n");
}

function metadataValue(value, fallback = "Not specified") {
  if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
  return String(value || "").trim() || fallback;
}

function actionMetadataFields(action = {}) {
  return [
    field(`*Action*\n${metadataValue(action.name || action.key, "Run Action")}`),
    field(`*Risk*\n${metadataValue(action.riskLevel, "bounded")}`),
    field(`*Approval*\n${metadataValue(action.approvalMode, "Slack confirmation required")}`),
    field(`*Artifacts / Source*\n${metadataValue(action.artifacts, "Slack thread updates")} / ${metadataValue(action.sourceLinks, "Slack source thread")}`),
  ];
}

function friendlyActionSentence(action = {}) {
  const risk = metadataValue(action.riskLevel, "bounded").toLowerCase();
  const approval = metadataValue(action.approvalMode, "Slack confirmation required before start");
  if (risk.includes("read-only")) {
    return "This is read-only, starts after Slack confirmation, and returns results to this Slack thread.";
  }
  if (approval.toLowerCase().includes("confirmation")) {
    return "This bounded Action starts only after Slack confirmation, and returns results to this Slack thread.";
  }
  return `This bounded Action uses ${approval} and returns results to this Slack thread.`;
}

export function buildAgentRunCard(run, actionMetadata = {}) {
  return {
    text: formatRunSummary(run),
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Agent run confirmation", emoji: true } },
      { type: "section", fields: runFields(run) },
      { type: "section", fields: actionMetadataFields(actionMetadata) },
      { type: "context", elements: [{ type: "mrkdwn", text: friendlyActionSentence(actionMetadata) }] },
      ...(run.sourceUrl ? [{ type: "section", text: { type: "mrkdwn", text: `*Source*\n<${run.sourceUrl}|Slack thread>` } }] : []),
      { type: "section", text: { type: "mrkdwn", text: `*Prompt*\n>${truncate(run.prompt || "(empty)").replace(/\n/g, "\n>")}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Safety: no repo writes in MVP. Runner mode is bounded to `fake` or `repo-health`; Pi tools stay default-off." }] },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Start Run", emoji: true },
            style: "primary",
            action_id: "agent_run_start",
            value: run.id,
            confirm: {
              title: { type: "plain_text", text: "Start agent run?" },
              text: { type: "mrkdwn", text: "Start this bounded agent run now?" },
              confirm: { type: "plain_text", text: "Start" },
              deny: { type: "plain_text", text: "Back" },
            },
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Cancel", emoji: true },
            style: "danger",
            action_id: "agent_run_cancel",
            value: run.id,
            confirm: {
              title: { type: "plain_text", text: "Cancel agent run?" },
              text: { type: "mrkdwn", text: "Cancel this pending or running agent run?" },
              confirm: { type: "plain_text", text: "Cancel run" },
              deny: { type: "plain_text", text: "Back" },
            },
          },
        ],
      },
    ],
  };
}

export function buildAgentRunUpdate(run) {
  const resultText = run.result?.markdown ? `\n\n*Result*\n${truncate(run.result.markdown, 2500)}` : "";
  const errorText = run.error ? `\n\n*Error*\n\`${truncate(run.error, 1000)}\`` : "";
  const canvasText = run.canvas?.url
    ? `\n\n*Canvas*\n<${run.canvas.url}|Open run canvas>`
    : (run.canvas?.id ? `\n\n*Canvas*\n\`${run.canvas.id}\`` : "");
  return {
    text: formatRunSummary(run),
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Agent run update", emoji: true } },
      { type: "section", fields: runFields(run) },
      { type: "section", text: { type: "mrkdwn", text: `*Recent events*\n${eventLines(run)}${resultText}${errorText}${canvasText}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Bounded Agent Run Card MVP. Repo-health uses fixed read-only command tuples with shell disabled." }] },
    ],
  };
}
