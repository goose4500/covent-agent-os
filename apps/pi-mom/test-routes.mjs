import assert from "node:assert/strict";
import test from "node:test";
import {
  extractLinearIssuePayload,
  parseCommand,
  parseSlackRequestCommand,
  parseSlackThreadReference,
  redactSensitiveText,
  stripBotMentions,
} from "./lib/routes.mjs";

test("route parser handles explicit Slack route prefixes", () => {
  assert.equal(parseCommand("linear: create issue").kind, "route");
  assert.equal(parseCommand("linear: create issue").routeKey, "linear");
  assert.equal(parseCommand("image: make hero").routeKey, "image");
  assert.equal(parseCommand("agent: repo health").routeKey, "agent");
  assert.equal(parseCommand("summarize: decisions").routeKey, "summarize");
  assert.equal(parseCommand("unknown: value").kind, "plain");
});

test("route parser handles help and status", () => {
  assert.equal(parseCommand("help:").kind, "help");
  assert.equal(parseCommand("?").kind, "help");
  assert.equal(parseCommand("status:").kind, "status");
});

test("app mentions detect natural spec and Linear issue intents", () => {
  const spec = parseSlackRequestCommand("draft spec", { mode: "app_mention" });
  assert.equal(spec.kind, "route");
  assert.equal(spec.routeKey, "spec");
  assert.equal(spec.naturalIntent, "thread_spec");
  assert.equal(spec.requiresThread, true);

  const linear = parseSlackRequestCommand("create Linear issue for activation bug", { mode: "app_mention" });
  assert.equal(linear.kind, "route");
  assert.equal(linear.routeKey, "linear");
  assert.equal(linear.naturalIntent, "linear_issue_create");
  assert.equal(linear.text, "for activation bug");
});

test("direct messages do not infer app-mention-only natural intents", () => {
  const command = parseSlackRequestCommand("create Linear issue", { mode: "direct_message" });
  assert.equal(command.kind, "plain");
});

test("bot mention stripping handles Slack IDs and visible bot names", () => {
  assert.equal(stripBotMentions("<@U123ABC> draft spec"), "draft spec");
  assert.equal(stripBotMentions("@Covent Pi status:"), "status:");
  assert.equal(stripBotMentions("covent-agent help:"), "help:");
});

test("Slack thread reference parser extracts channel, message ts, thread ts, and focus", () => {
  const parsed = parseSlackThreadReference("https://covent.slack.com/archives/C0123456789/p1715000000123456?thread_ts=1714999999.654321 focus text");
  assert.equal(parsed.channel, "C0123456789");
  assert.equal(parsed.messageTs, "1715000000.123456");
  assert.equal(parsed.threadTs, "1714999999.654321");
  assert.equal(parsed.remainingText, "focus text");
});

test("Linear issue payload extraction prefers explicit title then headings then first line", () => {
  assert.deepEqual(extractLinearIssuePayload("Title: Fix Slack route\n\nBody"), { title: "Fix Slack route", description: "Body" });
  assert.equal(extractLinearIssuePayload("## Improve route tests\n\nBody").title, "Improve route tests");
  assert.equal(extractLinearIssuePayload("Plain first line\nmore").title, "Plain first line");
});

test("redaction removes common token forms", () => {
  const redacted = redactSensitiveText([
    "xoxb-1234567890-secret",
    "xapp-1-A-secret",
    "sk-proj-secret_123",
    "lin_api_secret123",
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "AKIA1234567890ABCDEF",
    "Authorization: Bearer abc.def.ghi",
    "OPENAI_API_KEY=sk-test",
  ].join("\n"));
  assert(!redacted.includes("xoxb-1234567890-secret"));
  assert(!redacted.includes("lin_api_secret123"));
  assert(!redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
  assert(!redacted.includes("AKIA1234567890ABCDEF"));
  assert(redacted.includes("[REDACTED]"));
});
