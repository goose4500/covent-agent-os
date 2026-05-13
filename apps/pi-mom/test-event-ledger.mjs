// Tests for apps/pi-mom/lib/event-ledger.mjs.
//
// Two harnesses:
//
//   - Real-fs cases run under a per-test `fs.mkdtempSync` directory so we
//     exercise the actual appendFileSync / mkdirSync syscalls. We clean up
//     in a `finally` so a failed assert never leaves stale temp dirs.
//   - Injected-fs cases use a tiny double when we need to assert on error
//     handling (no real way to make appendFileSync throw deterministically
//     without OS-level dirty tricks).
//
// Style mirrors test-event-receiver.mjs — block-scoped cases, hand-rolled
// mockFn, asserts read top-down.

import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";

import { createEventLedger } from "./lib/event-ledger.mjs";

function withTempDir(fn) {
  // Each invocation gets a fresh dir so cases don't poison each other.
  const dir = mkdtempSync(join(tmpdir(), "pi-ledger-"));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function silentLogger() {
  const calls = { warn: [], info: [], error: [] };
  return {
    calls,
    warn: (...args) => calls.warn.push(args),
    info: (...args) => calls.info.push(args),
    error: (...args) => calls.error.push(args),
  };
}

function readLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Case 1: Happy path — three appends → three newline-delimited JSON lines
// ---------------------------------------------------------------------------
withTempDir((dir) => {
  const path = join(dir, "events.jsonl");
  const ledger = createEventLedger({ path, logger: silentLogger() });
  ledger.append({ deliveryId: "d1", source: "linear", event: "Comment.create", status: "started" });
  ledger.append({ deliveryId: "d1", source: "linear", event: "Comment.create", status: "completed", sessionId: "s_1" });
  ledger.append({ deliveryId: "d2", source: "linear", event: "Issue.update", status: "error", error: "boom" });

  const lines = readLines(path);
  assert.equal(lines.length, 3, "three lines on disk");

  // Each line is valid JSON and round-trips.
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].deliveryId, "d1");
  assert.equal(parsed[0].status, "started");
  assert.equal(parsed[1].status, "completed");
  assert.equal(parsed[1].sessionId, "s_1");
  assert.equal(parsed[2].status, "error");
  assert.equal(parsed[2].error, "boom");

  // The file ends with a trailing newline — important so `tail -f` aligns and
  // so any next `appendFileSync` call writes a clean new line.
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.endsWith("\n"), true, "file ends with newline");
});

// ---------------------------------------------------------------------------
// Case 2: Entry without `ts` field → ledger injects one from `now`
// ---------------------------------------------------------------------------
withTempDir((dir) => {
  const path = join(dir, "events.jsonl");
  const FIXED = "2026-05-13T10:42:00.000Z";
  const ledger = createEventLedger({
    path,
    logger: silentLogger(),
    now: () => FIXED,
  });
  ledger.append({ deliveryId: "d1", source: "linear", status: "started" });

  const entry = JSON.parse(readLines(path)[0]);
  assert.equal(entry.ts, FIXED, "ledger injected ts from now()");
  // Other fields preserved.
  assert.equal(entry.deliveryId, "d1");
  assert.equal(entry.status, "started");
});

// ---------------------------------------------------------------------------
// Case 3: Entry with `ts` field → ledger preserves it
// ---------------------------------------------------------------------------
withTempDir((dir) => {
  const path = join(dir, "events.jsonl");
  const FIXED = "2026-05-13T10:42:00.000Z";
  const CALLER_TS = "2024-01-01T00:00:00.000Z";
  const ledger = createEventLedger({
    path,
    logger: silentLogger(),
    now: () => FIXED,
  });
  ledger.append({
    ts: CALLER_TS,
    deliveryId: "d1",
    source: "linear",
    status: "started",
  });

  const entry = JSON.parse(readLines(path)[0]);
  assert.equal(entry.ts, CALLER_TS, "caller-provided ts preserved verbatim");
  assert.notEqual(entry.ts, FIXED);
});

// ---------------------------------------------------------------------------
// Case 4: Parent directory doesn't exist → `mkdir -p` creates it
// ---------------------------------------------------------------------------
withTempDir((dir) => {
  // Deeply nested target — none of these exist yet.
  const path = join(dir, "nested", "deeper", "events.jsonl");
  assert.equal(existsSync(dirname(path)), false, "parent dir absent before append");

  const ledger = createEventLedger({ path, logger: silentLogger() });
  ledger.append({ deliveryId: "d1", source: "linear", status: "started" });

  assert.equal(existsSync(dirname(path)), true, "parent dir created");
  assert.equal(statSync(dirname(path)).isDirectory(), true);
  assert.equal(readLines(path).length, 1, "one entry written");
});

// ---------------------------------------------------------------------------
// Case 5: fs.appendFileSync throws → exception swallowed, logger.error called
// ---------------------------------------------------------------------------
{
  const logger = silentLogger();
  const fakeFs = {
    mkdirSync: () => {}, // no-op success
    appendFileSync: () => {
      throw new Error("EROFS: read-only filesystem");
    },
  };
  const ledger = createEventLedger({
    path: "/dev/null/whatever.jsonl",
    fs: fakeFs,
    logger,
  });

  // Must not throw.
  ledger.append({ deliveryId: "d1", source: "linear", status: "started" });

  assert.equal(
    logger.calls.error.length,
    1,
    "one error log for appendFileSync failure",
  );
  const msg = String(logger.calls.error[0][0]);
  assert.match(msg, /appendFileSync failed/i);
  assert.match(msg, /EROFS/);
}

// Sanity 5b: mkdir failure is also swallowed + logged, and a subsequent
// successful mkdir is still attempted on the next call.
{
  const logger = silentLogger();
  const appendCalls = [];
  let mkdirCalls = 0;
  let mkdirShouldThrow = true;
  const fakeFs = {
    mkdirSync: () => {
      mkdirCalls += 1;
      if (mkdirShouldThrow) throw new Error("EACCES: permission denied");
    },
    appendFileSync: (p, data) => {
      appendCalls.push({ p, data });
    },
  };
  const ledger = createEventLedger({
    path: "/some/path/events.jsonl",
    fs: fakeFs,
    logger,
  });

  ledger.append({ deliveryId: "d1", status: "started" });
  assert.equal(mkdirCalls, 1, "mkdir attempted on first append");
  assert.equal(logger.calls.error.length, 1, "mkdir failure logged");
  // appendFileSync is still attempted even when mkdir failed — gives us a
  // chance to succeed when the parent dir already exists from outside.
  assert.equal(appendCalls.length, 1, "appendFileSync still attempted after mkdir failure");

  // Next call: mkdir is retried (not memoized after a failure). Let it succeed.
  mkdirShouldThrow = false;
  ledger.append({ deliveryId: "d2", status: "completed" });
  assert.equal(mkdirCalls, 2, "mkdir retried on next append after prior failure");
  assert.equal(appendCalls.length, 2);

  // A third call should NOT re-mkdir — success memoizes.
  ledger.append({ deliveryId: "d3", status: "completed" });
  assert.equal(mkdirCalls, 2, "mkdir memoized after success");
  assert.equal(appendCalls.length, 3);
}

// Sanity 5c: cyclic entry → JSON.stringify fails, logged, no crash, no file write.
{
  const logger = silentLogger();
  const appendCalls = [];
  const fakeFs = {
    mkdirSync: () => {},
    appendFileSync: (p, data) => {
      appendCalls.push({ p, data });
    },
  };
  const ledger = createEventLedger({
    path: "/some/path/events.jsonl",
    fs: fakeFs,
    logger,
  });

  const cyclic = { deliveryId: "d-cyc", status: "started" };
  cyclic.self = cyclic;
  ledger.append(cyclic);

  assert.equal(appendCalls.length, 0, "no write when stringify failed");
  assert.equal(logger.calls.error.length, 1);
  assert.match(String(logger.calls.error[0][0]), /JSON\.stringify failed/i);
}

// ---------------------------------------------------------------------------
// Case 6: Multiple ledgers writing to the same path don't corrupt each other
// ---------------------------------------------------------------------------
withTempDir((dir) => {
  const path = join(dir, "shared.jsonl");
  const ledgerA = createEventLedger({ path, logger: silentLogger() });
  const ledgerB = createEventLedger({ path, logger: silentLogger() });

  // Interleave writes from both writers. appendFileSync is atomic for short
  // writes on POSIX (PIPE_BUF >= 4096) and our lines are well below that.
  ledgerA.append({ deliveryId: "a1", writer: "A", status: "started" });
  ledgerB.append({ deliveryId: "b1", writer: "B", status: "started" });
  ledgerA.append({ deliveryId: "a2", writer: "A", status: "completed" });
  ledgerB.append({ deliveryId: "b2", writer: "B", status: "completed" });

  const lines = readLines(path);
  assert.equal(lines.length, 4, "all four lines persisted");

  // Each line parses cleanly — i.e. no torn writes.
  const parsed = lines.map((l) => JSON.parse(l));
  const writers = parsed.map((p) => p.writer).sort();
  assert.deepEqual(writers, ["A", "A", "B", "B"]);

  const deliveryIds = parsed.map((p) => p.deliveryId).sort();
  assert.deepEqual(deliveryIds, ["a1", "a2", "b1", "b2"]);
});

// Sanity: the default path lives under sessions/ — matches the docs and is
// gitignored. Exposed via `_path` so tests + ops scripts can introspect.
{
  const ledger = createEventLedger();
  assert.equal(ledger._path, "sessions/event-runs.jsonl");
}

// Sanity: path separator handling on this OS (just a smoke test — confirms
// the module didn't hard-code "/" and break on Windows-ish layouts).
withTempDir((dir) => {
  const path = ["events", "year=2026", "month=05", "today.jsonl"].reduce(
    (acc, part) => join(acc, part),
    dir,
  );
  assert.ok(path.includes(sep), "path uses OS separator");
  const ledger = createEventLedger({ path, logger: silentLogger() });
  ledger.append({ deliveryId: "d1", status: "started" });
  assert.equal(readLines(path).length, 1);
});

console.log("event-ledger tests passed");
