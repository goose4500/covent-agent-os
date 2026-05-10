import { test } from "node:test";
import assert from "node:assert/strict";

import {
	createIssue,
	findIssue,
	transitionIssue,
	upsertFromSlack,
	type AttachmentForUrlNode,
	type IssueLike,
	type IssuesSdkLike,
} from "../src/issues.ts";
import { LinearWriteError } from "../src/errors.ts";
import { setTraceFn } from "../src/trace.ts";
import { WorkflowStateCache } from "../src/workflow-states.ts";

type TraceEvent = { event: string; data?: Record<string, unknown> };

function captureTrace(): { events: TraceEvent[]; restore: () => void } {
	const events: TraceEvent[] = [];
	const prev = setTraceFn((event, data) => {
		events.push({ event, data });
	});
	return { events, restore: () => setTraceFn(prev) };
}

interface FakeSdkConfig {
	statesByTeam?: Record<string, Array<{ id: string; name: string; type: string }>>;
	attachmentsForUrl?: Record<string, AttachmentForUrlNode[]>;
	issuesById?: Record<string, IssueLike>;
	createIssueResult?: () => IssueLike;
	createAttachmentResult?: () => { id: string; url: string; title: string };
	updateIssueResult?: () => IssueLike;
}

function makeSdk(cfg: FakeSdkConfig = {}) {
	const calls = {
		createIssue: [] as Array<Record<string, unknown>>,
		createAttachment: [] as Array<Record<string, unknown>>,
		updateIssue: [] as Array<{ id: string; input: Record<string, unknown> }>,
		issue: [] as string[],
		attachmentsForURL: [] as string[],
	};
	const sdk: IssuesSdkLike = {
		async workflowStates(args) {
			const teamId = args?.filter?.team?.id?.eq;
			const states = (teamId && cfg.statesByTeam?.[teamId]) || [];
			return { nodes: states };
		},
		async issue(id) {
			calls.issue.push(id);
			const found = cfg.issuesById?.[id];
			if (!found) throw new Error(`no fake issue ${id}`);
			return found;
		},
		async createIssue(input) {
			calls.createIssue.push(input as Record<string, unknown>);
			const issue =
				cfg.createIssueResult?.() ??
				({
					id: "issue-new",
					identifier: "FE-99",
					title: input.title,
					url: "https://linear.app/test/issue/FE-99",
				} satisfies IssueLike);
			return { success: true, issue };
		},
		async updateIssue(id, input) {
			calls.updateIssue.push({ id, input: input as Record<string, unknown> });
			const issue =
				cfg.updateIssueResult?.() ??
				({
					id,
					identifier: "FE-1",
					title: "title",
					url: "https://linear.app/test/issue/FE-1",
				} satisfies IssueLike);
			return { success: true, issue };
		},
		async createAttachment(input) {
			calls.createAttachment.push(input as Record<string, unknown>);
			const attachment =
				cfg.createAttachmentResult?.() ??
				({ id: "att-1", url: input.url, title: input.title });
			return { success: true, attachment };
		},
		async attachmentsForURL(url) {
			calls.attachmentsForURL.push(url);
			return { nodes: cfg.attachmentsForUrl?.[url] ?? [] };
		},
	};
	return { sdk, calls };
}

test("findIssue returns ref on success, null on miss", async () => {
	const { sdk } = makeSdk({
		issuesById: {
			"FE-1": {
				id: "uuid-1",
				identifier: "FE-1",
				title: "T",
				url: "https://linear.app/test/issue/FE-1",
			},
		},
	});

	const hit = await findIssue(sdk, "FE-1");
	assert.deepEqual(hit, {
		id: "uuid-1",
		identifier: "FE-1",
		title: "T",
		url: "https://linear.app/test/issue/FE-1",
	});

	const miss = await findIssue(sdk, "BOGUS-999");
	assert.equal(miss, null);
});

test("createIssue resolves stateName via the WorkflowStateCache", async () => {
	const { sdk, calls } = makeSdk({
		statesByTeam: {
			"team-a": [{ id: "s-back", name: "Backlog", type: "backlog" }],
		},
	});
	const cache = new WorkflowStateCache();

	await createIssue(sdk, cache, {
		teamId: "team-a",
		stateName: "Backlog",
		title: "Hello",
	});

	assert.equal(calls.createIssue.length, 1);
	assert.equal(calls.createIssue[0]?.stateId, "s-back");
	assert.equal(calls.createIssue[0]?.title, "Hello");
});

test("createIssue throws LinearWriteError on success: false", async () => {
	const sdk: IssuesSdkLike = {
		async workflowStates() {
			return { nodes: [] };
		},
		async issue() {
			throw new Error("unused");
		},
		async createIssue() {
			return { success: false };
		},
		async updateIssue() {
			return { success: false };
		},
		async createAttachment() {
			return { success: false };
		},
		async attachmentsForURL() {
			return { nodes: [] };
		},
	};
	await assert.rejects(
		createIssue(sdk, new WorkflowStateCache(), {
			teamId: "team-a",
			title: "Hello",
		}),
		LinearWriteError,
	);
});

test("transitionIssue resolves stateName and calls updateIssue", async () => {
	const { sdk, calls } = makeSdk({
		statesByTeam: {
			"team-a": [{ id: "s-done", name: "Done", type: "completed" }],
		},
		issuesById: {
			"issue-1": {
				id: "issue-1",
				identifier: "FE-1",
				title: "T",
				url: "u",
				teamId: "team-a",
			},
		},
	});
	const cache = new WorkflowStateCache();

	await transitionIssue(sdk, cache, "issue-1", { stateName: "Done" });

	assert.equal(calls.updateIssue.length, 1);
	assert.equal(calls.updateIssue[0]?.input.stateId, "s-done");
});

test("transitionIssue derives teamId from issue when omitted", async () => {
	const { sdk, calls } = makeSdk({
		statesByTeam: {
			"team-b": [{ id: "s-x", name: "Triage", type: "triage" }],
		},
		issuesById: {
			"issue-2": {
				id: "issue-2",
				identifier: "X-2",
				title: "T",
				url: "u",
				team: Promise.resolve({ id: "team-b" }),
			},
		},
	});
	const cache = new WorkflowStateCache();

	await transitionIssue(sdk, cache, "issue-2", { stateName: "Triage" });
	assert.equal(calls.updateIssue[0]?.input.stateId, "s-x");
});

// ---- upsertFromSlack ----

const PERMA = "https://acme.slack.com/archives/C1/p9999";

test("upsertFromSlack: cold miss creates issue + attachment + returns created=true", async () => {
	const { sdk, calls } = makeSdk({
		statesByTeam: {
			"team-a": [{ id: "s-back", name: "Backlog", type: "backlog" }],
		},
	});
	const cache = new WorkflowStateCache();

	const out = await upsertFromSlack(sdk, cache, {
		teamId: "team-a",
		stateName: "Backlog",
		title: "Build the thing",
		description: "Body",
		slackPermalink: PERMA,
		slackRequestId: "req-7",
	});

	assert.equal(out.created, true);
	assert.equal(calls.createIssue.length, 1);
	assert.equal(calls.createAttachment.length, 1);
	const desc = calls.createIssue[0]?.description as string;
	assert.match(desc, /Source Slack thread: https:\/\/acme.slack.com/);
	assert.match(desc, /Covent Pi request: req-7/);
	assert.equal(calls.createAttachment[0]?.url, PERMA);
	assert.equal(calls.createAttachment[0]?.title, "Slack thread");
});

test("upsertFromSlack: dedupe hit returns existing issue and skips create", async () => {
	const existing: IssueLike = {
		id: "issue-prior",
		identifier: "FE-7",
		title: "Prior",
		url: "https://linear.app/test/issue/FE-7",
	};
	const { sdk, calls } = makeSdk({
		attachmentsForUrl: {
			[PERMA]: [
				{
					id: "att-1",
					url: PERMA,
					createdAt: new Date("2025-01-01T00:00:00Z"),
					issue: existing,
				},
			],
		},
	});

	const out = await upsertFromSlack(sdk, new WorkflowStateCache(), {
		teamId: "team-a",
		title: "ignored",
		slackPermalink: PERMA,
		slackRequestId: "req-1",
	});

	assert.equal(out.created, false);
	assert.equal(out.issue.id, "issue-prior");
	assert.equal(out.issue.identifier, "FE-7");
	assert.equal(calls.createIssue.length, 0);
	assert.equal(calls.createAttachment.length, 0);
});

test("upsertFromSlack: multiple matches → picks oldest by createdAt", async () => {
	const older: IssueLike = {
		id: "issue-older",
		identifier: "FE-1",
		title: "Older",
		url: "https://linear.app/test/issue/FE-1",
	};
	const newer: IssueLike = {
		id: "issue-newer",
		identifier: "FE-2",
		title: "Newer",
		url: "https://linear.app/test/issue/FE-2",
	};
	const { sdk } = makeSdk({
		attachmentsForUrl: {
			[PERMA]: [
				{
					id: "att-new",
					url: PERMA,
					createdAt: "2025-03-01T00:00:00Z",
					issue: newer,
				},
				{
					id: "att-old",
					url: PERMA,
					createdAt: "2025-01-01T00:00:00Z",
					issue: older,
				},
			],
		},
	});

	const out = await upsertFromSlack(sdk, new WorkflowStateCache(), {
		teamId: "team-a",
		title: "x",
		slackPermalink: PERMA,
		slackRequestId: "req-2",
	});

	assert.equal(out.created, false);
	assert.equal(out.issue.id, "issue-older");
});

test("upsertFromSlack: archived attachments are ignored and a new issue is created", async () => {
	const stale: IssueLike = {
		id: "issue-stale",
		identifier: "FE-9",
		title: "Stale",
		url: "u",
		archivedAt: new Date("2025-02-01"),
	};
	const { sdk, calls } = makeSdk({
		statesByTeam: {
			"team-a": [{ id: "s-back", name: "Backlog", type: "backlog" }],
		},
		attachmentsForUrl: {
			[PERMA]: [
				{
					id: "att-stale",
					url: PERMA,
					createdAt: new Date("2025-02-01"),
					issue: stale,
				},
			],
		},
	});

	const out = await upsertFromSlack(sdk, new WorkflowStateCache(), {
		teamId: "team-a",
		stateName: "Backlog",
		title: "Fresh",
		slackPermalink: PERMA,
		slackRequestId: "req-3",
	});

	assert.equal(out.created, true);
	assert.equal(calls.createIssue.length, 1);
});

test("upsertFromSlack: archived-by-attachment is ignored even if issue not archived", async () => {
	const live: IssueLike = {
		id: "issue-live",
		identifier: "FE-10",
		title: "Live",
		url: "u",
	};
	const { sdk, calls } = makeSdk({
		statesByTeam: {
			"team-a": [{ id: "s-back", name: "Backlog", type: "backlog" }],
		},
		attachmentsForUrl: {
			[PERMA]: [
				{
					id: "att",
					url: PERMA,
					archivedAt: new Date(),
					createdAt: new Date(),
					issue: live,
				},
			],
		},
	});

	const out = await upsertFromSlack(sdk, new WorkflowStateCache(), {
		teamId: "team-a",
		stateName: "Backlog",
		title: "Fresh",
		slackPermalink: PERMA,
		slackRequestId: "req-4",
	});

	assert.equal(out.created, true);
	assert.equal(calls.createIssue.length, 1);
});

test("upsertFromSlack: re-run idempotency — second call dedupes to the first issue", async () => {
	// Simulate the real Linear server: after a successful createAttachment(url=...),
	// subsequent attachmentsForURL(url) returns the same attachment.
	const created: IssueLike = {
		id: "issue-new",
		identifier: "FE-99",
		title: "Build the thing",
		url: "https://linear.app/test/issue/FE-99",
	};

	const nodes: AttachmentForUrlNode[] = [];
	const sdk: IssuesSdkLike = {
		async workflowStates(args) {
			const teamId = args?.filter?.team?.id?.eq;
			if (teamId !== "team-a") return { nodes: [] };
			return { nodes: [{ id: "s-back", name: "Backlog", type: "backlog" }] };
		},
		async issue() {
			throw new Error("unused");
		},
		async createIssue() {
			return { success: true, issue: created };
		},
		async updateIssue() {
			return { success: false };
		},
		async createAttachment(input) {
			const att = { id: `att-${nodes.length + 1}`, url: input.url, title: input.title };
			// Mimic Linear: re-creates against (issueId,url) upsert in place.
			const existing = nodes.find((n) => n.url === input.url && n.issueId === input.issueId);
			if (!existing) {
				nodes.push({
					id: att.id,
					url: input.url,
					createdAt: new Date(),
					issue: created,
					issueId: input.issueId,
				});
			}
			return { success: true, attachment: att };
		},
		async attachmentsForURL(url) {
			return { nodes: nodes.filter((n) => n.url === url) };
		},
	};

	const cache = new WorkflowStateCache();
	const args = {
		teamId: "team-a",
		stateName: "Backlog",
		title: "Build the thing",
		slackPermalink: PERMA,
		slackRequestId: "req-7",
	};
	const a = await upsertFromSlack(sdk, cache, args);
	const b = await upsertFromSlack(sdk, cache, args);
	const c = await upsertFromSlack(sdk, cache, args);

	assert.equal(a.created, true);
	assert.equal(b.created, false);
	assert.equal(c.created, false);
	assert.equal(a.issue.id, b.issue.id);
	assert.equal(b.issue.id, c.issue.id);
});

test("upsertFromSlack: createAttachment failure re-throws and emits attachment_failed trace", async () => {
	const created: IssueLike = {
		id: "issue-orphan",
		identifier: "FE-42",
		title: "Build the thing",
		url: "https://linear.app/test/issue/FE-42",
	};
	const sdk: IssuesSdkLike = {
		async workflowStates(args) {
			const teamId = args?.filter?.team?.id?.eq;
			if (teamId !== "team-a") return { nodes: [] };
			return { nodes: [{ id: "s-back", name: "Backlog", type: "backlog" }] };
		},
		async issue() {
			throw new Error("unused");
		},
		async createIssue() {
			return { success: true, issue: created };
		},
		async updateIssue() {
			return { success: false };
		},
		async createAttachment() {
			throw new Error("linear blip");
		},
		async attachmentsForURL() {
			return { nodes: [] };
		},
	};

	const { events, restore } = captureTrace();
	try {
		await assert.rejects(
			upsertFromSlack(sdk, new WorkflowStateCache(), {
				teamId: "team-a",
				stateName: "Backlog",
				title: "Build the thing",
				slackPermalink: PERMA,
				slackRequestId: "req-orphan",
			}),
			/linear blip/,
		);
	} finally {
		restore();
	}

	const failed = events.find((e) => e.event === "linear.issue.upsert.attachment_failed");
	assert.ok(failed, "expected linear.issue.upsert.attachment_failed to be emitted");
	assert.equal(failed?.data?.issueId, "issue-orphan");
	assert.equal(failed?.data?.url, PERMA);
	assert.equal(failed?.data?.error, "linear blip");

	// And the success trace must NOT have fired.
	assert.equal(
		events.find((e) => e.event === "linear.issue.upsert.created"),
		undefined,
	);
});

test("upsertFromSlack: attachment_resolve_failed trace fires when client.issue throws", async () => {
	const sdk: IssuesSdkLike = {
		async workflowStates(args) {
			const teamId = args?.filter?.team?.id?.eq;
			if (teamId !== "team-a") return { nodes: [] };
			return { nodes: [{ id: "s-back", name: "Backlog", type: "backlog" }] };
		},
		async issue(id) {
			throw new Error(`boom for ${id}`);
		},
		async createIssue(input) {
			return {
				success: true,
				issue: {
					id: "issue-new",
					identifier: "FE-99",
					title: input.title,
					url: "https://linear.app/test/issue/FE-99",
				} satisfies IssueLike,
			};
		},
		async updateIssue() {
			return { success: false };
		},
		async createAttachment(input) {
			return { success: true, attachment: { id: "att-1", url: input.url, title: input.title } };
		},
		async attachmentsForURL() {
			// Non-archived attachment with only issueId — forces resolveAttachmentIssue
			// to call client.issue(...), which throws.
			return {
				nodes: [
					{
						id: "att-x",
						url: PERMA,
						createdAt: new Date(),
						issueId: "issue-missing",
					},
				],
			};
		},
	};

	const { events, restore } = captureTrace();
	try {
		// Lookup fails → treated as cold miss → new issue is created.
		const out = await upsertFromSlack(sdk, new WorkflowStateCache(), {
			teamId: "team-a",
			stateName: "Backlog",
			title: "Fresh",
			slackPermalink: PERMA,
			slackRequestId: "req-resolve",
		});
		assert.equal(out.created, true);
	} finally {
		restore();
	}

	const failed = events.find(
		(e) => e.event === "linear.issue.upsert.attachment_resolve_failed",
	);
	assert.ok(failed, "expected linear.issue.upsert.attachment_resolve_failed to be emitted");
	assert.equal(failed?.data?.issueId, "issue-missing");
	assert.equal(failed?.data?.url, PERMA);
	assert.match(String(failed?.data?.error), /boom for issue-missing/);
});

test("findIssue: emits linear.issue.find.failed trace when the SDK throws", async () => {
	const sdk: IssuesSdkLike = {
		async workflowStates() {
			return { nodes: [] };
		},
		async issue(id) {
			throw new Error(`kaboom ${id}`);
		},
		async createIssue() {
			return { success: false };
		},
		async updateIssue() {
			return { success: false };
		},
		async createAttachment() {
			return { success: false };
		},
		async attachmentsForURL() {
			return { nodes: [] };
		},
	};

	const { events, restore } = captureTrace();
	let result: unknown;
	try {
		result = await findIssue(sdk, "FE-404");
	} finally {
		restore();
	}

	assert.equal(result, null);
	const failed = events.find((e) => e.event === "linear.issue.find.failed");
	assert.ok(failed, "expected linear.issue.find.failed to be emitted");
	assert.equal(failed?.data?.input, "FE-404");
	assert.match(String(failed?.data?.error), /kaboom FE-404/);
});
