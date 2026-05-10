// Rate-limit guard — translates the SDK's `RatelimitedLinearError` into our
// typed `RateLimitedError` carrying `retryAfterMs`. Emits a structured trace
// event so callers' logging shows when Linear is throttling us. See PRD
// principle 7.
//
// V1 scope note: the `@linear/sdk` client does not surface `X-RateLimit-*`
// response headers, so the proactive "throttle when remaining < thresholdPct"
// pre-emption the PRD imagines is deferred to v2. V1 reacts to the SDK's
// `RatelimitedLinearError` and surfaces it as a typed error with a numeric
// `retryAfterMs`. The `thresholdPct` option is accepted-and-ignored for
// forward compatibility so call sites do not need to change in v2.

import { RatelimitedLinearError } from "@linear/sdk";

import { RateLimitedError } from "./errors.ts";
import { trace } from "./trace.ts";

export interface RateLimitGuardOptions {
	/** Reserved for v2 proactive throttling; ignored in v1. Default 0.1. */
	thresholdPct?: number;
	/** Injectable clock for tests. Defaults to Date.now. */
	now?: () => number;
	/** Fallback retry-after when the SDK error doesn't carry one. Default 1000ms. */
	defaultRetryAfterMs?: number;
}

const DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * Wrap a Promise-returning thunk. On success, returns the value. On a thrown
 * `RatelimitedLinearError`, throws a typed `RateLimitedError` with
 * `retryAfterMs` set from the SDK's `retryAfter` (seconds) when available, or
 * the configured default otherwise. Emits `linear.rate_limit.throttle`.
 */
export async function withRateLimitGuard<T>(
	fn: () => Promise<T>,
	opts: RateLimitGuardOptions = {},
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof RatelimitedLinearError) {
			const retryAfterSec = err.retryAfter;
			const retryAfterMs =
				typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec) && retryAfterSec > 0
					? Math.round(retryAfterSec * 1000)
					: (opts.defaultRetryAfterMs ?? DEFAULT_RETRY_AFTER_MS);

			trace("linear.rate_limit.throttle", {
				retryAfterMs,
				requestsRemaining: err.requestsRemaining,
				complexityRemaining: err.complexityRemaining,
			});

			throw new RateLimitedError(
				err.message || "Linear rate limit hit",
				retryAfterMs,
				err,
			);
		}
		throw err;
	}
}
