import { ROUTES } from "./routes.mjs";
import { redactSensitiveText } from "./redact.mjs";

export function truncateForSlack(text, { maxSlackText }) {
  const safeText = redactSensitiveText(text || "");
  if (!safeText) return "I did not get a response from Pi.";
  if (safeText.length <= maxSlackText) return safeText;
  return `${safeText.slice(0, maxSlackText - 200)}\n\n...truncated by pi-mom because Slack messages have length limits.`;
}

export function formatHelp() {
  const routeLines = Object.entries(ROUTES)
    .map(([key, route]) => `• \`${key}:\` ${route.label}`)
    .join("\n");

  return `*Covent Pi commands*\n\n` +
    `• \`help:\` show this menu\n` +
    `• \`status:\` show local bridge health/config\n` +
    `${routeLines}\n\n` +
    `Examples:\n` +
    `• in a thread: \`@Covent Pi draft spec\`\n` +
    `• in a thread: \`@Covent Pi create Linear issue\`\n` +
    `• \`@Covent Pi summarize: decisions, open questions, next actions\`\n` +
    `• \`@Covent Pi linear: create an issue from this thread\`\n` +
    `• \`@Covent Pi image: create a clean Covent hero visual for active buyer intelligence\`\n` +
    `• attach an image in-thread, then \`@Covent Pi image: edit restyle this as a polished Covent website asset\`\n` +
    `• \`@Covent Pi agent: check repo health\`\n` +
    `• \`@Covent Pi escalation: brief this customer problem\``;
}

export async function formatStatus(client, config, startedAt) {
  let authLine = `bot auth: not checked`;
  try {
    const auth = await client.auth.test();
    authLine = `bot auth: ${auth.user} (${auth.user_id}) on ${auth.team}`;
  } catch (error) {
    authLine = `bot auth: failed (${error?.data?.error || error.message})`;
  }

  const uptimeSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  return `*Covent Pi status*\n` +
    `• mode: \`${config.mode}\`\n` +
    `• streaming: \`${config.streamingEnabled ? "on" : "off"}\`\n` +
    `• uptime: \`${uptimeSeconds}s\`\n` +
    `• ${authLine}\n` +
    `• test channel target: \`#${config.testChannelName}\`\n` +
    `• allowed channel: \`${config.allowedChannelId || "any"}\`\n` +
    `• pi command: \`${config.piCommand}\`\n` +
    `• pi tools/extensions: \`${process.env.PI_MOM_ALLOW_PI_TOOLS === "true" ? "enabled" : "disabled"}\`\n` +
    `• image route: \`${config.imageRouteEnabled ? "on" : "off"}\` (${process.env.OPENAI_API_KEY ? config.imageModel : "OPENAI_API_KEY missing"}, ${config.imageQuality}, ${config.imageSize})\n` +
    `• agent route: \`${config.agentRouteEnabled ? "on" : "off"}\` (${config.agentRunnerMode}, canvas ${config.agentCanvasEnabled ? "on" : "off"}, max ${config.agentMaxConcurrent}, command timeout ${config.agentCommandTimeoutMs}ms)\n` +
    `• agent run state: \`${config.runStatePath}\`\n` +
    `• Linear issue creation: \`${process.env.LINEAR_API_KEY ? "configured" : "LINEAR_API_KEY missing"}\`\n` +
    `• Linear target: team \`${config.linearTeamId}\`, project \`${config.linearProjectId}\`, state \`${config.linearStateId}\`\n` +
    `• trace: \`${config.traceEnabled ? "on" : "off"}\`\n` +
    `• routes: \`${Object.keys(ROUTES).join(", ")}\``;
}
