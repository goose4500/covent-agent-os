import { cleanPiOutput } from "./redact.mjs";

export function clampLinearTitle(title = "") {
  const singleLine = String(title || "").replace(/\s+/g, " ").trim();
  if (!singleLine) return "Slack thread spec";
  return singleLine.length <= 240 ? singleLine : `${singleLine.slice(0, 237)}...`;
}

export function stripWrappingMarkdownFence(text = "") {
  return String(text || "")
    .trim()
    .replace(/^```(?:markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function extractLinearIssuePayload(piOutput = "") {
  const cleaned = stripWrappingMarkdownFence(cleanPiOutput(piOutput));
  const lines = cleaned.split(/\r?\n/);
  const titleLineIndex = lines.findIndex((line, index) => index < 12 && /^\s*(?:#{1,3}\s*)?(?:title|issue title)\s*:\s+/i.test(line));

  if (titleLineIndex >= 0) {
    const title = lines[titleLineIndex].replace(/^\s*(?:#{1,3}\s*)?(?:title|issue title)\s*:\s+/i, "").trim();
    const description = stripWrappingMarkdownFence(lines.filter((_, index) => index !== titleLineIndex).join("\n")) || cleaned;
    return { title: clampLinearTitle(title), description };
  }

  const headingLineIndex = lines.findIndex((line, index) => index < 12 && /^\s*#{1,3}\s+\S+/.test(line));
  if (headingLineIndex >= 0) {
    const title = lines[headingLineIndex].replace(/^\s*#{1,3}\s+/, "").trim();
    return { title: clampLinearTitle(title), description: cleaned };
  }

  const firstUsefulLine = lines.find((line) => line.trim()) || "Slack thread spec";
  return { title: clampLinearTitle(firstUsefulLine.replace(/^\*+|\*+$/g, "")), description: cleaned };
}
