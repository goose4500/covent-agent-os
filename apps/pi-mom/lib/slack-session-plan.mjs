// Small helpers for the Slack stream "thinking" surface.
//
// Keep plan titles bridge-owned and stable. They intentionally do not include
// user message text, thread text, or tool names so untrusted Slack content
// cannot affect Slack stream/task-card metadata.

export const DEFAULT_SLACK_SESSION_PLAN_TITLE = "Covent Pi agent session";

export function buildSlackSessionPlanTitle({ env = process.env } = {}) {
  const configuredTitle = String(env.PI_MOM_PLAN_TITLE || "").trim();
  return configuredTitle || DEFAULT_SLACK_SESSION_PLAN_TITLE;
}
