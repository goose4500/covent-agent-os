// Comments — post a comment on an issue. W-A implements via @linear/sdk's
// commentCreate mutation.

export interface CommentRef {
	id: string;
	body: string;
	issueId: string;
	url?: string;
}

export interface CommentsApi {
	post(issueId: string, body: string): Promise<CommentRef>;
}

export function post(_issueId: string, _body: string): Promise<CommentRef> {
	throw new Error("not implemented");
}
