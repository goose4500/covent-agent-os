// Per-source webhook signature verifiers and replay-window check.
//
// Phase-1 of the event-driven Pi runtime (see issue #48): the HTTP receiver
// calls these from inside its request handler. Each verifier is a pure
// function so the receiver can be tested without HTTP plumbing and so the
// verifiers themselves can be tested against known HMAC fixtures.
//
// Linear webhook contract (May 2026):
//   Header `Linear-Signature` is the hex-encoded HMAC-SHA256 of the raw
//   request body, signed with the webhook's signing secret. The signing
//   secret is provisioned per-webhook in Linear and lives in
//   LINEAR_WEBHOOK_SECRET on our side.
//
//   The HMAC MUST be computed over the raw bytes Linear sent, not over the
//   reparsed JSON — JSON.stringify can re-order keys and re-escape strings,
//   which silently breaks verification. The receiver is responsible for
//   capturing the raw body via express.json({ verify }) and passing it here.
//
// GitHub and other sources can ride the same module — add `verifyGithub` here
// when Phase-2 wires GitHub webhooks. Header name is `X-Hub-Signature-256`
// with `sha256=<hex>` prefix; same primitive, slightly different format.
//
// Timing-safe compare via crypto.timingSafeEqual: equal-length Buffer
// comparison that doesn't short-circuit on the first mismatched byte, so
// attackers can't probe the secret with statistical timing.

import { createHmac, timingSafeEqual } from "node:crypto";

const HEX64 = /^[0-9a-fA-F]{64}$/;

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === "string") return Buffer.from(input, "utf8");
  return null;
}

export function verifyLinear(rawBody, signatureHeader, secret) {
  // Defensive: empty/missing inputs return false rather than throw. The
  // receiver always responds 401 on a false result, so throwing here would
  // just be a different error path with the same outcome.
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signatureHeader !== "string") return false;
  if (!HEX64.test(signatureHeader)) return false;

  const body = toBuffer(rawBody);
  if (!body) return false;

  const expected = createHmac("sha256", secret).update(body).digest();
  let received;
  try {
    received = Buffer.from(signatureHeader, "hex");
  } catch {
    return false;
  }
  // Belt-and-suspenders: HEX64 already guarantees the length, but
  // timingSafeEqual throws on mismatched length, so we re-check before
  // calling it.
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

export function isFreshTimestamp(
  timestampMs,
  { now = Date.now, toleranceMs = 60000 } = {},
) {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
    return false;
  }
  return Math.abs(now() - timestampMs) <= toleranceMs;
}
