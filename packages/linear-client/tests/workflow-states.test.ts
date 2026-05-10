import { test } from "node:test";
import assert from "node:assert/strict";

import { WorkflowStateCache, type WorkflowStatesSdkLike } from "../src/workflow-states.ts";

interface FakeState {
	id: string;
	name: string;
	type: string;
}

function makeSdk(statesByTeam: Record<string, FakeState[]>) {
	const calls: Array<{ teamId: string | undefined }> = [];
	const sdk: WorkflowStatesSdkLike = {
		async workflowStates(args) {
			const teamId = args?.filter?.team?.id?.eq;
			calls.push({ teamId });
			const nodes = teamId !== undefined ? (statesByTeam[teamId] ?? []) : [];
			return { nodes };
		},
	};
	return { sdk, calls };
}

test("resolve hits the SDK once on cold miss, then serves from cache", async () => {
	const { sdk, calls } = makeSdk({
		"team-a": [
			{ id: "s-backlog", name: "Backlog", type: "backlog" },
			{ id: "s-inprog", name: "In Progress", type: "started" },
		],
	});

	const cache = new WorkflowStateCache();

	const a = await cache.resolve(sdk, { teamId: "team-a", name: "Backlog" });
	const b = await cache.resolve(sdk, { teamId: "team-a", name: "In Progress" });
	const c = await cache.resolve(sdk, { teamId: "team-a", type: "started" });

	assert.equal(a, "s-backlog");
	assert.equal(b, "s-inprog");
	assert.equal(c, "s-inprog");
	assert.equal(calls.length, 1, "expected only one SDK fetch (cold miss)");
});

test("resolve is case-insensitive on name and type", async () => {
	const { sdk } = makeSdk({
		"team-a": [{ id: "s-backlog", name: "Backlog", type: "backlog" }],
	});
	const cache = new WorkflowStateCache();

	assert.equal(await cache.resolve(sdk, { teamId: "team-a", name: "BACKLOG" }), "s-backlog");
	assert.equal(await cache.resolve(sdk, { teamId: "team-a", name: "backlog" }), "s-backlog");
	assert.equal(await cache.resolve(sdk, { teamId: "team-a", type: "BACKLOG" }), "s-backlog");
});

test("resolve prefers name over type when both are supplied", async () => {
	const { sdk } = makeSdk({
		"team-a": [
			{ id: "s-todo", name: "Todo", type: "unstarted" },
			{ id: "s-progress", name: "In Progress", type: "started" },
		],
	});
	const cache = new WorkflowStateCache();

	// Name resolves "In Progress" → s-progress even though type matches Todo's "unstarted".
	const id = await cache.resolve(sdk, { teamId: "team-a", name: "In Progress", type: "unstarted" });
	assert.equal(id, "s-progress");
});

test("resolve throws a descriptive error when nothing matches", async () => {
	const { sdk } = makeSdk({
		"team-a": [{ id: "s1", name: "Backlog", type: "backlog" }],
	});
	const cache = new WorkflowStateCache();

	await assert.rejects(
		cache.resolve(sdk, { teamId: "team-a", name: "Nope" }),
		/workflow state not found.*team-a/,
	);
});

test("resolve requires teamId and at least one of name/type", async () => {
	const { sdk } = makeSdk({});
	const cache = new WorkflowStateCache();

	await assert.rejects(
		cache.resolve(sdk, { teamId: "", name: "Backlog" }),
		/teamId is required/,
	);
	await assert.rejects(
		cache.resolve(sdk, { teamId: "team-a" }),
		/at least one of name or type/,
	);
});

test("invalidate forces a refetch for that team only", async () => {
	const { sdk, calls } = makeSdk({
		"team-a": [{ id: "s1", name: "Backlog", type: "backlog" }],
		"team-b": [{ id: "s2", name: "Backlog", type: "backlog" }],
	});
	const cache = new WorkflowStateCache();

	await cache.resolve(sdk, { teamId: "team-a", name: "Backlog" });
	await cache.resolve(sdk, { teamId: "team-b", name: "Backlog" });
	assert.equal(calls.length, 2);

	cache.invalidate("team-a");

	await cache.resolve(sdk, { teamId: "team-a", name: "Backlog" });
	await cache.resolve(sdk, { teamId: "team-b", name: "Backlog" });
	assert.equal(calls.length, 3, "team-b should still be cached");
});

test("invalidate() with no arg clears everything", async () => {
	const { sdk, calls } = makeSdk({
		"team-a": [{ id: "s1", name: "Backlog", type: "backlog" }],
	});
	const cache = new WorkflowStateCache();

	await cache.resolve(sdk, { teamId: "team-a", name: "Backlog" });
	cache.invalidate();
	await cache.resolve(sdk, { teamId: "team-a", name: "Backlog" });

	assert.equal(calls.length, 2);
});
