// Tests for apps/pi-mom/lib/synthetic-message.mjs.
//
// Style mirrors test-destination-resolver.mjs: each case sits in its own
// block scope, no shared state, asserts read top-down. The builder is pure
// — no I/O — so the harness is just `import + assert`.

import assert from "node:assert/strict";

import {
  eventToTurnInput,
  formatEventBlock,
} from "./lib/synthetic-message.mjs";

// Helper: a frozen `now` keeps `meta.triggeredAt` deterministic so equality
// checks against the full returned object are stable.
const FIXED_NOW = "2026-05-13T10:42:00.000Z";
const now = () => FIXED_NOW;

const SLACK_CHANNEL = "C012ABC3DEF";
const SLACK_THREAD = "1715620000.123456";

function makeCommentEvent(overrides = {}) {
  return {
    action: "create",
    type: "Comment",
    data: {
      id: "comment-uuid-1",
      issueId: "issue-uuid-abc",
      body: "Hello from a Linear comment",
      user: { id: "u_1", name: "alice" },
    },
    url: "https://linear.app/x/issue/FE-1#comment-comment-uuid-1",
    createdAt: "2026-05-13T10:41:59.000Z",
    webhookId: "wh_1",
    webhookTimestamp: 1715620000123,
    organizationId: "org_1",
    ...overrides,
  };
}

function makeIssueEvent(overrides = {}) {
  return {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-uuid-xyz",
      identifier: "FE-42",
      title: "Plumb event runtime",
      state: { id: "s_1", name: "In Progress" },
    },
    url: "https://linear.app/x/issue/FE-42",
    createdAt: "2026-05-13T10:41:59.000Z",
    webhookId: "wh_2",
    webhookTimestamp: 1715620000123,
    organizationId: "org_1",
    ...overrides,
  };
}

const LINEAR_COMMENT_ROUTE = {
  name: "linear-comment-sync",
  trigger: { source: "linear", when: ["Comment.create"], idempotency: "webhookDelivery" },
  destination: { resolver: "linear_attachment_thread", fallback_channel: "C_FALLBACK" },
  tools: ["linear_graphql", "slack_api"],
};

const LINEAR_ISSUE_ROUTE = {
  name: "linear-issue-update",
  trigger: { source: "linear", when: ["Issue.update"] },
  destination: { resolver: "linear_attachment_thread", fallback_channel: "C_FALLBACK" },
  tools: ["linear_graphql", "slack_api"],
};

// ---------------------------------------------------------------------------
// Case 1: Linear Comment.create with full destination
// ---------------------------------------------------------------------------
{
  const event = makeCommentEvent();
  const result = eventToTurnInput({
    event,
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD },
    deliveryId: "delivery-abc-123",
    now,
  });

  // <event> opening tag carries source, type, deliveryId.
  assert.match(result.prompt, /<event source="linear" type="Comment\.create" deliveryId="delivery-abc-123">/);
  assert.match(result.prompt, /<route name="linear-comment-sync"\/>/);
  assert.match(
    result.prompt,
    new RegExp(`<destination channel="${SLACK_CHANNEL}" thread_ts="${SLACK_THREAD}"\\/>`),
  );

  // Payload is JSON-pretty-printed and embedded between <payload>...</payload>.
  assert.match(result.prompt, /<payload>[\s\S]+"id": "comment-uuid-1"[\s\S]+<\/payload>/);

  // Closing tag + instruction tail are present.
  assert.match(result.prompt, /<\/event>/);
  assert.match(result.prompt, /You woke up because of the event above\./);
  assert.match(result.prompt, /Do not invent details/);

  // Destination is passed through verbatim.
  assert.deepEqual(result.destination, { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD });
}

// ---------------------------------------------------------------------------
// Case 2: Issue.update with thread_ts present → thread_ts attr appears
// ---------------------------------------------------------------------------
{
  const event = makeIssueEvent();
  const result = eventToTurnInput({
    event,
    route: LINEAR_ISSUE_ROUTE,
    destination: { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD },
    deliveryId: "delivery-issue-1",
    now,
  });

  assert.match(result.prompt, /type="Issue\.update"/);
  assert.match(result.prompt, /thread_ts="1715620000\.123456"/);
  assert.match(result.prompt, /"identifier": "FE-42"/);
  assert.equal(result.meta.eventType, "Issue.update");
}

// ---------------------------------------------------------------------------
// Case 3: Destination without thread_ts → channel attr only, NO thread_ts
// ---------------------------------------------------------------------------
{
  const event = makeCommentEvent();
  const result = eventToTurnInput({
    event,
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: "C_FALLBACK" },
    deliveryId: "delivery-fb-1",
    now,
  });

  // channel attr present...
  assert.match(result.prompt, /<destination channel="C_FALLBACK"\/>/);
  // ...and explicitly no thread_ts attribute anywhere.
  assert.equal(
    /thread_ts="/.test(result.prompt),
    false,
    "fallback destination must not emit a thread_ts attribute",
  );

  assert.deepEqual(result.destination, { channel: "C_FALLBACK" });
}

// ---------------------------------------------------------------------------
// Case 4: Large payload → gets truncated, <truncated bytes="..."/> marker
// ---------------------------------------------------------------------------
{
  // Build a payload deterministically larger than 4KB: a long body string is
  // the simplest fixture and matches a realistic webhook (Linear comments
  // can carry pasted logs / stack traces in `data.body`).
  const big = "x".repeat(6000); // 6000 bytes, well over the 4KB cap
  const event = makeCommentEvent({
    data: {
      id: "c-big",
      issueId: "issue-big",
      body: big,
      user: { id: "u_1", name: "alice" },
    },
  });

  const result = eventToTurnInput({
    event,
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD },
    deliveryId: "delivery-big-1",
    now,
  });

  // The marker exists with a positive byte count.
  const match = result.prompt.match(/<truncated bytes="(\d+)"\/>/);
  assert.ok(match, "truncated marker present");
  const droppedBytes = Number(match[1]);
  assert.ok(droppedBytes > 0, `truncated bytes is positive (got ${droppedBytes})`);

  // The payload between <payload> and </payload> is at most ~4KB.
  const payloadMatch = result.prompt.match(/<payload>\n([\s\S]*?)\n<\/payload>/);
  assert.ok(payloadMatch, "payload block present");
  const payloadBytes = Buffer.byteLength(payloadMatch[1], "utf8");
  assert.ok(
    payloadBytes <= 4096,
    `payload block within budget (got ${payloadBytes} bytes)`,
  );

  // Even though truncated, the model can still see the start of the data.
  assert.match(payloadMatch[1], /"id": "c-big"/);
}

// ---------------------------------------------------------------------------
// Case 5: Missing event.type → eventType "unknown", payload still embedded
// ---------------------------------------------------------------------------
{
  const event = { data: { id: "weird", anything: "goes" } }; // no type, no action
  const result = eventToTurnInput({
    event,
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: "C_FALLBACK" },
    deliveryId: "delivery-typeless",
    now,
  });

  assert.match(result.prompt, /type="unknown"/);
  // Raw payload still embedded so the model can salvage what it can.
  assert.match(result.prompt, /"id": "weird"/);
  assert.match(result.prompt, /"anything": "goes"/);
  assert.equal(result.meta.eventType, "unknown");
}

// Sanity 5b: missing event entirely (defensive — receiver guarantees an
// object but the builder should not throw if upstream regresses).
{
  const result = eventToTurnInput({
    event: undefined,
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: "C_FALLBACK" },
    deliveryId: "delivery-no-event",
    now,
  });
  assert.match(result.prompt, /type="unknown"/);
  assert.equal(result.meta.eventType, "unknown");
}

// ---------------------------------------------------------------------------
// Case 6: meta carries source, deliveryId, routeName, eventType, triggeredAt
// ---------------------------------------------------------------------------
{
  const event = makeCommentEvent();
  const result = eventToTurnInput({
    event,
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD },
    deliveryId: "delivery-meta-1",
    now,
  });

  assert.deepEqual(result.meta, {
    source: "linear",
    eventType: "Comment.create",
    triggeredAt: FIXED_NOW,
    deliveryId: "delivery-meta-1",
    routeName: "linear-comment-sync",
  });
}

// Sanity 6b: when source / route / deliveryId are missing, meta degrades
// rather than throwing or carrying undefined.
{
  const event = makeIssueEvent();
  const result = eventToTurnInput({
    event,
    route: undefined,
    destination: null,
    deliveryId: undefined,
    now,
  });
  assert.equal(result.meta.source, "unknown");
  assert.equal(result.meta.eventType, "Issue.update");
  assert.equal(result.meta.triggeredAt, FIXED_NOW);
  assert.equal(result.meta.deliveryId, undefined, "deliveryId omitted when not provided");
  assert.equal(result.meta.routeName, undefined, "routeName omitted when no route");
  assert.equal(result.destination, null);
  // The block should still render with destination omitted.
  assert.equal(/<destination /.test(result.prompt), false, "no <destination/> when null");
}

// ---------------------------------------------------------------------------
// Case 7: Builder is pure — same inputs produce same outputs
// ---------------------------------------------------------------------------
{
  const event = makeCommentEvent();
  const inputs = {
    event,
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD },
    deliveryId: "delivery-pure-1",
    now,
  };
  const a = eventToTurnInput(inputs);
  const b = eventToTurnInput(inputs);
  assert.equal(a.prompt, b.prompt);
  assert.deepEqual(a.meta, b.meta);
  assert.deepEqual(a.destination, b.destination);
}

// Sanity 7b: when `now` is not injected, the default uses Date — exercise
// that path once so the default doesn't bitrot, but don't assert on the value.
{
  const result = eventToTurnInput({
    event: makeCommentEvent(),
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD },
    deliveryId: "delivery-default-now",
  });
  assert.match(
    result.meta.triggeredAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    "default now() produces an ISO-shaped timestamp",
  );
}

// ---------------------------------------------------------------------------
// formatEventBlock — direct exposure (used by tests + future integrators
// that want to embed the block in a different surrounding turn).
// ---------------------------------------------------------------------------

// 8a: helper produces just the <event>...</event> block, no instruction tail.
{
  const block = formatEventBlock(makeCommentEvent(), {
    source: "linear",
    route: LINEAR_COMMENT_ROUTE,
    destination: { channel: SLACK_CHANNEL, thread_ts: SLACK_THREAD },
    deliveryId: "delivery-block-1",
    eventType: "Comment.create",
  });
  assert.match(block, /^<event /);
  assert.match(block, /<\/event>$/);
  assert.equal(/You woke up/.test(block), false, "helper has no instruction tail");
}

// 8b: XML metacharacters in attribute values are escaped (deliveryId is the
// most likely sneak path; assert one common metachar each).
{
  const block = formatEventBlock(makeCommentEvent(), {
    source: "linear",
    route: { name: 'route<weird&"name>' },
    destination: { channel: 'C<bad&"ch>' },
    deliveryId: 'd"e&l<id>',
    eventType: "Comment.create",
  });
  assert.equal(/route<weird/.test(block), false, "raw < not present in attr");
  assert.match(block, /&lt;/);
  assert.match(block, /&amp;/);
  assert.match(block, /&quot;/);
}

console.log("synthetic-message tests passed");
