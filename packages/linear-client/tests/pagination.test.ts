import { test } from "node:test";
import assert from "node:assert/strict";

import { paginate, type ConnectionLike } from "../src/pagination.ts";

function makePager<T>(pages: ConnectionLike<T>[]): {
	fn: (after?: string) => Promise<ConnectionLike<T>>;
	calls: Array<string | undefined>;
} {
	const calls: Array<string | undefined> = [];
	let i = 0;
	return {
		calls,
		fn: async (after) => {
			calls.push(after);
			if (i >= pages.length) throw new Error("over-paged");
			return pages[i++]!;
		},
	};
}

test("paginate walks across multiple pages", async () => {
	const pager = makePager<number>([
		{ nodes: [1, 2, 3], pageInfo: { hasNextPage: true, endCursor: "c1" } },
		{ nodes: [4, 5], pageInfo: { hasNextPage: false, endCursor: null } },
	]);

	const out: number[] = [];
	for await (const n of paginate(pager.fn)) out.push(n);

	assert.deepEqual(out, [1, 2, 3, 4, 5]);
	assert.deepEqual(pager.calls, [undefined, "c1"]);
});

test("paginate respects max and stops early without fetching extra pages", async () => {
	const pager = makePager<number>([
		{ nodes: [1, 2, 3], pageInfo: { hasNextPage: true, endCursor: "c1" } },
		{ nodes: [4, 5, 6], pageInfo: { hasNextPage: true, endCursor: "c2" } },
	]);

	const out: number[] = [];
	for await (const n of paginate(pager.fn, { max: 4 })) out.push(n);

	assert.deepEqual(out, [1, 2, 3, 4]);
	// The second page was needed for node 4 but we should not have requested page 3.
	assert.equal(pager.calls.length, 2);
});

test("paginate yields nothing when max is 0", async () => {
	const pager = makePager<number>([
		{ nodes: [1], pageInfo: { hasNextPage: false, endCursor: null } },
	]);

	const out: number[] = [];
	for await (const n of paginate(pager.fn, { max: 0 })) out.push(n);

	assert.deepEqual(out, []);
	assert.equal(pager.calls.length, 0);
});

test("paginate stops cleanly when hasNextPage is false on the first page", async () => {
	const pager = makePager<string>([
		{ nodes: ["a"], pageInfo: { hasNextPage: false, endCursor: null } },
	]);

	const out: string[] = [];
	for await (const v of paginate(pager.fn)) out.push(v);

	assert.deepEqual(out, ["a"]);
	assert.equal(pager.calls.length, 1);
});
