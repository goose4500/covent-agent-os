// Workflow states — resolve by (team, name | type), cached per-team.
//
// Replaces the current hardcoded `LINEAR_STATE_ID` pattern. See PRD principle 6.

export type WorkflowStateType =
	| "triage"
	| "backlog"
	| "unstarted"
	| "started"
	| "completed"
	| "canceled";

export interface WorkflowStateRef {
	id: string;
	name: string;
	type: WorkflowStateType | string;
	teamId: string;
}

export interface ResolveWorkflowStateInput {
	teamId: string;
	name?: string;
	type?: WorkflowStateType | string;
}

export interface WorkflowStatesApi {
	resolve(input: ResolveWorkflowStateInput): Promise<WorkflowStateRef>;
}

export function resolve(_input: ResolveWorkflowStateInput): Promise<WorkflowStateRef> {
	throw new Error("not implemented");
}
