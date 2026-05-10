// Errors — re-exports of @linear/sdk's thrown subclasses plus our local
// typed wrappers.
//
// Per Wave 2 R1: the SDK's thrown classes all extend `LinearError`. The names
// below match the SDK exactly. `UserError` (without the `Linear` suffix) is a
// GraphQL payload type, not a thrown class — do not import it here.

export {
	LinearError,
	AuthenticationLinearError,
	InvalidInputLinearError,
	FeatureNotAccessibleLinearError,
	RatelimitedLinearError,
	NetworkLinearError,
	ForbiddenLinearError,
	BootstrapLinearError,
	GraphqlLinearError,
	InternalLinearError,
	LockTimeoutLinearError,
	OtherLinearError,
	UnknownLinearError,
	UsageLimitExceededLinearError,
	UserLinearError,
} from "@linear/sdk";

/**
 * Thrown when our rate-limit guard refuses to dispatch because the SDK or our
 * middleware has determined the workspace is being throttled.
 * `retryAfterMs` is the suggested wait before retrying.
 */
export class RateLimitedError extends Error {
	readonly retryAfterMs: number;
	readonly cause?: unknown;
	constructor(message: string, retryAfterMs: number, cause?: unknown) {
		super(message);
		this.name = "RateLimitedError";
		this.retryAfterMs = retryAfterMs;
		this.cause = cause;
	}
}

export type WebhookVerificationErrorCode =
	| "missing_signature"
	| "invalid_signature"
	| "replay_expired"
	| "malformed_payload";

/**
 * Thrown by `webhooks.verify` when a payload fails any of the integrity
 * checks (missing/invalid signature, expired replay window, malformed JSON).
 */
export class WebhookVerificationError extends Error {
	readonly code: WebhookVerificationErrorCode;
	constructor(message: string, code: WebhookVerificationErrorCode) {
		super(message);
		this.name = "WebhookVerificationError";
		this.code = code;
	}
}

/**
 * Thrown when a Linear mutation returns a `success: false` payload. The SDK's
 * mutation payloads (IssuePayload, CommentPayload, AttachmentPayload, …) all
 * expose a boolean `success` field; per PRD principle 8, partial-success is
 * treated as failure.
 */
export class LinearWriteError extends Error {
	readonly operation: string;
	readonly payload?: unknown;
	constructor(message: string, operation: string, payload?: unknown) {
		super(message);
		this.name = "LinearWriteError";
		this.operation = operation;
		this.payload = payload;
	}
}
