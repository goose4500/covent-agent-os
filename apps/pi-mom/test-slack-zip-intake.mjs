import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  formatSlackZipInventoryMessage,
  intakeSlackZipFile,
  SlackZipIntakeError,
} from "./lib/slack-zip-intake.mjs";

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [path, text] of Object.entries(entries)) {
    const name = Buffer.from(path);
    const contents = Buffer.from(text);
    const compressed = deflateRawSync(contents);
    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(8), // deflate
      u16(0), u16(0), // time/date
      u32(0), // crc32 intentionally not validated by helper
      u32(compressed.length),
      u32(contents.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);

    const central = Buffer.concat([
      u32(0x02014b50), // central directory signature
      u16(20), u16(20),
      u16(0),
      u16(8),
      u16(0), u16(0),
      u32(0),
      u32(compressed.length),
      u32(contents.length),
      u16(name.length),
      u16(0), // extra length
      u16(0), // comment length
      u16(0), // disk start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset),
      name,
    ]);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function fakeZipClient({ file }) {
  return {
    files: {
      info: async ({ file: requested }) => {
        assert.equal(requested, file.id);
        return { file };
      },
    },
  };
}

function fakeFetchFor(buffer, calls) {
  return async (_url, options = {}) => {
    calls.push(options);
    assert.match(options.headers?.Authorization || "", /^Bearer /);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    };
  };
}

// Non-zip files are skipped before any private download.
{
  const calls = [];
  const result = await intakeSlackZipFile({
    client: fakeZipClient({ file: { id: "F1", name: "notes.txt", size: 5, mimetype: "text/plain" } }),
    botToken: "xoxb-test",
    fileId: "F1",
    channel: "C1",
    threadTs: "111.222",
    fetchImpl: fakeFetchFor(Buffer.from("hello"), calls),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "not_zip");
  assert.equal(calls.length, 0);
}

// Oversized files are skipped before any private download.
{
  const calls = [];
  const result = await intakeSlackZipFile({
    client: fakeZipClient({ file: { id: "F2", name: "big.zip", size: 999, mimetype: "application/zip" } }),
    botToken: "xoxb-test",
    fileId: "F2",
    channel: "C1",
    threadTs: "111.222",
    maxBytes: 10,
    fetchImpl: fakeFetchFor(Buffer.from("unused"), calls),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "oversize");
  assert.equal(calls.length, 0);
}

// Zip-slip entries are rejected and never extracted outside the target dir.
{
  const root = mkdtempSync(join(tmpdir(), "slack-zip-slip-"));
  const zip = createZip({ "../evil.txt": "bad" });
  await assert.rejects(
    intakeSlackZipFile({
      client: fakeZipClient({ file: { id: "F3", name: "bad.zip", size: zip.length, mimetype: "application/zip", url_private_download: "https://files.test/bad.zip" } }),
      botToken: "xoxb-test",
      fileId: "F3",
      channel: "C1",
      threadTs: "111.222",
      baseDir: root,
      fetchImpl: fakeFetchFor(zip, []),
    }),
    (error) => error instanceof SlackZipIntakeError && error.code === "zip_slip",
  );
  assert.equal(existsSync(join(root, "evil.txt")), false);
  rmSync(root, { recursive: true, force: true });
}

// Happy path downloads, stores, extracts, and returns a concise inventory.
{
  const root = mkdtempSync(join(tmpdir(), "slack-zip-ok-"));
  const zip = createZip({
    "README.md": "# Handoff\n",
    "docs/plan.txt": "ship the small tracer bullet\n",
  });
  const calls = [];
  const result = await intakeSlackZipFile({
    client: fakeZipClient({
      file: {
        id: "F4",
        name: "handoff.zip",
        size: zip.length,
        mimetype: "application/zip",
        url_private_download: "https://files.test/handoff.zip",
      },
    }),
    botToken: "xoxb-test",
    fileId: "F4",
    channel: "CIDEA",
    threadTs: "177.000001",
    baseDir: root,
    fetchImpl: fakeFetchFor(zip, calls),
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.extractedFiles.map((f) => f.path).sort(), ["README.md", "docs/plan.txt"]);
  assert.equal(readFileSync(join(result.extractDir, "README.md"), "utf8"), "# Handoff\n");
  assert.match(formatSlackZipInventoryMessage(result), /slack-zip-handoff-analyzer/);
  rmSync(root, { recursive: true, force: true });
}

console.log("slack zip intake tests passed");
