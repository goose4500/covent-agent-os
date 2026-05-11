import assert from "node:assert/strict";
import {
  parseCommand,
  parseSlackRequestCommand,
  parseSlackThreadReference,
  stripBotMentions,
} from "./lib/domain/commands.mjs";
import { buildPiPrompt } from "./lib/domain/prompt.mjs";
import { extractLinearIssuePayload } from "./lib/domain/linear-payload.mjs";
import { redactSensitiveText, stripTerminalSequences } from "./lib/domain/redact.mjs";
import { truncateForSlack } from "./lib/domain/slack-format.mjs";

assert.equal(stripBotMentions("<@U123> summarize: decisions"), "summarize: decisions");

const explicitRoute = parseCommand("summarize: decisions and next actions");
assert.equal(explicitRoute.kind, "route");
assert.equal(explicitRoute.routeKey, "summarize");
assert.equal(explicitRoute.text, "decisions and next actions");

const unknownRoute = parseCommand("unknown: keep literal");
assert.deepEqual(unknownRoute, { kind: "plain", text: "unknown: keep literal" });

const naturalSpec = parseSlackRequestCommand("draft spec focused on onboarding", { mode: "app_mention" });
assert.equal(naturalSpec.kind, "route");
assert.equal(naturalSpec.routeKey, "spec");
assert.equal(naturalSpec.requiresThread, true);

const naturalLinear = parseSlackRequestCommand("create Linear issue for this", { mode: "app_mention" });
assert.equal(naturalLinear.kind, "route");
assert.equal(naturalLinear.routeKey, "linear");
assert.equal(naturalLinear.requiresThread, true);

const dmPlain = parseSlackRequestCommand("create Linear issue for this", { mode: "direct_message" });
assert.deepEqual(dmPlain, { kind: "plain", text: "create Linear issue for this" });

const reference = parseSlackThreadReference("https://covent.slack.com/archives/C123/p1712345678123456?thread_ts=1712345678.123456 focus here");
assert.equal(reference.channel, "C123");
assert.equal(reference.messageTs, "1712345678.123456");
assert.equal(reference.threadTs, "1712345678.123456");
assert.equal(reference.remainingText, "focus here");

const prompt = buildPiPrompt({
  mode: "app_mention",
  user: "U123",
  channel: "C123",
  threadTs: "1712345678.123456",
  text: "summarize this",
  threadContext: "thread context",
  routeKey: explicitRoute.routeKey,
  route: explicitRoute.route,
  testChannelName: "idea-specs",
});
assert.match(prompt, /Routed workflow:/);
assert.match(prompt, /Test channel target: #idea-specs/);
assert.match(prompt, /thread context/);

const payload = extractLinearIssuePayload("```markdown\nTitle: Ship modal MVP\n\n## Acceptance\n- opens modal\n```");
assert.equal(payload.title, "Ship modal MVP");
assert.match(payload.description, /Acceptance/);

assert.equal(redactSensitiveText("Authorization: Bearer xoxb-secret"), "Authorization: Bearer [REDACTED]");
assert.equal(stripTerminalSequences("\u001b[31mred\u001b[0m"), "red");
assert.equal(truncateForSlack("", { maxSlackText: 100 }), "I did not get a response from Pi.");
assert.match(truncateForSlack("a".repeat(300), { maxSlackText: 120 }), /truncated by pi-mom/);

console.log("domain seam tests passed");
