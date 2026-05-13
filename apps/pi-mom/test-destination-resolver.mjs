// Tests for apps/pi-mom/lib/destination-resolver.mjs and
// apps/pi-mom/lib/slack-permalink.mjs.
//
// Style mirrors test-linear-graphql.mjs: dependency-inject the linearFetch
// stub + a silent logger and drive the resolver directly. Each case is
// hermetic — no shared state. We assert both happy and defensive paths.

import assert from "node:assert/strict";
import { parseSlackPermalink } from "./lib/slack-permalink.mjs";
import {
  createDestinationResolver,
  resolveLinearAttachmentThread,
  resolveStaticMapping,
  resolveFallback,
} from "./lib/destination-resolver.mjs";

function silentLogger() {
  const calls = { warn: [], info: [], error: [] };
  return {
    calls,
    warn: (...args) => calls.warn.push(args),
    info: (...args) => calls.info.push(args),
    error: (...args) => calls.error.push(args),
  };
}

function makeLinearFetchStub(responses) {
  // `responses` is an array of either {data,errors} objects or functions of
  // (query, variables) → {data,errors}. Each call consumes the next entry.
  const calls = [];
  let i = 0;
  const fn = async (query, variables) => {
    calls.push({ query, variables });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof r === "function") return r(query, variables);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// parseSlackPermalink
// ---------------------------------------------------------------------------

// Case 1: top-level message → message_ts === thread_ts.
{
  const url = "https://covent.slack.com/archives/C012ABC3DEF/p1715620000123456";
  const parsed = parseSlackPermalink(url);
  assert.ok(parsed, "top-level permalink parses");
  assert.equal(parsed.channel, "C012ABC3DEF");
  assert.equal(parsed.message_ts, "1715620000.123456");
  assert.equal(parsed.thread_ts, parsed.message_ts, "top-level: thread_ts === message_ts");
}

// Case 2: threaded reply with thread_ts query param → thread_ts !== message_ts.
{
  const url =
    "https://covent.slack.com/archives/C012ABC3DEF/p1715620500987654?thread_ts=1715620000.123456&cid=C012ABC3DEF";
  const parsed = parseSlackPermalink(url);
  assert.ok(parsed, "threaded reply parses");
  assert.equal(parsed.channel, "C012ABC3DEF");
  assert.equal(parsed.message_ts, "1715620500.987654");
  assert.equal(parsed.thread_ts, "1715620000.123456", "thread_ts taken from query param");
  assert.notEqual(parsed.thread_ts, parsed.message_ts);
}

// Case 3: DM channel (D-prefix) parses.
{
  const url = "https://covent.slack.com/archives/D01ABCDE234/p1715620000123456";
  const parsed = parseSlackPermalink(url);
  assert.ok(parsed, "DM permalink parses");
  assert.equal(parsed.channel, "D01ABCDE234");
  assert.equal(parsed.message_ts, "1715620000.123456");
}

// Case 4: non-Slack URL → null.
{
  assert.equal(parseSlackPermalink("https://example.com/archives/C123/p1715620000123456"), null);
  assert.equal(parseSlackPermalink("https://linear.app/issue/FE-1"), null);
}

// Case 5: missing `p<digits>` segment → null.
{
  assert.equal(parseSlackPermalink("https://covent.slack.com/archives/C012ABC3DEF/"), null);
  assert.equal(parseSlackPermalink("https://covent.slack.com/archives/C012ABC3DEF/x1715620000123456"), null);
  assert.equal(parseSlackPermalink("https://covent.slack.com/team/U123"), null);
}

// Case 6: malformed timestamp → null.
{
  // No digits after `p`.
  assert.equal(parseSlackPermalink("https://covent.slack.com/archives/C012ABC3DEF/p"), null);
  // Only 6 digits → after splitting last 6 the seconds portion is empty.
  assert.equal(parseSlackPermalink("https://covent.slack.com/archives/C012ABC3DEF/p123456"), null);
  // Letters in the digits run.
  assert.equal(parseSlackPermalink("https://covent.slack.com/archives/C012ABC3DEF/p17156abcdef"), null);
  // Empty string.
  assert.equal(parseSlackPermalink(""), null);
  // Non-string.
  assert.equal(parseSlackPermalink(undefined), null);
  assert.equal(parseSlackPermalink(null), null);
  assert.equal(parseSlackPermalink(42), null);
  // Garbage URL.
  assert.equal(parseSlackPermalink("not a url"), null);
}

// ---------------------------------------------------------------------------
// resolveLinearAttachmentThread
// ---------------------------------------------------------------------------

const SLACK_PERMALINK =
  "https://covent.slack.com/archives/C012ABC3DEF/p1715620500987654?thread_ts=1715620000.123456&cid=C012ABC3DEF";

// Case 7: Comment event, issue has Slack attachment → returns parsed destination.
{
  const event = {
    type: "Comment",
    data: { id: "c1", issueId: "issue-uuid-abc", body: "hello" },
  };
  const { fn: linearFetch, calls } = makeLinearFetchStub([
    {
      data: {
        issue: {
          id: "issue-uuid-abc",
          identifier: "FE-1",
          attachments: {
            nodes: [
              { id: "att1", url: SLACK_PERMALINK, title: "Slack thread" },
            ],
          },
        },
      },
    },
  ]);
  const logger = silentLogger();
  const dest = await resolveLinearAttachmentThread(event, {}, { linearFetch, logger });
  assert.deepEqual(dest, { channel: "C012ABC3DEF", thread_ts: "1715620000.123456" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].variables.id, "issue-uuid-abc", "uses event.data.issueId for Comment events");
  assert.match(calls[0].query, /attachments/);
}

// Case 8: Issue event, uses event.data.id directly.
{
  const event = { type: "Issue", data: { id: "issue-uuid-xyz", title: "T" } };
  const { fn: linearFetch, calls } = makeLinearFetchStub([
    {
      data: {
        issue: {
          id: "issue-uuid-xyz",
          identifier: "FE-2",
          attachments: { nodes: [{ id: "a", url: SLACK_PERMALINK, title: "x" }] },
        },
      },
    },
  ]);
  const dest = await resolveLinearAttachmentThread(event, {}, { linearFetch, logger: silentLogger() });
  assert.deepEqual(dest, { channel: "C012ABC3DEF", thread_ts: "1715620000.123456" });
  assert.equal(calls[0].variables.id, "issue-uuid-xyz", "uses event.data.id for Issue events");
}

// Case 9: issue has no attachments → null.
{
  const event = { type: "Issue", data: { id: "issue-uuid" } };
  const { fn: linearFetch } = makeLinearFetchStub([
    { data: { issue: { id: "issue-uuid", identifier: "FE-3", attachments: { nodes: [] } } } },
  ]);
  const dest = await resolveLinearAttachmentThread(event, {}, { linearFetch, logger: silentLogger() });
  assert.equal(dest, null);
}

// Case 10: issue has only non-Slack attachments → null.
{
  const event = { type: "Issue", data: { id: "issue-uuid" } };
  const { fn: linearFetch } = makeLinearFetchStub([
    {
      data: {
        issue: {
          id: "issue-uuid",
          identifier: "FE-4",
          attachments: {
            nodes: [
              { id: "a1", url: "https://github.com/foo/bar/pull/1", title: "PR" },
              { id: "a2", url: "https://docs.google.com/document/d/abc", title: "Doc" },
            ],
          },
        },
      },
    },
  ]);
  const dest = await resolveLinearAttachmentThread(event, {}, { linearFetch, logger: silentLogger() });
  assert.equal(dest, null);
}

// Case 11: linearFetch returns errors[] → null, logs warning.
{
  const event = { type: "Comment", data: { issueId: "issue-uuid" } };
  const { fn: linearFetch } = makeLinearFetchStub([
    { errors: [{ message: "Not authorized", extensions: { code: "FORBIDDEN" } }] },
  ]);
  const logger = silentLogger();
  const dest = await resolveLinearAttachmentThread(event, {}, { linearFetch, logger });
  assert.equal(dest, null);
  assert.equal(logger.calls.warn.length, 1);
  assert.match(logger.calls.warn[0][0], /errors/i);
}

// Case 12: linearFetch throws → null, no rethrow.
{
  const event = { type: "Comment", data: { issueId: "issue-uuid" } };
  const linearFetch = async () => {
    throw new Error("network down");
  };
  const logger = silentLogger();
  const dest = await resolveLinearAttachmentThread(event, {}, { linearFetch, logger });
  assert.equal(dest, null);
  assert.equal(logger.calls.warn.length, 1);
  assert.match(logger.calls.warn[0][0], /threw|network/i);
}

// Sanity: missing issueId returns null without calling linearFetch.
{
  const event = { type: "Comment", data: { body: "no issue id" } };
  const { fn: linearFetch, calls } = makeLinearFetchStub([{ data: { issue: null } }]);
  const dest = await resolveLinearAttachmentThread(event, {}, { linearFetch, logger: silentLogger() });
  assert.equal(dest, null);
  assert.equal(calls.length, 0, "no fetch when no issue id");
}

// Sanity: missing linearFetch dependency returns null without throwing.
{
  const event = { type: "Comment", data: { issueId: "x" } };
  const dest = await resolveLinearAttachmentThread(event, {}, { linearFetch: undefined, logger: silentLogger() });
  assert.equal(dest, null);
}

// ---------------------------------------------------------------------------
// resolve() integration
// ---------------------------------------------------------------------------

// Case 13: strategy returns null, fallback_channel set → returns fallback.
{
  const event = { type: "Comment", data: { issueId: "issue-uuid" } };
  const route = {
    destination: {
      resolver: "linear_attachment_thread",
      fallback_channel: "C_FALLBACK",
    },
  };
  const { fn: linearFetch } = makeLinearFetchStub([
    { data: { issue: { id: "issue-uuid", identifier: "FE-9", attachments: { nodes: [] } } } },
  ]);
  const resolver = createDestinationResolver({ linearFetch, logger: silentLogger() });
  const dest = await resolver.resolve(event, route);
  assert.deepEqual(dest, { channel: "C_FALLBACK" });
  assert.equal(dest.thread_ts, undefined, "fallback never carries thread_ts");
}

// Case 14: strategy returns destination → returns it (fallback NOT used).
{
  const event = { type: "Comment", data: { issueId: "issue-uuid" } };
  const route = {
    destination: {
      resolver: "linear_attachment_thread",
      fallback_channel: "C_FALLBACK_NOT_USED",
    },
  };
  const { fn: linearFetch } = makeLinearFetchStub([
    {
      data: {
        issue: {
          id: "issue-uuid",
          identifier: "FE-10",
          attachments: { nodes: [{ id: "a", url: SLACK_PERMALINK, title: "x" }] },
        },
      },
    },
  ]);
  const resolver = createDestinationResolver({ linearFetch, logger: silentLogger() });
  const dest = await resolver.resolve(event, route);
  assert.deepEqual(dest, { channel: "C012ABC3DEF", thread_ts: "1715620000.123456" });
}

// Case 15: unknown strategy name → null with logged warning.
{
  const route = { destination: { resolver: "nonsense_strategy", fallback_channel: "C_X" } };
  const logger = silentLogger();
  const resolver = createDestinationResolver({ linearFetch: async () => ({}), logger });
  const dest = await resolver.resolve({ type: "Issue", data: { id: "x" } }, route);
  assert.equal(dest, null, "unknown strategy returns null even when fallback exists");
  assert.equal(logger.calls.warn.length, 1);
  assert.match(logger.calls.warn[0][0], /unknown resolver strategy/i);
  assert.match(logger.calls.warn[0][0], /nonsense_strategy/);
}

// Case 16: resolveStaticMapping returns null with a clear not-implemented marker.
{
  const route = { destination: { resolver: "static_mapping", static_map: { "owner/repo": "C123ABC" } } };
  const result = resolveStaticMapping({ data: { repo: { full_name: "owner/repo" } } }, route);
  assert.equal(result, null, "static mapping stub returns null for v1");

  // The source must carry an explicit TODO marker so future implementers see
  // the deferred scope inline.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./lib/destination-resolver.mjs", import.meta.url), "utf8"),
  );
  assert.match(src, /TODO\(post-v1\)/, "destination-resolver.mjs carries a TODO marker for static_mapping");
  assert.match(src, /Not implemented for v1/i);

  // Also verify the strategy is wired into resolve() so the route config is
  // accepted; it just produces fallback (or null if no fallback) for v1.
  const resolver = createDestinationResolver({ linearFetch: async () => ({}), logger: silentLogger() });
  const dest = await resolver.resolve({ data: {} }, {
    destination: { resolver: "static_mapping", fallback_channel: "C_FB" },
  });
  assert.deepEqual(dest, { channel: "C_FB" }, "static_mapping falls through to fallback when set");
}

// Sanity: resolveFallback returns null when fallback_channel missing.
{
  assert.equal(resolveFallback({}), null);
  assert.equal(resolveFallback({ destination: {} }), null);
  assert.equal(resolveFallback({ destination: { fallback_channel: "" } }), null);
  assert.deepEqual(resolveFallback({ destination: { fallback_channel: "C_OK" } }), { channel: "C_OK" });
}

// Sanity: resolve() with `fallback_channel` resolver name routes through the
// fallback strategy directly.
{
  const route = { destination: { resolver: "fallback_channel", fallback_channel: "C_DIRECT" } };
  const resolver = createDestinationResolver({ linearFetch: async () => ({}), logger: silentLogger() });
  const dest = await resolver.resolve({ data: {} }, route);
  assert.deepEqual(dest, { channel: "C_DIRECT" });
}

console.log("destination-resolver tests passed");
