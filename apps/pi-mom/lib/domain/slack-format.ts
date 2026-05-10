import { isImageMime } from "../openai-image-client.ts";
import { redactSensitiveText } from "./redact.ts";
import { ROUTES } from "./routes.ts";

export function truncateForSlack(text, maxChars) {
  const safeText = redactSensitiveText(text || "");
  if (!safeText) return "I did not get a response from Pi.";
  if (safeText.length <= maxChars) return safeText;
  return `${safeText.slice(0, maxChars - 200)}\n\n...truncated by pi-mom because Slack messages have length limits.`;
}

export function splitForSlackStream(text, maxLength) {
  if (!text) return [];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
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
    `• \`@Covent Pi escalation: brief this customer problem\``;
}

export function slackFileLooksLikeImage(file = {}) {
  if (isImageMime(file.mimetype || "")) return true;
  const filetype = String(file.filetype || "").toLowerCase();
  return ["png", "jpg", "jpeg", "webp"].includes(filetype);
}

export function slackImageMime(file = {}) {
  if (isImageMime(file.mimetype || "")) return file.mimetype.split(";")[0].trim();
  const filetype = String(file.filetype || "").toLowerCase();
  if (filetype === "jpg" || filetype === "jpeg") return "image/jpeg";
  if (filetype === "webp") return "image/webp";
  return "image/png";
}
