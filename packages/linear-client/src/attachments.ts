// Attachments — upsert by URL.
//
// Linear treats `attachment.url` as a per-issue idempotency key: re-posting
// the same url for the same issueId upserts rather than duplicates. See PRD
// principle 4 / Wave 2 R2 outcome.

import { LinearWriteError } from "./errors.ts";
import { trace } from "./trace.ts";

export interface AttachmentRef {
	id: string;
	url: string;
	title: string;
	issueId: string;
}

export interface AttachmentUpsertInput {
	issueId: string;
	url: string;
	title: string;
	subtitle?: string;
	iconUrl?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Minimal SDK surface — anything with a `createAttachment(input)` that
 * resolves to `{ success: boolean; attachment?: Promise<...> }` works.
 */
export interface AttachmentsSdkLike {
	createAttachment(input: {
		issueId: string;
		url: string;
		title: string;
		subtitle?: string;
		iconUrl?: string;
		metadata?: Record<string, unknown>;
	}): Promise<{
		success: boolean;
		attachment?: Promise<{ id: string; url: string; title: string }> | { id: string; url: string; title: string };
	}>;
}

/**
 * Idempotent upsert: Linear's `attachmentCreate` is documented as
 * idempotent on `(issueId, url)`. We surface `success: false` as a
 * `LinearWriteError` so callers don't accidentally proceed.
 */
export async function upsertAttachment(
	client: AttachmentsSdkLike,
	input: AttachmentUpsertInput,
): Promise<AttachmentRef> {
	trace("linear.attachment.upsert.requested", { issueId: input.issueId, url: input.url });

	const payload = await client.createAttachment({
		issueId: input.issueId,
		url: input.url,
		title: input.title,
		subtitle: input.subtitle,
		iconUrl: input.iconUrl,
		metadata: input.metadata,
	});

	if (!payload.success) {
		throw new LinearWriteError(
			`createAttachment returned success: false for issueId=${input.issueId} url=${input.url}`,
			"createAttachment",
			payload,
		);
	}

	const attachment = await Promise.resolve(payload.attachment);
	if (!attachment) {
		throw new LinearWriteError(
			"createAttachment succeeded but returned no attachment",
			"createAttachment",
			payload,
		);
	}

	return {
		id: attachment.id,
		url: attachment.url,
		title: attachment.title,
		issueId: input.issueId,
	};
}

export interface AttachmentsApi {
	upsert(input: AttachmentUpsertInput): Promise<AttachmentRef>;
}
