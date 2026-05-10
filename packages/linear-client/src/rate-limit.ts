// Rate-limit guard — middleware reading `X-RateLimit-Requests-Remaining` and
// `X-RateLimit-Complexity-Remaining` from each response. When remaining drops
// below threshold, it queues until reset. `RATELIMITED` GraphQL errors become
// a typed `RateLimitedError` with `retryAfterMs`. See PRD principle 7.

export interface RateLimitGuardOptions {
	/** Throttle when remaining drops below this fraction (0..1). Default 0.1. */
	thresholdFraction?: number;
	/** Hard ceiling for retry/backoff in ms. Default 60_000. */
	maxBackoffMs?: number;
}

export function withRateLimitGuard<TArgs extends unknown[], TResult>(
	_fn: (...args: TArgs) => Promise<TResult>,
	_options?: RateLimitGuardOptions,
): (...args: TArgs) => Promise<TResult> {
	throw new Error("not implemented");
}
