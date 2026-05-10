// Comments — post a comment on an issue via @linear/sdk's createComment.

import { LinearWriteError } from "./errors.ts";
import { trace } from "./trace.ts";

export interface CommentRef {
	id: string;
	body: string;
	issueId: string;
	url?: string;
}

/** Minimal SDK surface needed for posting comments. */
export interface CommentsSdkLike {
	createComment(input: { issueId: string; body: string }): Promise<{
		success: boolean;
		comment?: Promise<{ id: string; body: string; url?: string | null }> | {
			id: string;
			body: string;
			url?: string | null;
		};
	}>;
}

/** Post a comment on an issue. Throws `LinearWriteError` on `success: false`. */
export async function postComment(
	client: CommentsSdkLike,
	issueId: string,
	body: string,
): Promise<CommentRef> {
	trace("linear.comment.post.requested", { issueId });

	const payload = await client.createComment({ issueId, body });
	if (!payload.success) {
		throw new LinearWriteError(
			`createComment returned success: false for issueId=${issueId}`,
			"createComment",
			payload,
		);
	}
	const comment = await Promise.resolve(payload.comment);
	if (!comment) {
		throw new LinearWriteError(
			"createComment succeeded but returned no comment",
			"createComment",
			payload,
		);
	}

	const ref: CommentRef = {
		id: comment.id,
		body: comment.body,
		issueId,
	};
	if (comment.url) ref.url = comment.url;
	return ref;
}

export interface CommentsApi {
	post(issueId: string, body: string): Promise<CommentRef>;
}
