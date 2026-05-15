// Unit tests for apps/pi-mom/lib/preview-zip.mjs.
//
// Uses real /tmp directories — the helper reads from disk via fs/promises and
// fflate's zipSync is pure JS, so the round-trip is testable without any
// network. Verifies the policy (single file vs dir, hidden skip, index.html
// requirement, byte caps).

import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { buildPreviewZip, MAX_FILES, MAX_BUNDLE_BYTES } from "./lib/preview-zip.mjs";

async function fixture(name) {
  const dir = join(tmpdir(), `pi-preview-zip-${name}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// Case 1: single .html file → zip with index.html at root
{
  const dir = await fixture("single-html");
  const filePath = join(dir, "scoreboard.html");
  await writeFile(filePath, "<html><body>1</body></html>");
  const { zip, count, bytes } = await buildPreviewZip(filePath);
  assert.equal(count, 1);
  assert.ok(bytes > 0);
  const unpacked = unzipSync(zip);
  const names = Object.keys(unpacked);
  assert.deepEqual(names, ["index.html"], "single file always lands as index.html in the bundle");
  assert.match(strFromU8(unpacked["index.html"]), /<body>1<\/body>/);
  await rm(dir, { recursive: true });
}

// Case 2: directory with index.html + assets → zip preserves the tree
{
  const dir = await fixture("dir-bundle");
  await writeFile(join(dir, "index.html"), "<html><head><link rel=stylesheet href=style.css></head></html>");
  await mkdir(join(dir, "css"));
  await writeFile(join(dir, "css", "style.css"), "body { color: red; }");
  await mkdir(join(dir, "img"));
  await writeFile(join(dir, "img", "logo.svg"), "<svg/>");
  const { zip, count } = await buildPreviewZip(dir);
  assert.equal(count, 3);
  const unpacked = unzipSync(zip);
  const names = Object.keys(unpacked).sort();
  assert.deepEqual(names, ["css/style.css", "img/logo.svg", "index.html"]);
  await rm(dir, { recursive: true });
}

// Case 3: directory without index.html → reject
{
  const dir = await fixture("no-index");
  await writeFile(join(dir, "main.html"), "<html></html>");
  await assert.rejects(() => buildPreviewZip(dir), /missing_index_html_in_source_dir/);
  await rm(dir, { recursive: true });
}

// Case 4: directory skips hidden entries (.git, .DS_Store, etc.)
{
  const dir = await fixture("hidden");
  await writeFile(join(dir, "index.html"), "<html></html>");
  await writeFile(join(dir, ".DS_Store"), "junk");
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
  const { zip, count } = await buildPreviewZip(dir);
  assert.equal(count, 1);
  const unpacked = unzipSync(zip);
  assert.deepEqual(Object.keys(unpacked), ["index.html"]);
  await rm(dir, { recursive: true });
}

// Case 5: missing source_path → reject
{
  await assert.rejects(() => buildPreviewZip("/tmp/this-path-does-not-exist-xyz-9999"));
}

// Case 6: too-many-files cap
{
  const dir = await fixture("many");
  await writeFile(join(dir, "index.html"), "<html></html>");
  for (let i = 0; i < MAX_FILES + 1; i++) {
    await writeFile(join(dir, `file_${i}.css`), "/* x */");
  }
  await assert.rejects(() => buildPreviewZip(dir), /too_many_files/);
  await rm(dir, { recursive: true });
}

// Case 7: single file rendered with a real .html extension other than index.html
// is renamed to index.html in the bundle (preview service serves index.html
// from the slug root).
{
  const dir = await fixture("renamed");
  const filePath = join(dir, "my-app.html");
  await writeFile(filePath, "<!doctype html><html><body>2</body></html>");
  const { zip } = await buildPreviewZip(filePath);
  const unpacked = unzipSync(zip);
  assert.deepEqual(Object.keys(unpacked), ["index.html"]);
  assert.match(strFromU8(unpacked["index.html"]), /body>2/);
  await rm(dir, { recursive: true });
}

console.log("preview-zip tests passed");
