import assert from "node:assert/strict";
import {
  hasVisibleSlackText,
  normalizeSlackMarkdown,
  slackSafeOneLine,
} from "./lib/slack-format.mjs";

// Snapshot-style representative Slack output: preserve headings, nested
// bullets, indentation, and fenced code while normalizing Slack-hostile noise.
{
  const input = [
    "# Investigation summary   ",
    "",
    "",
    "",
    "- Root cause   ",
    "  - Browser Use broad navigation timed out\u200B",
    "  - Slack only saw a generic error   ",
    "    - request: req_mp67tra6   ",
    "",
    "",
    "",
    "",
    "```",
    "const value = 'keep trailing spaces in code';   ",
    "",
    "```",
    "Next: retry with direct URLs.   ",
  ].join("\n");

  const expected = [
    "# Investigation summary",
    "",
    "",
    "- Root cause",
    "  - Browser Use broad navigation timed out",
    "  - Slack only saw a generic error",
    "    - request: req_mp67tra6",
    "",
    "",
    "```",
    "const value = 'keep trailing spaces in code';   ",
    "",
    "```",
    "Next: retry with direct URLs.",
  ].join("\n");

  assert.equal(normalizeSlackMarkdown(input), expected);
}

// Zero-width-only chunks are invisible in Slack and should not become a
// misleading empty message.
{
  assert.equal(normalizeSlackMarkdown("\u200B\u200C\n\t"), "");
  assert.equal(hasVisibleSlackText("\u200B\u200C"), false);
  assert.equal(hasVisibleSlackText("\u200Bvisible"), true);
}

// One-line summaries are compact, whitespace-normalized, and capped.
{
  const one = slackSafeOneLine(" Browser Use\n\nAPI   401: invalid key " + "x".repeat(300), { max: 80 });
  assert.equal(one.length, 80);
  assert.match(one, /^Browser Use API 401: invalid key/);
  assert.match(one, /…$/);
}

console.log("slack-format tests passed");
