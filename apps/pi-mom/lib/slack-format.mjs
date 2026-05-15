// Small Slack-safe formatting helpers for outbound mrkdwn.
//
// Keep this conservative: normalize line endings, remove invisible zero-width
// characters from user/model-visible text, trim trailing spaces on completed
// non-code lines, and cap pathological blank-line runs. Do not aggressively
// rewrite Markdown content or code fences.

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const ZERO_WIDTH_PRESENT_RE = /[\u200B-\u200D\uFEFF]/;
const FENCE_RE = /^\s*```/;

export function hasVisibleSlackText(text = "") {
  return String(text ?? "").replace(ZERO_WIDTH_RE, "").trim().length > 0;
}

export function normalizeSlackMarkdown(text = "", {
  maxConsecutiveBlankLines = 2,
  preserveWhitespaceOnly = false,
  preserveOpenLineTrailingSpace = false,
} = {}) {
  const raw = String(text ?? "");
  if (!raw) return "";

  const hadZeroWidth = ZERO_WIDTH_PRESENT_RE.test(raw);
  const withoutZeroWidth = raw.replace(ZERO_WIDTH_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!withoutZeroWidth) return "";

  const hasVisible = withoutZeroWidth.trim().length > 0;
  // A chunk made only of zero-width characters (possibly with whitespace) is
  // invisible in Slack and looks like a broken/empty response. Heartbeats must
  // bypass this helper explicitly.
  if (hadZeroWidth && !hasVisible) return "";
  if (!hasVisible && !preserveWhitespaceOnly) return "";

  const maxBlank = Math.max(0, Number(maxConsecutiveBlankLines) || 0);
  const endsWithNewline = withoutZeroWidth.endsWith("\n");
  const lines = withoutZeroWidth.split("\n");
  const out = [];
  let inFence = false;
  let blankRun = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isLastOpenLine = index === lines.length - 1 && !endsWithNewline;
    const fenceLine = FENCE_RE.test(line);
    let normalizedLine = line;

    if (!inFence && (!isLastOpenLine || !preserveOpenLineTrailingSpace)) {
      normalizedLine = normalizedLine.replace(/[ \t]+$/g, "");
    }

    const isBlankOutsideFence = !inFence && normalizedLine.trim() === "";
    if (isBlankOutsideFence) {
      blankRun += 1;
      if (blankRun <= maxBlank) out.push("");
      continue;
    }

    blankRun = 0;
    out.push(normalizedLine);
    if (fenceLine) inFence = !inFence;
  }

  return out.join("\n");
}

export function slackSafeOneLine(text = "", { max = 240 } = {}) {
  const oneLine = normalizeSlackMarkdown(text)
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return "";
  const limit = Math.max(1, Number(max) || 240);
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, Math.max(0, limit - 1))}…`;
}
