// Trace — observability hook matching pi-mom's `trace()` pattern (PRD principle 11).
//
// Callers inject a trace function via `setTraceFn`; the rest of the package
// emits structured events via `trace()`. Secrets are redacted at the boundary
// (by the caller's logging adapter).
//
// Event-naming convention: `linear.<operation>[.<stage>]`. Stable event names
// in this package (non-exhaustive):
//   - linear.issue.create.requested        — about to call createIssue
//   - linear.issue.create.succeeded        — createIssue returned success
//   - linear.issue.find.failed             — findIssue swallowed an SDK error; returning null
//   - linear.issue.upsert.dedupe_hit       — attachmentsForURL returned a hit
//   - linear.issue.upsert.created          — no hit, new issue created
//   - linear.issue.upsert.multiple_matches — attachmentsForURL returned >1
//   - linear.issue.upsert.attachment_failed — issue created but createAttachment threw; re-thrown to caller
//   - linear.issue.upsert.attachment_resolve_failed — issue() lookup for an attachment node threw; treated as miss
//   - linear.issue.transition.requested    — about to call updateIssue
//   - linear.workflow_state.resolve.cache_hit
//   - linear.workflow_state.resolve.cache_miss
//   - linear.attachment.upsert.requested
//   - linear.comment.post.requested
//   - linear.rate_limit.throttle           — RatelimitedLinearError translated
//   - linear.webhook.verify.invalid_signature
//   - linear.webhook.verify.replay_expired
//   - linear.webhook.verify.missing_signature
//   - linear.webhook.verify.malformed_payload
//   - linear.webhook.verify.succeeded

export type TraceFn = (eventName: string, data?: Record<string, unknown>) => void;

const NOOP: TraceFn = () => {};

let traceFn: TraceFn = NOOP;

/**
 * Swap in a trace adapter. Pass `null` to reset to a no-op. Returns the
 * previous trace function so callers can restore it (useful in tests).
 */
export function setTraceFn(fn: TraceFn | null): TraceFn {
	const prev = traceFn;
	traceFn = fn ?? NOOP;
	return prev;
}

/** Emit a structured trace event. Safe to call before `setTraceFn`. */
export function trace(eventName: string, data?: Record<string, unknown>): void {
	try {
		traceFn(eventName, data);
	} catch {
		// Trace adapters must never break a Linear call. Swallow.
	}
}
