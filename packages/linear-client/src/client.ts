// Client facade — wraps @linear/sdk's LinearClient and exposes our typed
// module groups (issues, comments, attachments, workflow-states, webhooks).
// W-A wires the real implementations; this file establishes the shape so the
// rest of the package can compile and tests can be authored.

import type { LinearClient } from "@linear/sdk";

import type { IssuesApi } from "./issues.js";
import type { CommentsApi } from "./comments.js";
import type { AttachmentsApi } from "./attachments.js";
import type { WorkflowStatesApi } from "./workflow-states.js";
import type { WebhooksApi } from "./webhooks.js";

export interface CreateLinearClientOptions {
	apiKey: string;
	baseUrl?: string;
}

export interface LinearClientFacade {
	/** Underlying @linear/sdk client. Internal use; callers should prefer the typed sub-APIs. */
	readonly raw: LinearClient;
	readonly issues: IssuesApi;
	readonly comments: CommentsApi;
	readonly attachments: AttachmentsApi;
	readonly workflowStates: WorkflowStatesApi;
	readonly webhooks: WebhooksApi;
}

export function createLinearClient(_opts: CreateLinearClientOptions): LinearClientFacade {
	throw new Error("not implemented");
}
