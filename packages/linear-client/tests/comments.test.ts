import { test } from "node:test";
import assert from "node:assert/strict";

import { postComment, type CommentsSdkLike } from "../src/comments.ts";
import { LinearWriteError } from "../src/errors.ts";

test("postComment forwards issueId and body and returns the comment ref", async () => {
	const calls: Array<{ issueId: string; body: string }> = [];
	const sdk: CommentsSdkLike = {
		async createComment(input) {
			calls.push(input);
			return {
				success: true,
				comment: { id: "c1", body: input.body, url: "https://linear.app/c/c1" },
			};
		},
	};

	const ref = await postComment(sdk, "issue-1", "hello");
	assert.deepEqual(calls, [{ issueId: "issue-1", body: "hello" }]);
	assert.equal(ref.id, "c1");
	assert.equal(ref.body, "hello");
	assert.equal(ref.issueId, "issue-1");
	assert.equal(ref.url, "https://linear.app/c/c1");
});

test("postComment supports lazy `comment` promises (the SDK's default)", async () => {
	const sdk: CommentsSdkLike = {
		async createComment() {
			return {
				success: true,
				comment: Promise.resolve({ id: "c2", body: "hi" }),
			};
		},
	};
	const ref = await postComment(sdk, "issue-1", "hi");
	assert.equal(ref.id, "c2");
});

test("postComment throws LinearWriteError on success: false", async () => {
	const sdk: CommentsSdkLike = {
		async createComment() {
			return { success: false };
		},
	};
	await assert.rejects(
		postComment(sdk, "issue-1", "x"),
		(err: unknown) => {
			assert.ok(err instanceof LinearWriteError);
			assert.equal(err.operation, "createComment");
			return true;
		},
	);
});
