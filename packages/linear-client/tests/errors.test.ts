import { test } from "node:test";
import assert from "node:assert/strict";

import * as linearSdk from "@linear/sdk";

import {
	LinearError,
	RatelimitedLinearError,
	UserLinearError,
	AuthenticationLinearError,
	RateLimitedError,
	WebhookVerificationError,
	LinearWriteError,
} from "../src/errors.ts";

test("re-exports are identity-equal to @linear/sdk thrown classes", () => {
	assert.equal(LinearError, linearSdk.LinearError);
	assert.equal(RatelimitedLinearError, linearSdk.RatelimitedLinearError);
	assert.equal(UserLinearError, linearSdk.UserLinearError);
	assert.equal(AuthenticationLinearError, linearSdk.AuthenticationLinearError);
});

test("RateLimitedError carries retryAfterMs and cause", () => {
	const cause = new Error("upstream");
	const err = new RateLimitedError("throttled", 5000, cause);
	assert.equal(err.name, "RateLimitedError");
	assert.equal(err.retryAfterMs, 5000);
	assert.equal(err.cause, cause);
	assert.ok(err instanceof Error);
});

test("WebhookVerificationError carries a typed code", () => {
	const err = new WebhookVerificationError("nope", "invalid_signature");
	assert.equal(err.name, "WebhookVerificationError");
	assert.equal(err.code, "invalid_signature");
	assert.ok(err instanceof Error);
});

test("LinearWriteError records the operation name and optional payload", () => {
	const payload = { success: false, foo: 1 };
	const err = new LinearWriteError("createIssue failed", "createIssue", payload);
	assert.equal(err.name, "LinearWriteError");
	assert.equal(err.operation, "createIssue");
	assert.equal(err.payload, payload);
});
