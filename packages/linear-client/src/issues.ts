// Issues — find / create / upsertFromSlack / transition.
//
// `upsertFromSlack` is the idempotent entrypoint Slack-triggered routes use.
// It looks up an existing attachment by `slackPermalink` (Linear treats
// `attachment.url` as a per-issue idempotency key) before creating a new
// issue. See PRD principle 4 and Wave 2 R2 outcome ("Strategy B").

export interface IssueRef {
	id: string;
	identifier: string;
	title: string;
	url: string;
}

export interface IssueCreateInput {
	teamId: string;
	projectId?: string;
	stateId?: string;
	title: string;
	description?: string;
	labelIds?: string[];
	assigneeId?: string;
	priority?: number;
}

export interface IssueUpsertFromSlackInput {
	teamId: string;
	projectId?: string;
	stateName?: string;
	title: string;
	description?: string;
	slackPermalink: string;
	slackRequestId?: string;
	labelIds?: string[];
	assigneeId?: string;
	priority?: number;
}

export interface IssueTransitionInput {
	state: string;
	type?: string;
}

export interface IssuesApi {
	find(idOrIdentifier: string): Promise<IssueRef | null>;
	create(input: IssueCreateInput): Promise<IssueRef>;
	upsertFromSlack(input: IssueUpsertFromSlackInput): Promise<IssueRef>;
	transition(issueId: string, input: IssueTransitionInput): Promise<IssueRef>;
}

export function find(_idOrIdentifier: string): Promise<IssueRef | null> {
	throw new Error("not implemented");
}

export function create(_input: IssueCreateInput): Promise<IssueRef> {
	throw new Error("not implemented");
}

export function upsertFromSlack(_input: IssueUpsertFromSlackInput): Promise<IssueRef> {
	throw new Error("not implemented");
}

export function transition(_issueId: string, _input: IssueTransitionInput): Promise<IssueRef> {
	throw new Error("not implemented");
}
