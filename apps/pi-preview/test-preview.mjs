// Unit tests for apps/pi-preview/lib/preview-core.mjs.
//
// Tests the pure helpers — extractAndStore, classifyEntryName, injectOgTags,
// contentTypeFor — without booting Bun.serve. The HTTP layer is exercised
// manually in dev (curl); these tests cover the security-relevant logic.

import assert from "node:assert/strict";
import { strToU8, zipSync, unzipSync } from "fflate";
import {
  classifyEntryName,
  extractAndStore,
  injectOgTags,
  contentTypeFor,
} from "./lib/preview-core.mjs";

function makeFakeFs() {
  const dirs = new Set();
  const files = new Map();
  return {
    dirs, files,
    mkdir: async (p, _opts) => { dirs.add(String(p)); },
    writeFile: async (p, bytes) => { files.set(String(p), bytes); },
  };
}

// Case 1: classifyEntryName accepts a clean path
{
  assert.deepEqual(classifyEntryName("index.html"), { ok: true, name: "index.html", ext: "html" });
  assert.deepEqual(classifyEntryName("css/style.css"), { ok: true, name: "css/style.css", ext: "css" });
  assert.deepEqual(classifyEntryName("img/logo.png"), { ok: true, name: "img/logo.png", ext: "png" });
}

// Case 2: classifyEntryName rejects traversal, absolute, weird inputs
{
  assert.equal(classifyEntryName("../etc/passwd").ok, false);
  assert.equal(classifyEntryName("a/../../b").ok, false);
  assert.equal(classifyEntryName("/etc/passwd").ok, false);
  assert.equal(classifyEntryName("\\windows\\system32").ok, false);
  assert.equal(classifyEntryName("").ok, false);
  assert.equal(classifyEntryName(null).ok, false);
  assert.equal(classifyEntryName("dir/").ok, false);
  assert.equal(classifyEntryName("evil.sh").ok, false);          // disallowed ext
  assert.equal(classifyEntryName("file\0.html").ok, false);      // nul byte
}

// Case 3: extractAndStore writes a well-formed zip
{
  const zipped = zipSync({
    "index.html": strToU8("<html><body>hi</body></html>"),
    "style.css": strToU8("body { font-family: sans-serif; }"),
  });
  const entries = unzipSync(zipped);
  const fs = makeFakeFs();
  const result = await extractAndStore({ entries, dir: "/data/previews/abc", ...fs });
  assert.equal(result.count, 2);
  assert.ok(result.bytes > 0);
  assert.ok(fs.files.has("/data/previews/abc/index.html"));
  assert.ok(fs.files.has("/data/previews/abc/style.css"));
}

// Case 4: extractAndStore creates nested dirs as needed
{
  const zipped = zipSync({
    "index.html": strToU8("<html></html>"),
    "img/logo.png": strToU8("fake-png-bytes"),
  });
  const fs = makeFakeFs();
  await extractAndStore({ entries: unzipSync(zipped), dir: "/data/previews/x", ...fs });
  assert.ok(fs.dirs.has("/data/previews/x/img"), "img subdir created");
  assert.ok(fs.files.has("/data/previews/x/img/logo.png"));
}

// Case 5: extractAndStore rejects a bundle missing index.html
{
  const zipped = zipSync({ "main.html": strToU8("<html></html>") });
  await assert.rejects(
    () => extractAndStore({ entries: unzipSync(zipped), dir: "/data/previews/m", ...makeFakeFs() }),
    /missing_index_html/,
  );
}

// Case 6: extractAndStore rejects path traversal
{
  const zipped = zipSync({
    "index.html": strToU8("<html></html>"),
    "../escape.html": strToU8("nope"),
  });
  await assert.rejects(
    () => extractAndStore({ entries: unzipSync(zipped), dir: "/data/previews/t", ...makeFakeFs() }),
    /reject_entry/,
  );
}

// Case 7: extractAndStore rejects oversize bundles
{
  // Forge a fake zip entry table that exceeds MAX_BUNDLE_BYTES (10MB).
  const big = new Uint8Array(11 * 1024 * 1024);
  const entries = { "index.html": strToU8("<html></html>"), "huge.png": big };
  await assert.rejects(
    () => extractAndStore({ entries, dir: "/data/previews/big", ...makeFakeFs() }),
    /bundle_too_large/,
  );
}

// Case 8: injectOgTags adds 4 meta tags into <head>
{
  const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
  const out = injectOgTags(html, { slug: "abc12345", publicBase: "https://preview.example.com", path: "index.html" });
  assert.match(out, /og:title.*Preview · abc12345/);
  assert.match(out, /og:description.*covent-pi/);
  assert.match(out, /og:url.*preview\.example\.com\/p\/abc12345/);
  assert.match(out, /twitter:card.*summary/);
  // Doesn't break existing <title>:
  assert.match(out, /<title>x<\/title>/);
}

// Case 9: injectOgTags is idempotent — leaves user's existing og:title alone
{
  const html = `<html><head><meta property="og:title" content="user title"><title>x</title></head></html>`;
  const out = injectOgTags(html, { slug: "id", publicBase: "https://x", path: "index.html" });
  assert.equal(out, html, "user-supplied og:title is preserved");
}

// Case 10: injectOgTags returns raw fragment unchanged when no <head> present
{
  const fragment = "<div>standalone widget</div>";
  assert.equal(injectOgTags(fragment, { slug: "z", publicBase: "", path: "index.html" }), fragment);
}

// Case 11: contentTypeFor knows the common web types
{
  assert.equal(contentTypeFor("html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("css"), "text/css; charset=utf-8");
  assert.equal(contentTypeFor("png"), "image/png");
  assert.equal(contentTypeFor("UNKNOWN"), "application/octet-stream");
}

console.log("preview-core tests passed");
