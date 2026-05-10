// Issues — find / create / upsertFromSlack / transition.
//
// `upsertFromSlack` is the idempotent entrypoint Slack-triggered routes use.
// It implements Strategy B from Wave 2 R2 exactly: look up existing
// attachments by Slack permalink, return the linked issue if found, else
// create the issue, append the permalink to the description, and attach it.
// See PRD principle 4 and Wave 2 R2 outcome.

import { LinearWriteError } from "./errors.ts";
import { upsertAttachment, type AttachmentsSdkLike } from "./attachments.ts";
import { trace } from "./trace.ts";
import { WorkflowStateCache, type WorkflowStatesSdkLike } from "./workflow-states.ts";

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
	/** Resolved to `stateId` via WorkflowStateCache when `stateId` is absent. */
	stateName?: string;
	title: string;
	description?: string;
	labelIds?: string[];
	assigneeId?: string;
	priority?: number;
}

export interface IssueTransitionInput {
	stateName?: string;
	stateType?: string;
	/**
	 * Optional teamId; required when the SDK does not return `team.id` on the
	 * issue we're transitioning (we derive it from `issue.team` otherwise).
	 */
	teamId?: string;
}

export interface IssueUpsertFromSlackInput {
	teamId: string;
	projectId?: string;
	stateName?: string;
	stateId?: string;
	title: string;
	description?: string;
	slackPermalink: string;
	slackRequestId: string;
	labelIds?: string[];
	assigneeId?: string;
	priority?: number;
}

export interface IssueUpsertFromSlackResult {
	issue: IssueRef;
	created: boolean;
}

/**
 * SDK shape consumed by `issues.*`. We accept a superset that combines the
 * surfaces needed for create/update/find and the Strategy B dedupe lookup.
 */
export interface IssuesSdkLike extends WorkflowStatesSdkLike, AttachmentsSdkLike {
	issue(idOrIdentifier: string): Promise<IssueLike>;
	createIssue(input: {
		teamId: string;
		projectId?: string;
		stateId?: string;
		title: string;
		description?: string;
		labelIds?: string[];
		assigneeId?: string;
		priority?: number;
	}): Promise<{ success: boolean; issue?: Promise<IssueLike> | IssueLike }>;
	updateIssue(
		id: string,
		input: { stateId?: string },
	): Promise<{ success: boolean; issue?: Promise<IssueLike> | IssueLike }>;
	attachmentsForURL(url: string): Promise<{
		nodes: Array<AttachmentForUrlNode>;
	}>;
}

/** Minimum shape we read off an Issue. */
export interface IssueLike {
	id: string;
	identifier: string;
	title: string;
	url: string;
	archivedAt?: Date | string | null;
	teamId?: string;
	team?: Promise<{ id: string }> | { id: string };
}

/** Minimum shape we read off an Attachment returned by attachmentsForURL. */
export interface AttachmentForUrlNode {
	id: string;
	url: string;
	createdAt?: Date | string;
	archivedAt?: Date | string | null;
	issue?: Promise<IssueLike> | IssueLike;
	issueId?: string;
}

function toIssueRef(i: IssueLike): IssueRef {
	return { id: i.id, identifier: i.identifier, title: i.title, url: i.url };
}

/** Resolve `issue.team.id` whether the SDK returns it eagerly or lazily. */
async function resolveTeamId(i: IssueLike): Promise<string | undefined> {
	if (i.teamId) return i.teamId;
	if (i.team) {
		const t = await Promise.resolve(i.team);
		return t?.id;
	}
	return undefined;
}

/** Resolve `attachment.issue` whether the SDK returns it eagerly or lazily. */
async function resolveAttachmentIssue(
	node: AttachmentForUrlNode,
	client: IssuesSdkLike,
): Promise<IssueLike | null> {
	if (node.issue) {
		const issue = await Promise.resolve(node.issue);
		return issue ?? null;
	}
	if (node.issueId) {
		try {
			return await client.issue(node.issueId);
		} catch (error) {
			trace("linear.issue.upsert.attachment_resolve_failed", {
				issueId: node.issueId,
				url: node.url,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
	return null;
}

function isArchived(value: Date | string | null | undefined): boolean {
	return value !== undefined && value !== null;
}

/** Look up an issue by UUID or human identifier. SDK accepts both. */
export async function findIssue(
	client: IssuesSdkLike,
	idOrIdentifier: string,
): Promise<IssueRef | null> {
	try {
		const issue = await client.issue(idOrIdentifier);
		if (!issue) return null;
		return toIssueRef(issue);
	} catch (error) {
		trace("linear.issue.find.failed", {
			input: idOrIdentifier,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Create an issue. Resolves `stateName` to a stateId via the workflow-state
 * cache when provided and `stateId` is absent. Throws `LinearWriteError` on
 * `success: false`.
 */
export async function createIssue(
	client: IssuesSdkLike,
	cache: WorkflowStateCache,
	input: IssueCreateInput,
): Promise<IssueRef> {
	let stateId = input.stateId;
	if (!stateId && input.stateName) {
		stateId = await cache.resolve(client, { teamId: input.teamId, name: input.stateName });
	}

	trace("linear.issue.create.requested", {
		teamId: input.teamId,
		projectId: input.projectId,
		stateId,
	});

	const payload = await client.createIssue({
		teamId: input.teamId,
		projectId: input.projectId,
		stateId,
		title: input.title,
		description: input.description,
		labelIds: input.labelIds,
		assigneeId: input.assigneeId,
		priority: input.priority,
	});

	if (!payload.success) {
		throw new LinearWriteError(
			`createIssue returned success: false for teamId=${input.teamId}`,
			"createIssue",
			payload,
		);
	}
	const issue = await Promise.resolve(payload.issue);
	if (!issue) {
		throw new LinearWriteError(
			"createIssue succeeded but returned no issue",
			"createIssue",
			payload,
		);
	}

	trace("linear.issue.create.succeeded", { id: issue.id, identifier: issue.identifier });
	return toIssueRef(issue);
}

/**
 * Move an issue to a new workflow state, resolved by name/type via the
 * per-team cache. `teamId` is optional — if absent we read it off the
 * issue's `team` accessor.
 */
export async function transitionIssue(
	client: IssuesSdkLike,
	cache: WorkflowStateCache,
	issueId: string,
	input: IssueTransitionInput,
): Promise<IssueRef> {
	if (!input.stateName && !input.stateType) {
		throw new Error("transition: at least one of stateName or stateType is required");
	}

	let teamId = input.teamId;
	if (!teamId) {
		const issue = await client.issue(issueId);
		teamId = await resolveTeamId(issue);
		if (!teamId) {
			throw new Error(`transition: could not determine teamId for issue ${issueId}`);
		}
	}

	const stateId = await cache.resolve(client, {
		teamId,
		name: input.stateName,
		type: input.stateType,
	});

	trace("linear.issue.transition.requested", { issueId, teamId, stateId });

	const payload = await client.updateIssue(issueId, { stateId });
	if (!payload.success) {
		throw new LinearWriteError(
			`updateIssue returned success: false for issueId=${issueId}`,
			"updateIssue",
			payload,
		);
	}
	const issue = await Promise.resolve(payload.issue);
	if (!issue) {
		// Some SDK versions don't return the issue on update; refetch.
		const refetched = await client.issue(issueId);
		return toIssueRef(refetched);
	}
	return toIssueRef(issue);
}

/**
 * Strategy B upsert (Wave 2 R2):
 *   1. attachmentsForURL(slackPermalink) → if any non-archived hit, return it.
 *   2. If >1 non-archived hits, trace and pick the OLDEST by createdAt.
 *   3. Otherwise, append the permalink to the description, create the issue,
 *      then create the Slack attachment, return { issue, created: true }.
 */
export async function upsertFromSlack(
	client: IssuesSdkLike,
	cache: WorkflowStateCache,
	input: IssueUpsertFromSlackInput,
): Promise<IssueUpsertFromSlackResult> {
	const { slackPermalink, slackRequestId } = input;

	const hits = await client.attachmentsForURL(slackPermalink);
	const nodes = hits?.nodes ?? [];

	// Collect non-archived hits. If the attachment's archivedAt isn't surfaced
	// we do one extra issue() lookup to inspect issue.archivedAt instead.
	const liveHits: Array<{ node: AttachmentForUrlNode; issue: IssueLike; createdAt: number }> = [];
	for (const node of nodes) {
		if (isArchived(node.archivedAt)) continue;

		const issue = await resolveAttachmentIssue(node, client);
		if (!issue) continue;
		if (isArchived(issue.archivedAt)) continue;

		const createdAt = node.createdAt
			? typeof node.createdAt === "string"
				? Date.parse(node.createdAt)
				: node.createdAt.getTime()
			: Number.POSITIVE_INFINITY;

		liveHits.push({ node, issue, createdAt });
	}

	if (liveHits.length === 1) {
		const { issue } = liveHits[0]!;
		trace("linear.issue.upsert.dedupe_hit", {
			issueId: issue.id,
			identifier: issue.identifier,
			slackPermalink,
		});
		return { issue: toIssueRef(issue), created: false };
	}

	if (liveHits.length > 1) {
		liveHits.sort((a, b) => a.createdAt - b.createdAt);
		const chosen = liveHits[0]!.issue;
		trace("linear.issue.upsert.multiple_matches", {
			slackPermalink,
			chosen: chosen.id,
			candidates: liveHits.map((h) => h.issue.id),
		});
		return { issue: toIssueRef(chosen), created: false };
	}

	// Cold miss — create new issue with permalink baked into the description.
	const augmentedDescription =
		(input.description ?? "") +
		`\n\n---\nSource Slack thread: ${slackPermalink}` +
		`\nCovent Pi request: ${slackRequestId}`;

	const issue = await createIssue(client, cache, {
		teamId: input.teamId,
		projectId: input.projectId,
		stateId: input.stateId,
		stateName: input.stateName,
		title: input.title,
		description: augmentedDescription,
		labelIds: input.labelIds,
		assigneeId: input.assigneeId,
		priority: input.priority,
	});

	try {
		await upsertAttachment(client, {
			issueId: issue.id,
			url: slackPermalink,
			title: "Slack thread",
			subtitle: `Covent Pi request ${slackRequestId}`,
		});
	} catch (error) {
		// PRD principle 4 — idempotency: without the attachment, a retry of this
		// Slack thread would create a duplicate issue. Surface the failure loudly
		// rather than silently returning a half-formed result.
		trace("linear.issue.upsert.attachment_failed", {
			issueId: issue.id,
			url: slackPermalink,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}

	trace("linear.issue.upsert.created", {
		issueId: issue.id,
		identifier: issue.identifier,
		slackPermalink,
	});

	return { issue, created: true };
}

export interface IssuesApi {
	find(idOrIdentifier: string): Promise<IssueRef | null>;
	create(input: IssueCreateInput): Promise<IssueRef>;
	upsertFromSlack(input: IssueUpsertFromSlackInput): Promise<IssueUpsertFromSlackResult>;
	transition(issueId: string, input: IssueTransitionInput): Promise<IssueRef>;
}
