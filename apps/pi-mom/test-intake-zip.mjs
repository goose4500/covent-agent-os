// Tests for apps/pi-mom/lib/intake-zip.mjs.
//
// extractZipBuffer is exercised against in-process zip buffers built with
// `adm-zip` so the tests stay hermetic. downloadSlackFile is exercised with
// a fake Slack WebClient + a fake fetch so we can assert the URL/header
// contract and the size caps without touching the network.

import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { downloadSlackFile, extractZipBuffer } from "./lib/intake-zip.mjs";

function makeZip(entries) {
  const z = new AdmZip();
  for (const [name, body] of entries) {
    z.addFile(name, Buffer.from(body, "utf8"));
  }
  return z.toBuffer();
}

// Case 1: happy path — two markdown files come back decoded.
{
  const buf = makeZip([
    ["spec.md", "# Spec\nHello"],
    ["notes/ideas.md", "## Ideas\nThings"],
  ]);
  const out = extractZipBuffer(buf);
  assert.equal(out.files.length, 2);
  const spec = out.files.find((f) => f.name === "spec.md");
  const ideas = out.files.find((f) => f.name === "ideas.md");
  assert.ok(spec, "spec.md present");
  assert.ok(ideas, "ideas.md present");
  assert.equal(spec.mediaType, "markdown");
  assert.equal(ideas.mediaType, "markdown");
  assert.equal(spec.text, "# Spec\nHello");
  assert.equal(ideas.text, "## Ideas\nThings");
  assert.equal(spec.relPath, "spec.md");
  assert.equal(ideas.relPath, "notes/ideas.md");
  assert.equal(spec.truncated, false);
  assert.equal(out.skipped.length, 0);
  assert.ok(out.totalBytes > 0);
}

// Case 2: a .pdf entry is added to skipped[] with a reason mentioning .pdf
// and is not present in files[] as decoded text.
{
  const buf = makeZip([
    ["readme.md", "hi"],
    ["foo.pdf", "%PDF-1.4 fake bytes"],
  ]);
  const out = extractZipBuffer(buf);
  const pdfSkip = out.skipped.find((s) => s.name === "foo.pdf");
  assert.ok(pdfSkip, "foo.pdf in skipped[]");
  assert.match(pdfSkip.reason, /\.pdf/);
  const pdfFile = out.files.find((f) => f.name === "foo.pdf");
  // It may appear in files[] as a binary placeholder, but never with text.
  if (pdfFile) {
    assert.equal(pdfFile.text, null, "pdf entry has no decoded text");
    assert.equal(pdfFile.mediaType, "pdf");
  }
}

// Case 3: an entry larger than maxEntryBytes is skipped with the expected
// reason and is not present in files[].
{
  const big = "x".repeat(20_000);
  const buf = makeZip([
    ["small.md", "ok"],
    ["big.md", big],
  ]);
  const out = extractZipBuffer(buf, { maxEntryBytes: 1000 });
  const bigSkip = out.skipped.find((s) => s.name === "big.md");
  assert.ok(bigSkip, "big.md in skipped[]");
  assert.match(bigSkip.reason, /maxEntryBytes/);
  assert.equal(out.files.find((f) => f.name === "big.md"), undefined, "big.md not in files");
  assert.ok(out.files.find((f) => f.name === "small.md"), "small.md still present");
}

// Case 4: total uncompressed size exceeds maxTotalBytes — later entries are
// truncated out of files[] and surface in skipped[] by name.
{
  const body = "y".repeat(5_000);
  const buf = makeZip([
    ["a.md", body],
    ["b.md", body],
    ["c.md", body],
    ["d.md", body],
  ]);
  // Allow only ~2 of the 5KB entries through.
  const out = extractZipBuffer(buf, { maxTotalBytes: 11_000 });
  assert.ok(out.files.length < 4, "fewer than all files made it through");
  const droppedNames = out.skipped.map((s) => s.name);
  // At least one of c.md / d.md should have been dropped for total-cap reasons.
  const totalSkip = out.skipped.find((s) => /maxTotalBytes/.test(s.reason));
  assert.ok(totalSkip, "at least one entry skipped due to total cap");
  assert.ok(
    droppedNames.includes("c.md") || droppedNames.includes("d.md"),
    "dropped files named in skipped[]",
  );
}

// Case 5: more entries than maxEntries — the cap stops processing and the
// remainder land in skipped[] with a maxEntries reason.
{
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push([`f${i}.md`, `body ${i}`]);
  const buf = makeZip(entries);
  const out = extractZipBuffer(buf, { maxEntries: 3 });
  assert.equal(out.files.length, 3, "only maxEntries files");
  const capSkips = out.skipped.filter((s) => /maxEntries/.test(s.reason));
  assert.ok(capSkips.length >= 7, "remaining entries in skipped[]");
}

// Case 6: markdown larger than textEntryLimitBytes is truncated, not dropped.
{
  const body = "z".repeat(1500);
  const buf = makeZip([["long.md", body]]);
  const out = extractZipBuffer(buf, { textEntryLimitBytes: 500 });
  const f = out.files.find((x) => x.name === "long.md");
  assert.ok(f, "long.md present");
  assert.equal(f.truncated, true);
  assert.equal(f.text.length, 500);
  assert.equal(f.text, body.slice(0, 500));
}

// Case 7: empty zip returns empty files[] and totalBytes 0 without throwing.
{
  const buf = makeZip([]);
  const out = extractZipBuffer(buf);
  assert.deepEqual(out.files, []);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.totalBytes, 0);
}

// Helpers for downloadSlackFile tests.
function makeFakeClient({ info }) {
  return {
    files: {
      info: async (args) => {
        return typeof info === "function" ? info(args) : info;
      },
    },
  };
}

function makeFakeFetch(handler, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
}

// Case 8: downloadSlackFile happy path returns a Buffer with the content the
// fake fetch produced, and sends an Authorization header.
{
  const calls = [];
  const payload = Buffer.from("ZIPDATA", "utf8");
  const client = makeFakeClient({ info: { file: { url_private_download: "https://files.slack/x" } } });
  const fakeFetch = makeFakeFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  }), calls);
  const buf = await downloadSlackFile(client, "F123", { fetchImpl: fakeFetch, botToken: "xoxb-abc" });
  assert.ok(Buffer.isBuffer(buf), "returns a Buffer");
  assert.equal(buf.toString("utf8"), "ZIPDATA");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://files.slack/x");
  assert.equal(calls[0].init.headers.Authorization, "Bearer xoxb-abc");
}

// Case 9: missing url_private_download → throws.
{
  const client = makeFakeClient({ info: { file: {} } });
  const fakeFetch = async () => { throw new Error("fetch should not be called"); };
  await assert.rejects(
    () => downloadSlackFile(client, "F123", { fetchImpl: fakeFetch, botToken: "xoxb-abc" }),
    /url_private_download/,
  );
}

// Case 10: non-2xx response → throws.
{
  const client = makeFakeClient({ info: { file: { url_private_download: "https://files.slack/x" } } });
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(
    () => downloadSlackFile(client, "F123", { fetchImpl: fakeFetch, botToken: "xoxb-abc" }),
    /403|download failed/,
  );
}

// Case 11: response exceeds maxBytes (both via Content-Length and via the
// real buffer size) → throws.
{
  const client = makeFakeClient({ info: { file: { url_private_download: "https://files.slack/x" } } });

  // 11a: advertised Content-Length exceeds cap → throws before allocating.
  const fakeFetchAdvertised = async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === "content-length" ? "99999" : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await assert.rejects(
    () => downloadSlackFile(client, "F123", { fetchImpl: fakeFetchAdvertised, botToken: "xoxb-abc", maxBytes: 1000 }),
    /maxBytes/,
  );

  // 11b: server lies about Content-Length but the actual buffer is over the
  // cap → still throws.
  const big = Buffer.alloc(2000, 1);
  const fakeFetchActual = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
  });
  await assert.rejects(
    () => downloadSlackFile(client, "F123", { fetchImpl: fakeFetchActual, botToken: "xoxb-abc", maxBytes: 1000 }),
    /maxBytes/,
  );
}

console.log("✅ intake-zip tests pass");
