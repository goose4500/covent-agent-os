// Tests for the event-receiver (phase 1 of the event-driven Pi runtime,
// issue #48). Three modules under test:
//
//   lib/event-dedup.mjs       — bounded FIFO cache with TTL expiry
//   lib/event-signature.mjs   — Linear HMAC verifier + replay-window check
//   event-receiver.mjs        — Express-compatible POST /webhook/:source
//
// All HMAC fixtures are computed inside this file using node:crypto so the
// tests are self-validating and don't drift if Linear changes a sample
// payload. The fake req/res mirrors what express.json({ verify }) hands the
// handler in production: a plain object with `params`, `headers`, and
// `rawBody` (a Buffer).

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createDedupCache } from "./lib/event-dedup.mjs";
import { verifyLinear, isFreshTimestamp } from "./lib/event-signature.mjs";
import { createEventReceiver } from "./event-receiver.mjs";

// --- Tiny test helpers -----------------------------------------------------

function makeFakeRes() {
  const res = {
    _status: undefined,
    _body: undefined,
    _ended: false,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      this._ended = true;
      return this;
    },
  };
  return res;
}

function makeFakeReq({ source, headers = {}, rawBody }) {
  return {
    params: { source },
    headers,
    rawBody,
  };
}

function signLinear(rawBody, secret) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function makeLinearBody({ webhookTimestamp = Date.now() } = {}) {
  return {
    action: "create",
    type: "Comment",
    data: { id: "c_1", body: "hi" },
    url: "https://linear.app/x/issue/FE-1#comment-c_1",
    createdAt: new Date().toISOString(),
    webhookId: "wh_1",
    webhookTimestamp,
    organizationId: "org_1",
  };
}

// Wait for setImmediate-scheduled work to drain. Two ticks because the
// receiver schedules dispatch with setImmediate, and dispatch's await chain
// settles on the microtask queue inside that callback.
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // One more microtask drain for good measure.
  await Promise.resolve();
}

// --- event-dedup ----------------------------------------------------------

// Case 1a: seen/record cycle.
{
  const cache = createDedupCache();
  assert.equal(cache.seen("a"), false, "fresh key not seen");
  cache.record("a");
  assert.equal(cache.seen("a"), true, "recorded key is seen");
  assert.equal(cache.size(), 1);
}

// Case 1b: FIFO eviction at maxEntries.
{
  const cache = createDedupCache({ maxEntries: 3 });
  cache.record("a");
  cache.record("b");
  cache.record("c");
  cache.record("d"); // evicts "a"
  assert.equal(cache.seen("a"), false, "oldest evicted");
  assert.equal(cache.seen("b"), true);
  assert.equal(cache.seen("c"), true);
  assert.equal(cache.seen("d"), true);
  assert.equal(cache.size(), 3);
}

// Case 1c: TTL expiry on seen() and via _prune().
{
  let fakeNow = 1_000_000;
  const cache = createDedupCache({ ttlMs: 100, now: () => fakeNow });
  cache.record("x");
  assert.equal(cache.seen("x"), true, "fresh");
  fakeNow += 50;
  assert.equal(cache.seen("x"), true, "within TTL");
  fakeNow += 200;
  assert.equal(cache.seen("x"), false, "expired via seen()");

  cache.record("y");
  fakeNow += 5; // still fresh
  cache.record("z");
  fakeNow += 200; // both stale now
  cache._prune();
  assert.equal(cache.size(), 0, "_prune sweeps stale entries");
}

// --- event-signature ------------------------------------------------------

// Case 2: verifyLinear happy + sad paths.
{
  const secret = "test-secret-XYZ";
  const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
  const goodSig = signLinear(body, secret);

  assert.equal(verifyLinear(body, goodSig, secret), true, "good sig accepted");
  assert.equal(verifyLinear(body, goodSig.toUpperCase(), secret), true, "case-insensitive hex");

  // Wrong secret.
  assert.equal(verifyLinear(body, goodSig, "other-secret"), false, "wrong secret rejected");
  // Tampered body.
  assert.equal(
    verifyLinear(Buffer.from("tampered"), goodSig, secret),
    false,
    "tampered body rejected",
  );
  // Missing / malformed signatures.
  assert.equal(verifyLinear(body, undefined, secret), false, "missing sig rejected");
  assert.equal(verifyLinear(body, "", secret), false, "empty sig rejected");
  assert.equal(verifyLinear(body, "deadbeef", secret), false, "too-short sig rejected");
  assert.equal(
    verifyLinear(body, goodSig + "ff", secret),
    false,
    "too-long sig rejected",
  );
  assert.equal(verifyLinear(body, "z".repeat(64), secret), false, "non-hex sig rejected");
  // Missing secret.
  assert.equal(verifyLinear(body, goodSig, ""), false, "empty secret rejected");
  assert.equal(verifyLinear(body, goodSig, undefined), false, "missing secret rejected");
  // String body should also work (rawBody may arrive either way).
  const strBody = JSON.stringify({ hello: "world" });
  const strSig = signLinear(Buffer.from(strBody, "utf8"), secret);
  assert.equal(verifyLinear(strBody, strSig, secret), true, "string body accepted");
}

// Case 3: isFreshTimestamp boundaries.
{
  const now = () => 1_000_000;
  assert.equal(isFreshTimestamp(1_000_000, { now }), true, "exact match");
  assert.equal(isFreshTimestamp(1_000_000 - 60_000, { now }), true, "lower boundary");
  assert.equal(isFreshTimestamp(1_000_000 + 60_000, { now }), true, "upper boundary");
  assert.equal(isFreshTimestamp(1_000_000 - 60_001, { now }), false, "just past lower bound");
  assert.equal(isFreshTimestamp(1_000_000 + 60_001, { now }), false, "just past upper bound");
  assert.equal(isFreshTimestamp(undefined, { now }), false, "missing");
  assert.equal(isFreshTimestamp("1000", { now }), false, "non-number");
  assert.equal(isFreshTimestamp(NaN, { now }), false, "NaN");
  // Custom tolerance.
  assert.equal(
    isFreshTimestamp(999_000, { now, toleranceMs: 500 }),
    false,
    "outside custom tolerance",
  );
  assert.equal(
    isFreshTimestamp(999_700, { now, toleranceMs: 500 }),
    true,
    "inside custom tolerance",
  );
}

// --- event-receiver -------------------------------------------------------

const SECRET = "linear-signing-secret";

function buildSignedRequest({
  source = "linear",
  bodyOverrides = {},
  delivery = "delivery-1",
  badSig = false,
  signWith = SECRET,
  omitDelivery = false,
} = {}) {
  const body = { ...makeLinearBody(), ...bodyOverrides };
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const sig = badSig ? "0".repeat(64) : signLinear(rawBody, signWith);
  const headers = { "linear-signature": sig };
  if (!omitDelivery) headers["linear-delivery"] = delivery;
  return { req: makeFakeReq({ source, headers, rawBody }), body, rawBody };
}

// Case 4: unknown source → 404, no dispatch.
{
  const dispatch = mockFn();
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch: dispatch.fn,
  });
  const { req } = buildSignedRequest({ source: "stripe" });
  const res = makeFakeRes();
  await receiver.handle(req, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.ok, false);
  assert.equal(dispatch.calls.length, 0, "no dispatch on unknown source");
}

// Case 4b: known adapter but no configured secret → 404 (treat as not enabled).
{
  const dispatch = mockFn();
  const receiver = createEventReceiver({
    secrets: {}, // linear adapter exists, but no secret configured
    dispatch: dispatch.fn,
  });
  const { req } = buildSignedRequest();
  const res = makeFakeRes();
  await receiver.handle(req, res);
  assert.equal(res._status, 404);
  assert.equal(dispatch.calls.length, 0);
}

// Case 5: missing rawBody → 400 with helpful hint.
{
  const dispatch = mockFn();
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch: dispatch.fn,
  });
  const req = makeFakeReq({
    source: "linear",
    headers: { "linear-signature": "x", "linear-delivery": "d1" },
    rawBody: undefined,
  });
  const res = makeFakeRes();
  await receiver.handle(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /raw body required/);
  assert.equal(dispatch.calls.length, 0);
}

// Case 6: invalid signature → 401, no dispatch.
{
  const dispatch = mockFn();
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch: dispatch.fn,
  });
  const { req } = buildSignedRequest({ badSig: true });
  const res = makeFakeRes();
  await receiver.handle(req, res);
  assert.equal(res._status, 401);
  assert.match(res._body.error, /signature/);
  assert.equal(dispatch.calls.length, 0);
}

// Case 6b: signature was computed against a different secret → 401.
{
  const dispatch = mockFn();
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch: dispatch.fn,
  });
  const { req } = buildSignedRequest({ signWith: "other-secret" });
  const res = makeFakeRes();
  await receiver.handle(req, res);
  assert.equal(res._status, 401);
  assert.equal(dispatch.calls.length, 0);
}

// Case 7: stale timestamp → 401, no dispatch.
{
  const dispatch = mockFn();
  const fakeNow = Date.now();
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch: dispatch.fn,
    now: () => fakeNow,
  });
  const { req } = buildSignedRequest({
    bodyOverrides: { webhookTimestamp: fakeNow - 5 * 60 * 1000 }, // 5min old
  });
  const res = makeFakeRes();
  await receiver.handle(req, res);
  assert.equal(res._status, 401);
  assert.match(res._body.error, /stale/);
  assert.equal(dispatch.calls.length, 0);
}

// Case 8: happy path → 200 queued, dispatch called once, ledger written.
{
  const dispatch = mockFn(async () => {});
  const ledger = mockFn();
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch: dispatch.fn,
    appendLedger: ledger.fn,
  });
  const { req, body, rawBody } = buildSignedRequest({ delivery: "happy-1" });
  const res = makeFakeRes();
  await receiver.handle(req, res);
  assert.equal(res._status, 200);
  assert.deepEqual(res._body, { ok: true, queued: true });
  await flushAsync();
  assert.equal(dispatch.calls.length, 1, "dispatch called exactly once");
  const arg = dispatch.calls[0][0];
  assert.equal(arg.source, "linear");
  assert.equal(arg.deliveryId, "happy-1");
  assert.equal(arg.event.type, "Comment");
  assert.deepEqual(arg.event, body);
  assert.equal(arg.rawBody, rawBody, "raw body forwarded");
  assert.equal(arg.headers["linear-delivery"], "happy-1");

  // Ledger: one started, one completed entry.
  const statuses = ledger.calls.map((c) => c[0].status);
  assert.deepEqual(statuses, ["started", "completed"], "ledger sequence");
  assert.equal(ledger.calls[0][0].deliveryId, "happy-1");
  assert.equal(ledger.calls[1][0].deliveryId, "happy-1");
  assert.equal(typeof ledger.calls[0][0].startedAt, "number");
  assert.equal(typeof ledger.calls[1][0].completedAt, "number");
}

// Case 9: duplicate delivery → 200 dedup, dispatch NOT called.
{
  const dispatch = mockFn(async () => {});
  const ledger = mockFn();
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch: dispatch.fn,
    appendLedger: ledger.fn,
  });
  // First request — should queue.
  const first = buildSignedRequest({ delivery: "dup-1" });
  const res1 = makeFakeRes();
  await receiver.handle(first.req, res1);
  await flushAsync();
  assert.equal(res1._body.queued, true, "first delivery queued");
  assert.equal(dispatch.calls.length, 1);

  // Second request with same delivery id but a freshly signed body (fully
  // valid otherwise) — should hit the dedup gate.
  const second = buildSignedRequest({ delivery: "dup-1" });
  const res2 = makeFakeRes();
  await receiver.handle(second.req, res2);
  await flushAsync();
  assert.equal(res2._status, 200);
  assert.deepEqual(res2._body, { ok: true, dedup: true });
  assert.equal(dispatch.calls.length, 1, "no extra dispatch on dup");
}

// Case 10: dispatch throws → still 200, ledger has status:"error".
{
  const dispatch = mockFn(async () => {
    throw new Error("downstream blew up");
  });
  const ledger = mockFn();
  const logger = { error: mockFn().fn };
  const receiver = createEventReceiver({
    secrets: { linear: SECRET },
    dispatch: dispatch.fn,
    appendLedger: ledger.fn,
    logger,
  });
  const { req } = buildSignedRequest({ delivery: "err-1" });
  const res = makeFakeRes();
  await receiver.handle(req, res);
  // Response was already sent before dispatch fired.
  assert.equal(res._status, 200);
  assert.equal(res._body.queued, true);
  await flushAsync();
  assert.equal(dispatch.calls.length, 1);
  // Ledger should be [started, error] — NOT [started, completed].
  const statuses = ledger.calls.map((c) => c[0].status);
  assert.deepEqual(statuses, ["started", "error"], "ledger error path");
  assert.match(ledger.calls[1][0].error, /downstream blew up/);
}

// --- tiny mock helper -----------------------------------------------------
// Declared after the tests via hoisting? No — function declarations hoist,
// so this is fine sitting at the bottom and being referenced above.
function mockFn(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    if (impl) return impl(...args);
    return undefined;
  };
  return { fn, calls };
}

console.log("event-receiver tests passed");
