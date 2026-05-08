import test from "node:test";
import assert from "node:assert/strict";

import {
  ROUTES,
  parseCommand,
  parseLinearCreateIntent,
  parseSlackRequestCommand,
  parseThreadSpecIntent,
  stripBotMentions,
} from "./route-parser.mjs";

test("stripBotMentions removes Slack mention markup and visible bot prefixes", () => {
  assert.equal(stripBotMentions("<@U123ABC> summarize: decisions"), "summarize: decisions");
  assert.equal(stripBotMentions("<@U123ABC|covent_pi> draft spec"), "draft spec");
  assert.equal(stripBotMentions("Covent Pi create Linear issue"), "create Linear issue");
  assert.equal(stripBotMentions("@covent-agent status:"), "status:");
});

test("parseCommand recognizes help and status commands", () => {
  assert.deepEqual(parseCommand("help:"), { kind: "help" });
  assert.deepEqual(parseCommand("?"), { kind: "help" });
  assert.deepEqual(parseCommand("status"), { kind: "status" });
});

test("parseCommand recognizes the supported explicit route prefixes", () => {
  for (const routeKey of ["summarize", "linear", "agenda", "escalation", "spec", "digest", "image"]) {
    assert.deepEqual(parseCommand(`${routeKey}: focus here`), {
      kind: "route",
      routeKey,
      route: ROUTES[routeKey],
      text: "focus here",
    });
  }
});

test("parseCommand preserves existing fallback text for empty explicit route instructions", () => {
  assert.deepEqual(parseCommand("summarize:"), {
    kind: "route",
    routeKey: "summarize",
    route: ROUTES.summarize,
    text: "(No extra instructions after summarize:; use the Slack thread context.)",
  });
});

test("parseCommand treats unknown prefixes and ordinary text as plain ambient text", () => {
  assert.deepEqual(parseCommand("shipit: please"), { kind: "plain", text: "shipit: please" });
  assert.deepEqual(parseCommand("please summarize this when you can"), { kind: "plain", text: "please summarize this when you can" });
});

test("parseThreadSpecIntent detects natural language spec and PRD requests", () => {
  assert.deepEqual(parseThreadSpecIntent("draft spec"), {
    kind: "route",
    routeKey: "spec",
    route: ROUTES.spec,
    text: "Turn this Slack thread into a concise PRD/spec draft.",
    naturalIntent: "thread_spec",
    requiresThread: true,
  });

  assert.equal(parseThreadSpecIntent("write PRD for onboarding risk")?.text, "for onboarding risk");
  assert.equal(parseThreadSpecIntent("convert this into a requirements document: focus on mobile")?.text, "focus on mobile");
});

test("parseLinearCreateIntent detects natural language Linear issue requests", () => {
  assert.deepEqual(parseLinearCreateIntent("create Linear issue"), {
    kind: "route",
    routeKey: "linear",
    route: ROUTES.linear,
    text: "Create a Linear issue from this Slack thread.",
    naturalIntent: "linear_issue_create",
    requiresThread: true,
  });

  assert.equal(parseLinearCreateIntent("file ticket: dashboard is slow")?.text, "dashboard is slow");
  assert.equal(parseLinearCreateIntent("issue this for missing exports")?.text, "for missing exports");
});

test("parseSlackRequestCommand only promotes natural language intents for app mentions", () => {
  assert.deepEqual(parseSlackRequestCommand("draft spec", { mode: "message" }), { kind: "plain", text: "draft spec" });
  assert.equal(parseSlackRequestCommand("draft spec", { mode: "app_mention" }).routeKey, "spec");
  assert.equal(parseSlackRequestCommand("write PRD", { mode: "app_mention" }).routeKey, "spec");
  assert.equal(parseSlackRequestCommand("create Linear issue", { mode: "app_mention" }).routeKey, "linear");
});

test("parseSlackRequestCommand keeps explicit prefix commands available outside app mentions", () => {
  assert.equal(parseSlackRequestCommand("summarize: decisions", { mode: "message" }).routeKey, "summarize");
  assert.equal(parseSlackRequestCommand("image: draw a diagram", {}).routeKey, "image");
});
