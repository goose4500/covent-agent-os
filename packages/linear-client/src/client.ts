// Client facade — wraps @linear/sdk's LinearClient and exposes our typed
// module groups (issues, comments, attachments, workflow-states, webhooks).
//
// PRD principle 1: "All Linear calls go through packages/linear-client. No
// caller re-implements auth, retries, identifier resolution, or error
// handling." Principle 2: "Use @linear/sdk. … Our package is a thin facade
// adding only what the SDK lacks."
//
// PRD principle 3 binding: header is bare `Authorization: <key>` (no Bearer).
// The SDK's `apiKey` option produces exactly this header.

import { LinearClient } from "@linear/sdk";

import {
	upsertAttachment,
	type AttachmentRef,
	type AttachmentsApi,
	type AttachmentsSdkLike,
	type AttachmentUpsertInput,
} from "./attachments.ts";
import { postComment, type CommentRef, type CommentsApi, type CommentsSdkLike } from "./comments.ts";
import {
	createIssue,
	findIssue,
	transitionIssue,
	upsertFromSlack,
	type IssueCreateInput,
	type IssueRef,
	type IssuesApi,
	type IssueTransitionInput,
	type IssueUpsertFromSlackInput,
	type IssueUpsertFromSlackResult,
	type IssuesSdkLike,
} from "./issues.ts";
import { withRateLimitGuard, type RateLimitGuardOptions } from "./rate-limit.ts";
import { setTraceFn, type TraceFn } from "./trace.ts";
import {
	verifyWebhook,
	type VerifiedWebhookEvent,
	type VerifyWebhookOptions,
	type WebhooksApi,
} from "./webhooks.ts";
import {
	WorkflowStateCache,
	type ResolveWorkflowStateInput,
	type WorkflowStatesApi,
} from "./workflow-states.ts";

export interface CreateLinearClientOptions {
	apiKey: string;
	/** Override the Linear GraphQL endpoint. SDK default is production. */
	baseUrl?: string;
}

export interface LinearClientFacade {
	/**
	 * Underlying `@linear/sdk` client. Treat as an escape hatch — prefer the
	 * typed sub-APIs. The facade names it `sdk` (per W-A charter).
	 */
	readonly sdk: LinearClient;
	readonly issues: IssuesApi;
	readonly comments: CommentsApi;
	readonly attachments: AttachmentsApi;
	readonly workflowStates: WorkflowStatesApi;
	readonly webhooks: WebhooksApi;
	/**
	 * Run an arbitrary thunk through the rate-limit guard. Useful for callers
	 * that issue raw SDK calls and want our typed RateLimitedError.
	 */
	withRateLimitGuard<T>(fn: () => Promise<T>, opts?: RateLimitGuardOptions): Promise<T>;
	/** Swap in a trace adapter at runtime. Returns the previous adapter. */
	setTrace(fn: TraceFn | null): TraceFn;
}

/**
 * Build the SDK-shaped object our internal modules consume. We treat the
 * `LinearClient` directly as the SDK surface — it already exposes
 * `issue/createIssue/updateIssue/createComment/createAttachment/`
 * `attachmentsForURL/workflowStates` with the right signatures.
 */
function asIssuesSdk(client: LinearClient): IssuesSdkLike {
	const sdk = client as unknown as IssuesSdkLike;
	return sdk;
}

function asCommentsSdk(client: LinearClient): CommentsSdkLike {
	return client as unknown as CommentsSdkLike;
}

function asAttachmentsSdk(client: LinearClient): AttachmentsSdkLike {
	return client as unknown as AttachmentsSdkLike;
}

/**
 * Construct the facade. The caller supplies the API key (PRD principle 3);
 * the SDK's `apiKey` produces the bare `Authorization: <key>` header Linear
 * expects.
 */
export function createLinearClient(opts: CreateLinearClientOptions): LinearClientFacade {
	if (!opts || typeof opts.apiKey !== "string" || opts.apiKey.length === 0) {
		throw new Error("createLinearClient: apiKey is required");
	}

	const sdkOpts: { apiKey: string; apiUrl?: string } = { apiKey: opts.apiKey };
	if (opts.baseUrl) sdkOpts.apiUrl = opts.baseUrl;
	const sdk = new LinearClient(sdkOpts);

	const issuesSdk = asIssuesSdk(sdk);
	const commentsSdk = asCommentsSdk(sdk);
	const attachmentsSdk = asAttachmentsSdk(sdk);
	const stateCache = new WorkflowStateCache();

	const issues: IssuesApi = {
		find: (idOrIdentifier) =>
			withRateLimitGuard(() => findIssue(issuesSdk, idOrIdentifier)),
		create: (input: IssueCreateInput): Promise<IssueRef> =>
			withRateLimitGuard(() => createIssue(issuesSdk, stateCache, input)),
		upsertFromSlack: (input: IssueUpsertFromSlackInput): Promise<IssueUpsertFromSlackResult> =>
			withRateLimitGuard(() => upsertFromSlack(issuesSdk, stateCache, input)),
		transition: (issueId: string, input: IssueTransitionInput): Promise<IssueRef> =>
			withRateLimitGuard(() => transitionIssue(issuesSdk, stateCache, issueId, input)),
	};

	const comments: CommentsApi = {
		post: (issueId: string, body: string): Promise<CommentRef> =>
			withRateLimitGuard(() => postComment(commentsSdk, issueId, body)),
	};

	const attachments: AttachmentsApi = {
		upsert: (input: AttachmentUpsertInput): Promise<AttachmentRef> =>
			withRateLimitGuard(() => upsertAttachment(attachmentsSdk, input)),
	};

	const workflowStates: WorkflowStatesApi = {
		resolve: (input: ResolveWorkflowStateInput) =>
			withRateLimitGuard(() => stateCache.resolve(issuesSdk, input)),
		invalidate: (teamId?: string) => stateCache.invalidate(teamId),
	};

	const webhooks: WebhooksApi = {
		// The facade-level `verify` does not own the secret; callers (W-B) pass
		// the secret on each call so rotation can be driven by env vars without
		// re-instantiating the facade.
		verify: (verifyOpts) => {
			if (typeof verifyOpts.secret !== "string" || verifyOpts.secret.length === 0) {
				throw new Error("webhooks.verify: secret is required");
			}
			return verifyWebhook(verifyOpts as VerifyWebhookOptions);
		},
	};

	return {
		sdk,
		issues,
		comments,
		attachments,
		workflowStates,
		webhooks,
		withRateLimitGuard,
		setTrace: (fn) => setTraceFn(fn),
	};
}

// Re-export the verified-event type for callers (W-B/W-C) without forcing
// them to import from `./webhooks.ts` directly.
export type { VerifiedWebhookEvent };
