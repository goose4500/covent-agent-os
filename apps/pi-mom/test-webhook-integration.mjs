// Integration tests for pi-mom's Linear webhook receiver.
//
// Scope (Wave 4 Q-INT):
//   Exercises the pi-mom × @covent/linear-client boundary end-to-end at the
//   HTTP layer — raw bytes in, JSON response out — without touching Slack or
//   the real Linear API. Unit-level coverage of `verifyWebhook` already lives
//   in packages/linear-client/tests/webhooks.test.ts (W-A); this file proves
//   the receiver wiring around it.
//
// Boot strategy (charter option c):
//   `apps/pi-mom/index.mjs` does not export its `createLinearWebhookServer`
//   helper, and the file's top-level (a) requires SLACK_BOT_TOKEN /
//   SLACK_APP_TOKEN, (b) constructs a real `App` instance, and (c) IIFEs into
//   `preflight()` that calls `slack.com`. Importing it from a test would
//   either crash on missing env or hit the network. Adding a test-only export
//   would force restructuring of the IIFE — more invasive than the charter
//   allows ("Do not modify `index.mjs` for testability beyond what's
//   strictly minimal").
//
//   Per the charter, we therefore replicate the receiver's exact routing
//   logic here against `verifyWebhook` from @covent/linear-client. The
//   replicated server below mirrors `createLinearWebhookServer` /
//   `handleLinearWebhookRequest` in index.mjs byte-for-byte (status codes,
//   header read, error code mapping). If the receiver in index.mjs changes,
//   this file must change too — a deliberate cost of test isolation.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { verifyWebhook, WebhookVerificationError } from "@covent/linear-client";

// Mirrors FIXTURE_SECRET from
// packages/linear-client/tests/fixtures/webhook.ts (W-A's verified fixture).
// Inlined because the fixture is .ts-only and is not emitted to dist, and
// `node --test` against an .mjs file can't resolve the .ts import without
// extra flags. The constant is a test-only throwaway value, prefixed with
// `whsec_test_` to make that explicit; the source of truth still lives in
// the linear-client fixture module.
const FIXTURE_SECRET = "whsec_test_0123456789abcdef0123456789abcdef";

// -----------------------------------------------------------------------------
// Replicated receiver — mirrors createLinearWebhookServer in apps/pi-mom/index.mjs
// -----------------------------------------------------------------------------

const WEBHOOK_STATUS_BY_CODE = {
  missing_signature: 401,
  invalid_signature: 401,
  replay_expired: 400,
  malformed_payload: 400,
};

function readRequestBody(req, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error(`webhook body exceeded ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleLinearWebhookRequest(req, res, { secret }) {
  let rawBody;
  try {
    rawBody = await readRequestBody(req);
  } catch {
    sendJson(res, 400, { error: "could not read request body" });
    return;
  }

  try {
    verifyWebhook({ rawBody, headers: req.headers, secret });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      const status = WEBHOOK_STATUS_BY_CODE[error.code] || 400;
      sendJson(res, status, { error: error.code });
      return;
    }
    sendJson(res, 500, { error: "internal_error" });
    return;
  }

  sendJson(res, 200, { ok: true });
}

function createReceiver({ secret }) {
  return createServer((req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    if (method === "GET" && url === "/webhooks/linear/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url === "/webhooks/linear") {
      handleLinearWebhookRequest(req, res, { secret }).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });
}

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

/**
 * Build a Linear webhook body + matching signature for a given timestamp.
 *
 * The W-A static fixture (FIXTURE_BODY/FIXTURE_SIGNATURE) has its
 * webhookTimestamp pinned to 2024-05-15, which is far outside the 60s replay
 * window once wall-clock time leaves that minute. Tests that exercise the
 * receiver's "happy path" need a fresh timestamp, so we compute the HMAC at
 * test time using the same FIXTURE_SECRET. Tampered/stale variants are built
 * from the same generator for consistency.
 */
function buildSignedPayload({ webhookTimestamp, secret = FIXTURE_SECRET, overrides = {} } = {}) {
  const payload = {
    action: "create",
    type: "Issue",
    webhookTimestamp,
    data: { id: "issue-1", identifier: "FE-1", title: "Test" },
    url: "https://linear.app/test/issue/FE-1",
    ...overrides,
  };
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return { body, signature, payload };
}

// -----------------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------------

// LINEAR_WEBHOOK_PORT is read by the production receiver at module import
// time; replicating the receiver above lets us bind to an OS-assigned
// ephemeral port via `listen(0)` instead. The OS guarantees uniqueness so
// the test never collides with a developer's local pi-mom on :3001.
async function startReceiver(secret) {
  const server = createReceiver({ secret });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function post(baseUrl, path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// -----------------------------------------------------------------------------
// Env shim — per the charter, the secret is wired via env. The replicated
// receiver consults this exactly the way createLinearWebhookServer would.
// -----------------------------------------------------------------------------
const ORIGINAL_ENV = {
  LINEAR_WEBHOOK_SIGNING_SECRET: process.env.LINEAR_WEBHOOK_SIGNING_SECRET,
};
process.env.LINEAR_WEBHOOK_SIGNING_SECRET = FIXTURE_SECRET;
test.after(() => {
  if (ORIGINAL_ENV.LINEAR_WEBHOOK_SIGNING_SECRET === undefined) {
    delete process.env.LINEAR_WEBHOOK_SIGNING_SECRET;
  } else {
    process.env.LINEAR_WEBHOOK_SIGNING_SECRET = ORIGINAL_ENV.LINEAR_WEBHOOK_SIGNING_SECRET;
  }
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("POST /webhooks/linear with valid signature → 200", async () => {
  const { baseUrl, close } = await startReceiver(process.env.LINEAR_WEBHOOK_SIGNING_SECRET);
  try {
    const { body, signature } = buildSignedPayload({ webhookTimestamp: Date.now() });
    const res = await post(baseUrl, "/webhooks/linear", body, { "Linear-Signature": signature });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test("POST /webhooks/linear with invalid signature → 401", async () => {
  const { baseUrl, close } = await startReceiver(process.env.LINEAR_WEBHOOK_SIGNING_SECRET);
  try {
    const { body, signature } = buildSignedPayload({ webhookTimestamp: Date.now() });
    // Flip the last hex char to keep length identical.
    const tampered = signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");
    const res = await post(baseUrl, "/webhooks/linear", body, { "Linear-Signature": tampered });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error, "invalid_signature");
  } finally {
    await close();
  }
});

test("POST /webhooks/linear with tampered body → 401 (invalid_signature)", async () => {
  const { baseUrl, close } = await startReceiver(process.env.LINEAR_WEBHOOK_SIGNING_SECRET);
  try {
    const { body, signature } = buildSignedPayload({ webhookTimestamp: Date.now() });
    // Mutate the body after signing — signature no longer matches.
    const tamperedBody = body.replace('"create"', '"update"');
    const res = await post(baseUrl, "/webhooks/linear", tamperedBody, { "Linear-Signature": signature });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error, "invalid_signature");
  } finally {
    await close();
  }
});

test("POST /webhooks/linear with missing Linear-Signature → 401", async () => {
  const { baseUrl, close } = await startReceiver(process.env.LINEAR_WEBHOOK_SIGNING_SECRET);
  try {
    const { body } = buildSignedPayload({ webhookTimestamp: Date.now() });
    const res = await post(baseUrl, "/webhooks/linear", body);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error, "missing_signature");
  } finally {
    await close();
  }
});

test("POST /webhooks/linear with stale webhookTimestamp → 400 (replay_expired)", async () => {
  const { baseUrl, close } = await startReceiver(process.env.LINEAR_WEBHOOK_SIGNING_SECRET);
  try {
    // 61 seconds in the past — outside the 60s replay window.
    const { body, signature } = buildSignedPayload({ webhookTimestamp: Date.now() - 61_000 });
    const res = await post(baseUrl, "/webhooks/linear", body, { "Linear-Signature": signature });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, "replay_expired");
  } finally {
    await close();
  }
});

test("POST /webhooks/linear with malformed (signed) body → 400 (malformed_payload)", async () => {
  const { baseUrl, close } = await startReceiver(process.env.LINEAR_WEBHOOK_SIGNING_SECRET);
  try {
    // Sign a non-JSON body so the signature is valid but JSON.parse fails.
    const body = "this is not json";
    const signature = createHmac("sha256", process.env.LINEAR_WEBHOOK_SIGNING_SECRET)
      .update(body, "utf8")
      .digest("hex");
    const res = await post(baseUrl, "/webhooks/linear", body, { "Linear-Signature": signature });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, "malformed_payload");
  } finally {
    await close();
  }
});

test("GET /webhooks/linear/health → 200 {ok:true}", async () => {
  const { baseUrl, close } = await startReceiver(process.env.LINEAR_WEBHOOK_SIGNING_SECRET);
  try {
    const res = await fetch(`${baseUrl}/webhooks/linear/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { ok: true });
  } finally {
    await close();
  }
});

test("GET /anything-else → 404", async () => {
  const { baseUrl, close } = await startReceiver(process.env.LINEAR_WEBHOOK_SIGNING_SECRET);
  try {
    const res = await fetch(`${baseUrl}/some/other/path`);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error, "not_found");
  } finally {
    await close();
  }
});
