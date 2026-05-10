import { test } from "node:test";
import assert from "node:assert/strict";

import { isIdentifier, parseLinearUrl } from "../src/identifiers.ts";

test("isIdentifier accepts canonical Linear identifiers", () => {
	for (const id of ["FE-123", "ENG-4567", "A1-9", "FOO_BAR-1", "AB-1"]) {
		assert.equal(isIdentifier(id), true, `expected ${id} to be a valid identifier`);
	}
});

test("isIdentifier rejects non-identifier strings", () => {
	for (const bad of [
		"",
		"fe-123",            // lowercase prefix
		"FE",                // no number
		"FE-",               // no digits
		"-123",              // no prefix
		"FE 123",            // space
		"FE-12.3",           // non-digit in number
		"F-1",               // prefix too short (single char)
		"ABCDEFGHIJK-1",     // prefix too long (>10)
		"https://linear.app/x/issue/FE-1",
	]) {
		assert.equal(isIdentifier(bad), false, `expected ${bad!} to be rejected`);
	}
});

test("isIdentifier tolerates non-string input", () => {
	// Casting to bypass TS at the test boundary — guards JS callers.
	assert.equal(isIdentifier(undefined as unknown as string), false);
	assert.equal(isIdentifier(null as unknown as string), false);
	assert.equal(isIdentifier(123 as unknown as string), false);
});

test("parseLinearUrl parses canonical issue URLs", () => {
	const p = parseLinearUrl("https://linear.app/acme/issue/FE-123/build-the-thing");
	assert.deepEqual(p, {
		identifier: "FE-123",
		teamPrefix: "FE",
		teamKey: "FE",
		number: 123,
		slug: "build-the-thing",
	});
});

test("parseLinearUrl handles URLs without a slug segment", () => {
	const p = parseLinearUrl("https://linear.app/acme/issue/ENG-4567");
	assert.ok(p);
	assert.equal(p.identifier, "ENG-4567");
	assert.equal(p.teamPrefix, "ENG");
	assert.equal(p.number, 4567);
	assert.equal(p.slug, undefined);
});

test("parseLinearUrl tolerates trailing query strings and fragments", () => {
	const p = parseLinearUrl("https://linear.app/acme/issue/FE-1/foo?from=slack#comment-99");
	assert.ok(p);
	assert.equal(p.identifier, "FE-1");
	assert.equal(p.slug, "foo");
});

test("parseLinearUrl returns null for non-Linear URLs", () => {
	for (const u of [
		"",
		"https://example.com/issue/FE-123",
		"https://linear.app/acme/team/FE/active",
		"FE-123",
		"https://linear.app/acme/issue/fe-123/bad-case",
	]) {
		assert.equal(parseLinearUrl(u), null, `expected ${u!} to be rejected`);
	}
});
