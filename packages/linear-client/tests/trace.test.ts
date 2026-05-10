import { test } from "node:test";
import assert from "node:assert/strict";

import { setTraceFn, trace } from "../src/trace.ts";

test("trace events flow through the injected adapter", () => {
	const seen: Array<[string, Record<string, unknown> | undefined]> = [];
	const prev = setTraceFn((name, data) => {
		seen.push([name, data]);
	});

	try {
		trace("linear.issue.create.requested", { teamId: "t1" });
		trace("linear.issue.create.succeeded");

		assert.equal(seen.length, 2);
		assert.deepEqual(seen[0], ["linear.issue.create.requested", { teamId: "t1" }]);
		assert.deepEqual(seen[1], ["linear.issue.create.succeeded", undefined]);
	} finally {
		setTraceFn(prev);
	}
});

test("setTraceFn(null) resets to a no-op", () => {
	const seen: string[] = [];
	const prev = setTraceFn((name) => {
		seen.push(name);
	});
	trace("first");
	setTraceFn(null);
	trace("second");

	assert.deepEqual(seen, ["first"]);
	setTraceFn(prev);
});

test("trace swallows adapter errors so callers are never broken by logging", () => {
	const prev = setTraceFn(() => {
		throw new Error("logger blew up");
	});
	try {
		assert.doesNotThrow(() => trace("linear.test"));
	} finally {
		setTraceFn(prev);
	}
});

test("setTraceFn returns the previous adapter so callers can restore it", () => {
	const a: () => void = () => {};
	const b: () => void = () => {};
	const original = setTraceFn(a);
	const afterA = setTraceFn(b);
	assert.equal(afterA, a);
	const afterB = setTraceFn(null);
	assert.equal(afterB, b);
	setTraceFn(original);
});
