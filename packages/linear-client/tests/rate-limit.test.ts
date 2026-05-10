import { test } from "node:test";
import assert from "node:assert/strict";

import { RatelimitedLinearError } from "@linear/sdk";

import { withRateLimitGuard } from "../src/rate-limit.ts";
import { RateLimitedError } from "../src/errors.ts";
import { setTraceFn } from "../src/trace.ts";

test("withRateLimitGuard passes through resolved values", async () => {
	const out = await withRateLimitGuard(async () => 42);
	assert.equal(out, 42);
});

test("withRateLimitGuard re-throws non-rate-limit errors unchanged", async () => {
	const original = new Error("boom");
	await assert.rejects(
		withRateLimitGuard(async () => {
			throw original;
		}),
		(err) => err === original,
	);
});

test("withRateLimitGuard translates RatelimitedLinearError to RateLimitedError", async () => {
	// The SDK's RatelimitedLinearError accepts (error?, errors?). Build one
	// without arguments and mutate `retryAfter` (seconds) to simulate a 3s wait.
	const sdkErr = new RatelimitedLinearError();
	sdkErr.retryAfter = 3;

	const seen: Array<{ name: string; data: Record<string, unknown> | undefined }> = [];
	const prev = setTraceFn((name, data) => {
		seen.push({ name, data });
	});

	try {
		await assert.rejects(
			withRateLimitGuard(async () => {
				throw sdkErr;
			}),
			(err: unknown) => {
				assert.ok(err instanceof RateLimitedError);
				assert.equal(err.retryAfterMs, 3000);
				assert.equal(err.cause, sdkErr);
				return true;
			},
		);
	} finally {
		setTraceFn(prev);
	}

	const throttle = seen.find((e) => e.name === "linear.rate_limit.throttle");
	assert.ok(throttle, "expected linear.rate_limit.throttle event");
	assert.equal(throttle.data?.retryAfterMs, 3000);
});

test("withRateLimitGuard falls back to default retry when SDK error has no retryAfter", async () => {
	const sdkErr = new RatelimitedLinearError();
	// `retryAfter` defaults to undefined.

	await assert.rejects(
		withRateLimitGuard(
			async () => {
				throw sdkErr;
			},
			{ defaultRetryAfterMs: 2500 },
		),
		(err: unknown) => {
			assert.ok(err instanceof RateLimitedError);
			assert.equal(err.retryAfterMs, 2500);
			return true;
		},
	);
});
