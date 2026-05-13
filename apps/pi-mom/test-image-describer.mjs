// Image-describer unit tests.
//
// We don't talk to Gemini or to a real disk: a stub `gemini` client and a
// per-test temp directory keep the suite deterministic and offline. The
// production callsite (no `gemini`/`cache` opts) is covered by the
// module's default-to-`getGemini()`/default-cache wiring, which we sanity-
// check separately via the "no API key" case.

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeImage } from "./lib/image-describer.mjs";
import { lookup, write } from "./lib/image-description-cache.mjs";
import { _resetForTests as resetGeminiClient } from "./lib/gemini-client.mjs";

// Stub Gemini client. `behavior` controls what the next call does so a single
// test can sequence "fail then succeed" if it ever needs to.
function makeFakeGemini(behavior) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(params) {
        calls.push(params);
        const step = typeof behavior === "function"
          ? behavior(calls.length - 1, params)
          : behavior;
        if (step?.delayMs) {
          await new Promise((r) => setTimeout(r, step.delayMs));
        }
        if (step?.throw) {
          throw step.throw;
        }
        return step?.response;
      },
    },
  };
}

function makeTextResponse(text) {
  return {
    text,
    candidates: [
      { content: { parts: [{ text }] }, finishReason: "STOP" },
    ],
  };
}

async function withTempCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mom-image-cache-"));
  const cache = {
    lookup: (fileId) => lookup(fileId, { baseDir: dir }),
    write: (fileId, entry) => write(fileId, entry, { baseDir: dir }),
  };
  await fn({ dir, cache });
}

// Case 1: cache hit returns instantly with source: "cache", no Gemini call.
await withTempCache(async ({ dir, cache }) => {
  await cache.write("F1HIT", {
    description: "An orange cat sitting on a desk.",
    model: "gemini-3.1-flash-lite",
    builtAt: 12345,
  });

  const gemini = makeFakeGemini({});
  const result = await describeImage({
    buffer: Buffer.from("ignored"),
    mimeType: "image/png",
    fileId: "F1HIT",
    gemini,
    cache,
  });

  assert.equal(result.source, "cache", "cache hit should be flagged");
  assert.equal(result.description, "An orange cat sitting on a desk.");
  assert.equal(gemini.calls.length, 0, "Gemini must not be called on cache hit");
});

// Case 2: cache miss + successful Gemini call writes the entry and returns
// source: "live".
await withTempCache(async ({ dir, cache }) => {
  const gemini = makeFakeGemini({
    response: makeTextResponse("UI screenshot of a dashboard with three charts."),
  });

  const result = await describeImage({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    mimeType: "image/png",
    fileId: "F2MISS",
    gemini,
    cache,
  });

  assert.equal(result.source, "live", "fresh call should be flagged live");
  assert.match(result.description, /dashboard/);
  assert.equal(result.model, "gemini-3.1-flash-lite");
  assert.equal(typeof result.builtAt, "number");

  // Inspect the exact request shape that hit the SDK — Worker D will copy
  // this contract for the summarizer, so guard it.
  assert.equal(gemini.calls.length, 1, "one Gemini call");
  const params = gemini.calls[0];
  assert.equal(params.model, "gemini-3.1-flash-lite");
  assert.equal(params.config.thinkingConfig.thinkingLevel, "minimal");
  assert.equal(params.config.maxOutputTokens, 400);
  assert.equal(params.config.safetySettings.length, 4, "four safety categories");
  const part0 = params.contents[0].parts[0];
  assert.ok(part0.inlineData, "inline data part present");
  assert.equal(part0.inlineData.mimeType, "image/png");
  assert.equal(part0.inlineData.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  assert.match(params.contents[0].parts[1].text, /Describe factually/);

  // Cache should now contain the entry — proves the write side-effect.
  const reread = await cache.lookup("F2MISS");
  assert.ok(reread, "cache write produced a readable entry");
  assert.equal(reread.description, "UI screenshot of a dashboard with three charts.");
});

// Case 3: cache miss with no API key returns { error: "gemini_unavailable" }
// AND does not write to cache. We exercise the real `getGemini()` path here
// (no injected client) to prove the default wiring is what we expect.
await withTempCache(async ({ dir, cache }) => {
  const prior = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  resetGeminiClient();

  try {
    const result = await describeImage({
      buffer: Buffer.from("nope"),
      mimeType: "image/jpeg",
      fileId: "F3NOKEY",
      cache,
    });
    assert.deepEqual(result, { error: "gemini_unavailable" });

    // No entry should have been written — confirm the directory is empty
    // (or at least missing F3NOKEY.json).
    const files = await readdir(dir).catch(() => []);
    assert.ok(
      !files.includes("F3NOKEY.json"),
      "must not write a cache entry when API key is missing",
    );
  } finally {
    if (prior !== undefined) process.env.GEMINI_API_KEY = prior;
    resetGeminiClient();
  }
});

// Case 4: cache miss with Gemini hanging past deadlineMs returns
// { error: "timeout" } AND does not write to cache.
await withTempCache(async ({ dir, cache }) => {
  const gemini = makeFakeGemini({
    delayMs: 200,
    response: makeTextResponse("too late"),
  });

  const result = await describeImage({
    buffer: Buffer.from("x"),
    mimeType: "image/png",
    fileId: "F4TIMEOUT",
    gemini,
    cache,
    deadlineMs: 25,
  });

  assert.deepEqual(result, { error: "timeout" });

  const reread = await cache.lookup("F4TIMEOUT");
  assert.equal(reread, null, "timeout must not poison the cache");
});

// Case 5: a partial write (truncated JSON on disk) is treated as a miss on
// next lookup. Exercises the atomic-write contract from the cache module —
// if we hadn't gone through .tmp + rename, a crash mid-write could leave
// the cache file with this kind of garbage.
await withTempCache(async ({ dir, cache }) => {
  const fileId = "F5CORRUPT";
  // Hand-write a truncated JSON file directly into the cache dir,
  // simulating a process killed mid-stream BEFORE the atomic-write code
  // was in place. (Atomic writes prevent the real version of this, but we
  // still need to recover gracefully if a corrupt file appears via any
  // other means: disk error, sysadmin edit, etc.)
  await writeFile(join(dir, `${fileId}.json`), '{"description": "broken');
  const miss = await cache.lookup(fileId);
  assert.equal(miss, null, "corrupt file must read as a miss");

  // Now run describeImage — the corrupt file is overwritten with a fresh
  // valid entry via the atomic write path.
  const gemini = makeFakeGemini({
    response: makeTextResponse("Recovered description after corruption."),
  });
  const result = await describeImage({
    buffer: Buffer.from("data"),
    mimeType: "image/png",
    fileId,
    gemini,
    cache,
  });
  assert.equal(result.source, "live");

  const reread = await cache.lookup(fileId);
  assert.ok(reread, "post-recovery the entry is readable");
  assert.equal(reread.description, "Recovered description after corruption.");

  // And confirm no `.tmp` files leaked into the cache dir — would mean the
  // atomic-write rename didn't fire.
  const leftover = await readdir(dir);
  assert.ok(
    !leftover.some((f) => f.endsWith(".tmp")),
    `no stale .tmp files (saw: ${leftover.join(",")})`,
  );
});

// Case 6: an already-aborted AbortSignal short-circuits before Gemini is
// touched. Mirrors how a Pi tool's `signal` propagates a cancel.
await withTempCache(async ({ dir, cache }) => {
  const controller = new AbortController();
  controller.abort();

  const gemini = makeFakeGemini({
    response: makeTextResponse("should never reach here"),
  });

  const result = await describeImage({
    buffer: Buffer.from("x"),
    mimeType: "image/png",
    fileId: "F6ABORT",
    gemini,
    cache,
    signal: controller.signal,
  });

  assert.deepEqual(result, { error: "aborted" });
  assert.equal(gemini.calls.length, 0, "aborted signal must skip the Gemini call");
});

console.log("image-describer tests passed");
