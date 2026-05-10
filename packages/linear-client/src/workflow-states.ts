// Workflow states — resolve by (team, name | type), cached per-team.
//
// Replaces the current hardcoded `LINEAR_STATE_ID` pattern. See PRD principle 6.
//
// Strategy: on cold miss, fetch the team's workflowStates connection once and
// memoize a `Map<lookupKey, stateId>` per team for process lifetime. Lookup
// keys are lowercase; we record both the state's name and its type so the
// same fetch services name-based and type-based queries.

import type { WorkflowState } from "@linear/sdk";

import { trace } from "./trace.ts";

export type WorkflowStateType =
	| "triage"
	| "backlog"
	| "unstarted"
	| "started"
	| "completed"
	| "canceled"
	| "duplicate"
	| string;

export interface ResolveWorkflowStateInput {
	teamId: string;
	name?: string;
	type?: WorkflowStateType;
}

interface TeamStateRecord {
	byName: Map<string, string>;
	byType: Map<string, string>;
}

/**
 * Minimal SDK surface needed by the resolver. We accept anything with a
 * `workflowStates({ filter })` connection so callers and tests can pass a
 * fake.
 */
export interface WorkflowStatesSdkLike {
	workflowStates(args?: {
		filter?: { team?: { id?: { eq?: string } } };
		first?: number;
	}): Promise<{
		nodes: Array<Pick<WorkflowState, "id" | "name" | "type"> & { teamId?: string }>;
	}>;
}

/**
 * The facade-bound API surface for workflow state resolution. The client
 * facade (commit 6) constructs a `WorkflowStateCache` and exposes a binding
 * that implements this interface so callers do not pass the SDK explicitly.
 */
export interface WorkflowStatesApi {
	resolve(input: ResolveWorkflowStateInput): Promise<string>;
	invalidate(teamId?: string): void;
}

/**
 * Per-team workflow-state resolver. One instance is held by each
 * `LinearClientFacade`. Tests instantiate their own.
 */
export class WorkflowStateCache {
	private readonly cache = new Map<string, TeamStateRecord>();

	/**
	 * Resolve a state id for a team by `name` (preferred) or `type`. Matching
	 * is case-insensitive on both sides. Throws if no match is found.
	 */
	async resolve(
		client: WorkflowStatesSdkLike,
		input: ResolveWorkflowStateInput,
	): Promise<string> {
		const { teamId, name, type } = input;
		if (!teamId) throw new Error("workflow state resolve: teamId is required");
		if (!name && !type) {
			throw new Error("workflow state resolve: at least one of name or type is required");
		}

		const record = await this.loadTeam(client, teamId);
		const lookup = this.pick(record, name, type);
		if (lookup) return lookup;

		throw new Error(
			`workflow state not found: ${JSON.stringify({ name, type })} in team ${teamId}`,
		);
	}

	/** Drop cached entries for a single team, or all teams when teamId is omitted. */
	invalidate(teamId?: string): void {
		if (teamId === undefined) this.cache.clear();
		else this.cache.delete(teamId);
	}

	private pick(
		record: TeamStateRecord,
		name: string | undefined,
		type: string | undefined,
	): string | undefined {
		if (name) {
			const hit = record.byName.get(name.toLowerCase());
			if (hit) return hit;
		}
		if (type) {
			const hit = record.byType.get(type.toLowerCase());
			if (hit) return hit;
		}
		return undefined;
	}

	private async loadTeam(
		client: WorkflowStatesSdkLike,
		teamId: string,
	): Promise<TeamStateRecord> {
		const existing = this.cache.get(teamId);
		if (existing) {
			trace("linear.workflow_state.resolve.cache_hit", { teamId });
			return existing;
		}

		trace("linear.workflow_state.resolve.cache_miss", { teamId });
		const conn = await client.workflowStates({
			filter: { team: { id: { eq: teamId } } },
			first: 100,
		});

		const record: TeamStateRecord = {
			byName: new Map(),
			byType: new Map(),
		};
		for (const node of conn.nodes) {
			record.byName.set(node.name.toLowerCase(), node.id);
			// The first state of a given type wins; states like "Backlog" and
			// "Triage" are unique by name anyway, so the type collision case is
			// rare. Resolve-by-name is the recommended path.
			if (!record.byType.has(node.type.toLowerCase())) {
				record.byType.set(node.type.toLowerCase(), node.id);
			}
		}
		this.cache.set(teamId, record);
		return record;
	}
}
