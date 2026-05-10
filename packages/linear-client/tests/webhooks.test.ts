import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyWebhook } from "../src/webhooks.ts";
import { WebhookVerificationError } from "../src/errors.ts";
import {
	FIXTURE_BODY,
	FIXTURE_PREV_SECRET,
	FIXTURE_SECRET,
	FIXTURE_SIGNATURE,
	FIXTURE_SIGNATURE_PREV,
	FIXTURE_TIMESTAMP_MS,
} from "./fixtures/webhook.ts";

// Clock pinned to the body's webhookTimestamp + 1s so the 60s replay window
// is always satisfied unless a test deliberately exceeds it.
const fixedNow = () => FIXTURE_TIMESTAMP_MS + 1_000;

test("verifyWebhook accepts a valid signature and returns a typed event", () => {
	const event = verifyWebhook({
		rawBody: FIXTURE_BODY,
		headers: { "linear-signature": FIXTURE_SIGNATURE },
		secret: FIXTURE_SECRET,
		now: fixedNow,
	});

	assert.equal(event.action, "create");
	assert.equal(event.type, "Issue");
	assert.equal(event.webhookTimestamp, FIXTURE_TIMESTAMP_MS);
	assert.equal(event.url, "https://linear.app/test/issue/FE-1");
	assert.deepEqual(event.data, {
		id: "issue-1",
		identifier: "FE-1",
		title: "Test",
	});
});

test("verifyWebhook accepts Buffer raw bodies", () => {
	const event = verifyWebhook({
		rawBody: Buffer.from(FIXTURE_BODY, "utf8"),
		headers: { "linear-signature": FIXTURE_SIGNATURE },
		secret: FIXTURE_SECRET,
		now: fixedNow,
	});
	assert.equal(event.type, "Issue");
});

test("tampered body fails with invalid_signature", () => {
	const tampered = FIXTURE_BODY.replace("\"create\"", "\"update\"");
	assert.throws(
		() =>
			verifyWebhook({
				rawBody: tampered,
				headers: { "linear-signature": FIXTURE_SIGNATURE },
				secret: FIXTURE_SECRET,
				now: fixedNow,
			}),
		(err: unknown) => {
			assert.ok(err instanceof WebhookVerificationError);
			assert.equal(err.code, "invalid_signature");
			return true;
		},
	);
});

test("tampered signature fails with invalid_signature", () => {
	// Flip the last hex char to keep length identical.
	const flipped = FIXTURE_SIGNATURE.slice(0, -1) + (FIXTURE_SIGNATURE.endsWith("6") ? "7" : "6");
	assert.throws(
		() =>
			verifyWebhook({
				rawBody: FIXTURE_BODY,
				headers: { "linear-signature": flipped },
				secret: FIXTURE_SECRET,
				now: fixedNow,
			}),
		(err: unknown) => {
			assert.ok(err instanceof WebhookVerificationError);
			assert.equal(err.code, "invalid_signature");
			return true;
		},
	);
});

test("stale timestamp (>60s) fails with replay_expired", () => {
	assert.throws(
		() =>
			verifyWebhook({
				rawBody: FIXTURE_BODY,
				headers: { "linear-signature": FIXTURE_SIGNATURE },
				secret: FIXTURE_SECRET,
				now: () => FIXTURE_TIMESTAMP_MS + 60_001,
			}),
		(err: unknown) => {
			assert.ok(err instanceof WebhookVerificationError);
			assert.equal(err.code, "replay_expired");
			return true;
		},
	);
});

test("missing signature header fails with missing_signature", () => {
	assert.throws(
		() =>
			verifyWebhook({
				rawBody: FIXTURE_BODY,
				headers: {},
				secret: FIXTURE_SECRET,
				now: fixedNow,
			}),
		(err: unknown) => {
			assert.ok(err instanceof WebhookVerificationError);
			assert.equal(err.code, "missing_signature");
			return true;
		},
	);
});

test("rotation: additionalSecrets accepts a signature from the previous secret", () => {
	const event = verifyWebhook({
		rawBody: FIXTURE_BODY,
		headers: { "linear-signature": FIXTURE_SIGNATURE_PREV },
		secret: FIXTURE_SECRET,                  // primary will mismatch
		additionalSecrets: [FIXTURE_PREV_SECRET], // previous accepts
		now: fixedNow,
	});
	assert.equal(event.type, "Issue");
});

test("malformed JSON fails with malformed_payload", () => {
	// Sign a non-JSON body so the signature passes but JSON.parse fails.
	const body = "not-json-but-signed";
	const sig = createHmac("sha256", FIXTURE_SECRET).update(body).digest("hex");
	assert.throws(
		() =>
			verifyWebhook({
				rawBody: body,
				headers: { "linear-signature": sig },
				secret: FIXTURE_SECRET,
				now: fixedNow,
			}),
		(err: unknown) => {
			assert.ok(err instanceof WebhookVerificationError);
			assert.equal(err.code, "malformed_payload");
			return true;
		},
	);
});

test("array-valued Linear-Signature header is supported (Node http behavior)", () => {
	const event = verifyWebhook({
		rawBody: FIXTURE_BODY,
		headers: { "linear-signature": [FIXTURE_SIGNATURE] },
		secret: FIXTURE_SECRET,
		now: fixedNow,
	});
	assert.equal(event.type, "Issue");
});
