import { test } from "node:test";
import assert from "node:assert/strict";

import { upsertAttachment, type AttachmentsSdkLike } from "../src/attachments.ts";
import { LinearWriteError } from "../src/errors.ts";

test("upsertAttachment forwards all fields and returns an AttachmentRef", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const sdk: AttachmentsSdkLike = {
		async createAttachment(input) {
			calls.push(input as Record<string, unknown>);
			return {
				success: true,
				attachment: {
					id: "att-1",
					url: input.url,
					title: input.title,
				},
			};
		},
	};

	const ref = await upsertAttachment(sdk, {
		issueId: "issue-1",
		url: "https://example.com/x",
		title: "x",
		subtitle: "sub",
		iconUrl: "https://example.com/icon.png",
		metadata: { k: "v" },
	});

	assert.equal(ref.id, "att-1");
	assert.equal(ref.url, "https://example.com/x");
	assert.equal(ref.issueId, "issue-1");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.iconUrl, "https://example.com/icon.png");
	assert.deepEqual(calls[0]?.metadata, { k: "v" });
});

test("upsertAttachment throws LinearWriteError on success: false", async () => {
	const sdk: AttachmentsSdkLike = {
		async createAttachment() {
			return { success: false };
		},
	};
	await assert.rejects(
		upsertAttachment(sdk, { issueId: "i", url: "u", title: "t" }),
		(err: unknown) => {
			assert.ok(err instanceof LinearWriteError);
			assert.equal(err.operation, "createAttachment");
			return true;
		},
	);
});

test("upsertAttachment throws if SDK returns success but no attachment", async () => {
	const sdk: AttachmentsSdkLike = {
		async createAttachment() {
			return { success: true };
		},
	};
	await assert.rejects(
		upsertAttachment(sdk, { issueId: "i", url: "u", title: "t" }),
		LinearWriteError,
	);
});
