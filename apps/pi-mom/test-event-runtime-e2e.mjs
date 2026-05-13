// End-to-end integration test for the event-driven Pi runtime (issue #48,
// phase 3). Drives the full pipeline:
//
//   receiver.handle(req, res)
//     → verifies signature + timestamp + dedup
//     → returns 200 within budget
//     → schedules dispatch on setImmediate
//         → matches event against registry (real registry.yaml)
//         → resolves destination via injected linearFetch stub
//         → builds synthetic prompt via real eventToTurnInput
//         → calls injected runPi stub with {tools, prompt}
//         → appends ledger entries
//
// Scope note: we mock `runPi` rather than the full Pi SDK. The agent's
// tool-call to slack_api would happen inside runPi; rather than spin up the
// real SDK plus an extension factory mock, the stub captures the prompt and
// the tools list, simulates "the agent chose to call slack_api.chat.postMessage",
// and resolves. This proves the dispatch contract (right tools, right prompt,
// right destination) without booting the real SDK. The full
// tool-call → Slack-post leg gets exercised in Phase 4 manual verification
// against the live Linear webhook + Slack workspace.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventReceiver } from "./event-receiver.mjs";
import { createDedupCache } from "./lib/event-dedup.mjs";
import { createDestinationResolver } from "./lib/destination-resolver.mjs";
import { createEventLedger } from "./lib/event-ledger.mjs";
import { createEventDispatch } from "./lib/event-dispatch.mjs";
import { loadRegistry } from "./lib/control-plane/registry-loader.mjs";

// --- tiny mock helper ------------------------------------------------------
function mockFn(impl) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    if (impl) return impl(...args);
    return undefined;
  };
  return { fn, calls };
}

// --- HTTP test scaffolding -------------------------------------------------
function makeFakeRes() {
  const res = {
    _status: undefined,
    _body: undefined,
    _ended: false,
    _endedAt: undefined,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      this._ended = true;
      this._endedAt = Date.now();
      return this;
    },
  };
  return res;
}

function makeFakeReq({ source, headers = {}, rawBody }) {
  return { params: { source }, headers, rawBody };
}

const SECRET = "linear-signing-secret-e2e";

function signLinear(rawBody, secret) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function makeCommentEvent({ webhookTimestamp = Date.now() } = {}) {
  // A realistic Linear Comment.create webhook payload — verbatim shape Linear
  // emits in May 2026. The receiver only validates `webhookTimestamp`; the
  // resolver only needs `data.issueId`; the route matcher needs `type` +
  // `action`. We include everything Linear sends so the synthetic-message
  // builder has realistic input.
  return {
    action: "create",
    type: "Comment",
    createdAt: new Date(webhookTimestamp).toISOString(),
    data: {
      id: "c-uuid-1",
      body: "Sounds good — proceeding with the migration.",
      issueId: "issue-uuid-1",
      user: { id: "u-1", name: "alice" },
      url: "https://linear.app/covent/issue/FE-101#comment-c-uuid-1",
    },
    url: "https://linear.app/covent/issue/FE-101#comment-c-uuid-1",
    organizationId: "org-1",
    webhookId: "wh-1",
    webhookTimestamp,
  };
}

async function flushAsync() {
  // The receiver schedules dispatch via setImmediate, and dispatch awaits a
  // resolver + a runPi. Drain enough macrotasks to settle the chain.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  }
}

// --- Test fixtures: registry + slack attachment --------------------------

// We use the real registry.yaml. The linear-comment-sync route there has
// `fallback_channel: TBD-CHANNEL-ID`; we want the linear_attachment_thread
// strategy to win, so the linearFetch stub returns a Slack permalink
// attachment and we assert the destination matches THAT, not the fallback.
const REAL_REGISTRY = loadRegistry();

const SLACK_PERMALINK =
  "https://covent.slack.com/archives/C012ABC3DEF/p1715620500987654?thread_ts=1715620000.123456&cid=C012ABC3DEF";
const EXPECTED_CHANNEL = "C012ABC3DEF";
const EXPECTED_THREAD_TS = "1715620000.123456";

// Build a linearFetch stub that returns one Slack attachment for issue lookup.
function makeLinearFetchStub() {
  const calls = [];
  const fn = async (query, variables) => {
    calls.push({ query, variables });
    // The destination resolver issues a single IssueAttachments query against
    // the parent issue. Return one attachment whose URL is a Slack permalink.
    return {
      data: {
        issue: {
          id: variables?.id,
          identifier: "FE-101",
          attachments: {
            nodes: [
              {
                id: "att-1",
                url: SLACK_PERMALINK,
                title: "Slack thread",
              },
            ],
          },
        },
      },
    };
  };
  return { fn, calls };
}

// --- runPi mock that captures the prompt and simulates a slack_api call ---
//
// The stub captures every runPi call so the test can assert against:
//   - prompt — must contain the right <event> block
//   - tools  — must equal route.tools from registry.yaml
// It also records a synthetic "agent decided to call slack_api with
// chat.postMessage" record for the destination, so the test can prove the
// post-side-effect intent without booting the real Pi SDK or the
// extensions/slack-api.ts tool.
function makeRunPiStub({ destination }) {
  const calls = [];
  const slackPostAttempts = [];
  const fn = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    // Simulate the agent picking slack_api with chat.postMessage into the
    // resolved destination. In production this happens inside the Pi SDK
    // via the registered slack_api extension; here we model it directly so
    // the dispatch contract can be asserted without the SDK loop.
    if (Array.isArray(opts.tools) && opts.tools.includes("slack_api") && destination) {
      slackPostAttempts.push({
        method: "chat.postMessage",
        args: {
          channel: destination.channel,
          thread_ts: destination.thread_ts,
          text: "[mock] Pi reply to Linear comment event",
        },
      });
    }
    return "mock agent reply";
  };
  return { fn, calls, slackPostAttempts };
}

// ---------------------------------------------------------------------------
// Test setup: temp ledger file
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "pi-event-runtime-e2e-"));
const ledgerPath = join(tmpDir, "event-runs.jsonl");

function readLedger() {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildEnv(overrides = {}) {
  const linearFetchStub = overrides.linearFetchStub || makeLinearFetchStub();
  const runPiStub = overrides.runPiStub || makeRunPiStub({
    destination: { channel: EXPECTED_CHANNEL, thread_ts: EXPECTED_THREAD_TS },
  });
  const ledger = createEventLedger({ path: ledgerPath });
  const destinationResolver = createDestinationResolver({
    linearFetch: linearFetchStub.fn,
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  });
  const { dispatch } = createEventDispatch({
    registry: REAL_REGISTRY,
    destinationResolver,
    runPi: runPiStub.fn,
    appendLedger: ledger.append,
  });
  const dedup = createDedupCache();
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch,
    appendLedger: ledger.append,
    dedup,
  });
  return { receiver, dispatch, linearFetchStub, runPiStub, ledger, dedup };
}

function buildSignedRequest({ delivery = "delivery-e2e-1", bodyOverrides = {} } = {}) {
  const body = { ...makeCommentEvent(), ...bodyOverrides };
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const headers = {
    "linear-signature": signLinear(rawBody, SECRET),
    "linear-delivery": delivery,
    "content-type": "application/json",
  };
  return { req: makeFakeReq({ source: "linear", headers, rawBody }), body, rawBody };
}

// ---------------------------------------------------------------------------
// Run the test
// ---------------------------------------------------------------------------

try {
  // --- First pass: end-to-end happy path --------------------------------
  {
    const { receiver, linearFetchStub, runPiStub, dedup } = buildEnv();
    const { req } = buildSignedRequest({ delivery: "happy-e2e-1" });
    const res = makeFakeRes();

    const t0 = Date.now();
    await receiver.handle(req, res);
    const responseMs = Date.now() - t0;

    // 1. Receiver returned 200 fast.
    assert.equal(res._status, 200, "receiver responds 200");
    assert.equal(res._body.ok, true);
    assert.equal(res._body.queued, true);
    assert.ok(responseMs <= 100, `responded in ${responseMs}ms (≤100ms budget)`);

    await flushAsync();

    // 2. Dispatch fired: runPi was called exactly once.
    assert.equal(runPiStub.calls.length, 1, "runPi invoked exactly once");

    // 3. Prompt contains the synthetic event block with right metadata.
    const { prompt, opts } = runPiStub.calls[0];
    assert.match(prompt, /<event\s/, "prompt opens with <event ...>");
    assert.match(prompt, /source="linear"/, "prompt advertises source=linear");
    assert.match(prompt, /type="Comment\.create"/, "prompt advertises event type");
    assert.match(prompt, /deliveryId="happy-e2e-1"/, "prompt carries deliveryId");
    assert.match(prompt, /<route name="linear-comment-sync"\/>/, "prompt names the route");
    assert.match(
      prompt,
      new RegExp(`channel="${EXPECTED_CHANNEL}"`),
      "prompt carries resolved channel",
    );
    assert.match(
      prompt,
      new RegExp(`thread_ts="${EXPECTED_THREAD_TS.replace(".", "\\.")}"`),
      "prompt carries resolved thread_ts",
    );
    // The route's systemPromptSuffix must be prepended so the model gets the
    // workflow instructions before the synthetic turn.
    assert.match(
      prompt,
      /Comment\.create event/i,
      "systemPromptSuffix prepended (per registry.yaml)",
    );

    // 4. Tools allowlist matches the route definition.
    assert.deepEqual(
      opts.tools,
      ["linear_graphql", "slack_api"],
      "route.tools forwarded to runPi",
    );

    // 5. The resolver actually queried Linear once for attachments.
    assert.equal(linearFetchStub.calls.length, 1, "destination resolver hit Linear once");
    assert.match(
      linearFetchStub.calls[0].query,
      /issue\(id:\s*\$id\)/,
      "issue attachments query issued",
    );
    assert.equal(linearFetchStub.calls[0].variables.id, "issue-uuid-1");

    // 6. The agent attempted a chat.postMessage into the resolved thread.
    //    (Mocked: in production the slack_api extension would perform the call.)
    assert.equal(runPiStub.slackPostAttempts.length, 1, "one slack post intent");
    assert.deepEqual(runPiStub.slackPostAttempts[0], {
      method: "chat.postMessage",
      args: {
        channel: EXPECTED_CHANNEL,
        thread_ts: EXPECTED_THREAD_TS,
        text: "[mock] Pi reply to Linear comment event",
      },
    });

    // 7. Ledger has the expected milestone progression. Use Set semantics
    //    against the keys we care about — the receiver also writes its own
    //    started/completed entries around the dispatch.
    const ledger = readLedger();
    const happyEntries = ledger.filter((e) => e.deliveryId === "happy-e2e-1");
    const statuses = happyEntries.map((e) => e.status);
    assert.ok(statuses.includes("started"), "receiver wrote started");
    assert.ok(statuses.includes("route-matched"), "dispatch wrote route-matched");
    assert.ok(statuses.includes("destination-resolved"), "dispatch wrote destination-resolved");
    assert.ok(statuses.includes("agent-started"), "dispatch wrote agent-started");
    assert.ok(statuses.includes("agent-completed"), "dispatch wrote agent-completed");
    assert.ok(statuses.includes("completed"), "receiver wrote completed");

    // The destination-resolved entry must contain the actual destination.
    const destResolved = happyEntries.find((e) => e.status === "destination-resolved");
    assert.equal(destResolved.destination.channel, EXPECTED_CHANNEL);
    assert.equal(destResolved.destination.thread_ts, EXPECTED_THREAD_TS);

    // Cache the dedup so the second pass can reuse it for the dup check.
    receiver._dedup; // touch — sanity
    // Keep handles for the next block.
    e2eEnv = { receiver, runPiStub, linearFetchStub, dedup };
  }

  // --- Second pass: same delivery ID → dedup short-circuit -------------
  {
    const beforeLedger = readLedger();
    const beforeRunPiCalls = e2eEnv.runPiStub.calls.length;
    const beforeFetchCalls = e2eEnv.linearFetchStub.calls.length;

    const { req } = buildSignedRequest({ delivery: "happy-e2e-1" });
    const res = makeFakeRes();
    await e2eEnv.receiver.handle(req, res);
    await flushAsync();

    // Receiver returns 200 with `dedup: true` and skips dispatch entirely.
    assert.equal(res._status, 200, "dedup pass still 200");
    assert.deepEqual(res._body, { ok: true, dedup: true }, "dedup body shape");

    // Dispatch did NOT fire again — no new runPi or Linear calls.
    assert.equal(e2eEnv.runPiStub.calls.length, beforeRunPiCalls, "runPi not invoked on dup");
    assert.equal(e2eEnv.linearFetchStub.calls.length, beforeFetchCalls, "linearFetch not invoked on dup");

    // Ledger has NO new entries for the duplicate (the receiver only writes
    // ledger entries AFTER the dedup gate passes).
    const afterLedger = readLedger();
    assert.equal(afterLedger.length, beforeLedger.length, "no new ledger entries on dup");
  }

  // --- Third pass: event type doesn't match any route ------------------
  //
  // Linear Issue.update isn't in registry.yaml's eventRoutes. The receiver
  // still 200s and dispatch still runs, but `matchEventRoute` returns null
  // and dispatch writes a `no-route-matched` ledger entry instead of
  // invoking runPi. This proves the route-match gate works.
  {
    const env = buildEnv();
    const body = {
      ...makeCommentEvent(),
      type: "Issue",
      action: "update",
      data: { id: "issue-uuid-2", identifier: "FE-200" },
    };
    const rawBody = Buffer.from(JSON.stringify(body), "utf8");
    const req = makeFakeReq({
      source: "linear",
      headers: {
        "linear-signature": signLinear(rawBody, SECRET),
        "linear-delivery": "no-match-1",
        "content-type": "application/json",
      },
      rawBody,
    });
    const res = makeFakeRes();
    await env.receiver.handle(req, res);
    await flushAsync();

    assert.equal(res._status, 200);
    assert.equal(env.runPiStub.calls.length, 0, "no runPi for unmatched event");
    assert.equal(env.linearFetchStub.calls.length, 0, "no destination resolve for unmatched event");

    const ledger = readLedger();
    const noMatchEntries = ledger.filter((e) => e.deliveryId === "no-match-1");
    const statuses = noMatchEntries.map((e) => e.status);
    assert.ok(statuses.includes("started"), "started entry written");
    const completed = noMatchEntries.find(
      (e) => e.status === "completed" && e.reason === "no-route-matched",
    );
    assert.ok(completed, "no-route-matched completed entry written");
  }
} finally {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

// File-scope holder for cross-block reuse. Declared at the bottom so the
// hoisting is explicit — block-scoped `let` inside the try block would not
// survive to the second test pass.
var e2eEnv;
// Re-export so the dance above isn't an unused-var warning under lint.
void e2eEnv;

console.log("event-runtime-e2e tests passed");
