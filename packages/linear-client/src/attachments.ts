// Attachments — upsert by URL.
//
// Linear treats `attachment.url` as a per-issue idempotency key:
// re-posting the same url for the same issueId upserts rather than duplicates.
// See PRD principle 4 / Wave 2 R2 outcome.

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
	metadata?: Record<string, unknown>;
}

export interface AttachmentsApi {
	upsert(input: AttachmentUpsertInput): Promise<AttachmentRef>;
}

export function upsert(_input: AttachmentUpsertInput): Promise<AttachmentRef> {
	throw new Error("not implemented");
}
