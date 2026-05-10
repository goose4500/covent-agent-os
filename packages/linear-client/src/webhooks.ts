// Webhooks — verify(rawBody, headers, secret) → typed event.
//
// Real impl lands in W-A. Header is `Linear-Signature` (lowercase hex
// HMAC-SHA256 of the raw body). `webhookTimestamp` is read from the parsed
// JSON body (UNIX milliseconds); replay window is 60s. See PRD principle 9
// and Wave 2 R3 outcome.

import { WebhookVerificationError } from "./errors.js";

export interface LinearWebhookHeaders {
	"linear-signature"?: string;
	[key: string]: string | string[] | undefined;
}

export interface LinearWebhookEvent {
	action: string;
	type: string;
	createdAt: string;
	data: Record<string, unknown>;
	url?: string;
	webhookTimestamp: number;
	webhookId?: string;
	organizationId?: string;
}

export interface VerifyWebhookOptions {
	/** Replay window in milliseconds. Defaults to 60_000. */
	replayWindowMs?: number;
	/** Optional previous secret to try, for zero-downtime rotation. */
	previousSecret?: string;
	/** Defaults to Date.now. Injectable for tests. */
	now?: () => number;
}

export interface WebhooksApi {
	verify(
		rawBody: Buffer | string,
		headers: LinearWebhookHeaders,
		secret: string,
		options?: VerifyWebhookOptions,
	): LinearWebhookEvent;
}

export function verify(
	_rawBody: Buffer | string,
	_headers: LinearWebhookHeaders,
	_secret: string,
	_options?: VerifyWebhookOptions,
): LinearWebhookEvent {
	throw new WebhookVerificationError("not implemented", "missing_signature");
}
