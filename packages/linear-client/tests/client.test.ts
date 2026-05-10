import { test } from "node:test";
import assert from "node:assert/strict";

import { createLinearClient } from "../src/client.ts";
import {
	FIXTURE_BODY,
	FIXTURE_SECRET,
	FIXTURE_SIGNATURE,
	FIXTURE_TIMESTAMP_MS,
} from "./fixtures/webhook.ts";

test("createLinearClient requires an apiKey", () => {
	assert.throws(
		() => createLinearClient({ apiKey: "" }),
		/apiKey is required/,
	);
});

test("createLinearClient returns a facade exposing every sub-API", () => {
	const client = createLinearClient({ apiKey: "lin_api_test_only_not_real" });

	assert.ok(client.sdk, "sdk escape hatch is exposed");
	assert.equal(typeof client.issues.find, "function");
	assert.equal(typeof client.issues.create, "function");
	assert.equal(typeof client.issues.upsertFromSlack, "function");
	assert.equal(typeof client.issues.transition, "function");
	assert.equal(typeof client.comments.post, "function");
	assert.equal(typeof client.attachments.upsert, "function");
	assert.equal(typeof client.workflowStates.resolve, "function");
	assert.equal(typeof client.workflowStates.invalidate, "function");
	assert.equal(typeof client.webhooks.verify, "function");
	assert.equal(typeof client.withRateLimitGuard, "function");
	assert.equal(typeof client.setTrace, "function");
});

test("facade.withRateLimitGuard passes values through", async () => {
	const client = createLinearClient({ apiKey: "lin_api_test_only_not_real" });
	const out = await client.withRateLimitGuard(async () => "ok");
	assert.equal(out, "ok");
});

test("facade.webhooks.verify wires through to the verifier", () => {
	const client = createLinearClient({ apiKey: "lin_api_test_only_not_real" });
	const event = client.webhooks.verify({
		rawBody: FIXTURE_BODY,
		headers: { "linear-signature": FIXTURE_SIGNATURE },
		secret: FIXTURE_SECRET,
		now: () => FIXTURE_TIMESTAMP_MS + 100,
	});
	assert.equal(event.type, "Issue");
	assert.equal(event.action, "create");
});

test("facade.webhooks.verify rejects empty secret at the facade boundary", () => {
	const client = createLinearClient({ apiKey: "lin_api_test_only_not_real" });
	assert.throws(
		() =>
			client.webhooks.verify({
				rawBody: FIXTURE_BODY,
				headers: { "linear-signature": FIXTURE_SIGNATURE },
				secret: "",
			}),
		/secret is required/,
	);
});

test("facade.setTrace returns the previous adapter so callers can restore it", () => {
	const client = createLinearClient({ apiKey: "lin_api_test_only_not_real" });
	const seen: string[] = [];
	const prev = client.setTrace((name) => seen.push(name));
	try {
		// Sanity-check that subsequent calls would flow through; verify via the
		// webhook path which emits exactly one trace on success.
		client.webhooks.verify({
			rawBody: FIXTURE_BODY,
			headers: { "linear-signature": FIXTURE_SIGNATURE },
			secret: FIXTURE_SECRET,
			now: () => FIXTURE_TIMESTAMP_MS + 100,
		});
		assert.ok(seen.includes("linear.webhook.verify.succeeded"));
	} finally {
		client.setTrace(prev);
	}
});
