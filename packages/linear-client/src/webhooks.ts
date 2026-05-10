// Webhooks — verify a Linear webhook payload and return a typed event.
//
// PRD principle 9 + Wave 2 R3 outcome (binding facts):
//   - Header is `Linear-Signature` (lowercase hex HMAC-SHA256 of the raw body).
//   - Body bytes signed are the raw, unparsed request body.
//   - Timestamp is the JSON body field `webhookTimestamp` in UNIX milliseconds
//     (there is no `Linear-Signature-Timestamp` header).
//   - Replay window: |now - webhookTimestamp| < 60_000 ms.
//   - There is no documented `Linear-Signature-Previous` header. Zero-downtime
//     rotation is implemented at the verifier boundary by trying multiple
//     secrets in turn (`secret`, then `additionalSecrets[]`).
//   - Node's `IncomingMessage.headers` lowercases header keys, so callers
//     read `req.headers["linear-signature"]`.

import { createHmac, timingSafeEqual } from "node:crypto";

import { WebhookVerificationError } from "./errors.ts";
import { trace } from "./trace.ts";

const DEFAULT_REPLAY_WINDOW_MS = 60_000;

/** Strongly-typed flat event shape returned by `verifyWebhook`. */
export interface VerifiedWebhookEvent {
	action: string;
	type: string;
	createdAt?: string;
	updatedAt?: string;
	webhookTimestamp: number;
	webhookId?: string;
	organizationId?: string;
	url?: string;
	data: Record<string, unknown>;
	/** The full parsed payload, in case handlers need fields we haven't surfaced. */
	payload: Record<string, unknown>;
}

export interface LinearWebhookHeaders {
	"linear-signature"?: string | string[];
	[key: string]: string | string[] | undefined;
}

export interface VerifyWebhookOptions {
	/** Raw body as received from the HTTP transport, before any JSON parse. */
	rawBody: Buffer | string;
	headers: LinearWebhookHeaders;
	/** Primary signing secret (LINEAR_WEBHOOK_SIGNING_SECRET). */
	secret: string;
	/**
	 * Optional alternate secrets to try in turn. Used for zero-downtime
	 * rotation: pass `[process.env.LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS]`.
	 */
	additionalSecrets?: string[];
	/** Replay window in milliseconds. Defaults to 60_000. */
	replayWindowMs?: number;
	/** Injectable clock for tests. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Verify a Linear webhook request and return its parsed event. Throws
 * `WebhookVerificationError` with one of four codes on failure.
 */
export function verifyWebhook(opts: VerifyWebhookOptions): VerifiedWebhookEvent {
	const { rawBody, headers, secret, replayWindowMs = DEFAULT_REPLAY_WINDOW_MS } = opts;
	const additionalSecrets = opts.additionalSecrets ?? [];
	const now = opts.now ?? Date.now;

	const rawHeader = headers["linear-signature"];
	const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
	if (typeof headerValue !== "string" || headerValue.length === 0) {
		trace("linear.webhook.verify.missing_signature");
		throw new WebhookVerificationError(
			"missing Linear-Signature header",
			"missing_signature",
		);
	}

	const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
	const candidates = [secret, ...additionalSecrets].filter(
		(s): s is string => typeof s === "string" && s.length > 0,
	);
	if (candidates.length === 0) {
		throw new WebhookVerificationError(
			"no signing secrets supplied",
			"invalid_signature",
		);
	}

	let signatureOk = false;
	for (const candidate of candidates) {
		const computed = createHmac("sha256", candidate).update(bodyBuf).digest("hex");
		if (sigEquals(computed, headerValue)) {
			signatureOk = true;
			break;
		}
	}

	if (!signatureOk) {
		trace("linear.webhook.verify.invalid_signature");
		throw new WebhookVerificationError(
			"signature did not match any configured secret",
			"invalid_signature",
		);
	}

	// Signature OK — parse the body. Done AFTER signature verification so a
	// malformed-but-signed payload still surfaces a typed error and we never
	// parse unverified bytes.
	let payload: Record<string, unknown>;
	try {
		const text = bodyBuf.toString("utf8");
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("payload is not a JSON object");
		}
		payload = parsed as Record<string, unknown>;
	} catch (cause) {
		trace("linear.webhook.verify.malformed_payload");
		throw new WebhookVerificationError(
			`could not parse webhook body as JSON object: ${(cause as Error).message}`,
			"malformed_payload",
		);
	}

	const ts = payload["webhookTimestamp"];
	if (typeof ts !== "number" || !Number.isFinite(ts)) {
		trace("linear.webhook.verify.malformed_payload");
		throw new WebhookVerificationError(
			"webhookTimestamp missing or not a number",
			"malformed_payload",
		);
	}

	if (Math.abs(now() - ts) > replayWindowMs) {
		trace("linear.webhook.verify.replay_expired", {
			webhookTimestamp: ts,
			replayWindowMs,
		});
		throw new WebhookVerificationError(
			`webhookTimestamp outside replay window of ${replayWindowMs}ms`,
			"replay_expired",
		);
	}

	const action = payload["action"];
	const type = payload["type"];
	if (typeof action !== "string" || typeof type !== "string") {
		trace("linear.webhook.verify.malformed_payload");
		throw new WebhookVerificationError(
			"webhook payload missing required 'action'/'type' string fields",
			"malformed_payload",
		);
	}

	const data = (payload["data"] && typeof payload["data"] === "object")
		? (payload["data"] as Record<string, unknown>)
		: {};

	trace("linear.webhook.verify.succeeded", { type, action });

	const event: VerifiedWebhookEvent = {
		action,
		type,
		webhookTimestamp: ts,
		data,
		payload,
	};
	if (typeof payload["createdAt"] === "string") event.createdAt = payload["createdAt"] as string;
	if (typeof payload["updatedAt"] === "string") event.updatedAt = payload["updatedAt"] as string;
	if (typeof payload["webhookId"] === "string") event.webhookId = payload["webhookId"] as string;
	if (typeof payload["organizationId"] === "string") {
		event.organizationId = payload["organizationId"] as string;
	}
	if (typeof payload["url"] === "string") event.url = payload["url"] as string;
	return event;
}

/** Constant-time hex comparison. Returns false if lengths differ. */
function sigEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const ba = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ba.length !== bb.length) return false;
	try {
		return timingSafeEqual(ba, bb);
	} catch {
		return false;
	}
}

/**
 * The facade-bound API surface for webhook verification. Created by the
 * client facade (commit 6); tests use `verifyWebhook` directly.
 */
export interface WebhooksApi {
	verify(opts: Omit<VerifyWebhookOptions, "secret"> & { secret?: string }): VerifiedWebhookEvent;
}
