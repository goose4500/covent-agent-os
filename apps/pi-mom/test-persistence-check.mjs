import assert from "node:assert/strict";
import { checkPersistence } from "./lib/persistence-check.mjs";

function recorder() {
  const calls = [];
  return { fn: (...args) => calls.push(args.join(" ")), calls };
}

// Case 1: no prior marker — persistence is "unknown yet", warn printed,
// marker written.
{
  const log = recorder();
  const warn = recorder();
  const writes = [];
  const dirs = [];
  const result = checkPersistence({
    baseDir: "/tmp/fake-agent-dir",
    fileExists: () => false,
    fileStat: () => assert.fail("stat should not be called when marker missing"),
    writeFile: (p, c) => writes.push({ p, c }),
    ensureDir: (p) => dirs.push(p),
    log: log.fn,
    warn: warn.fn,
    now: () => new Date("2026-05-13T00:00:00Z"),
  });
  assert.equal(result.persistent, false, "no prior: result.persistent === false (not yet confirmed)");
  assert.equal(result.priorBootIso, null);
  assert.equal(result.bootIso, "2026-05-13T00:00:00.000Z");
  assert.equal(writes.length, 1, "no prior: marker written");
  assert.match(writes[0].p, /\.persistence-marker$/);
  assert.equal(writes[0].c, "2026-05-13T00:00:00.000Z");
  assert.equal(dirs[0], "/tmp/fake-agent-dir", "no prior: ensureDir called on baseDir");
  assert.equal(log.calls.length, 0, "no prior: no success log");
  assert.equal(warn.calls.length, 1, "no prior: one warn");
  assert.match(warn.calls[0], /no prior-boot marker/);
}

// Case 2: prior marker exists — persistent verdict, no warn.
{
  const log = recorder();
  const warn = recorder();
  const result = checkPersistence({
    baseDir: "/data/pi-agent",
    fileExists: () => true,
    fileStat: () => ({ mtime: new Date("2026-05-12T23:50:00Z") }),
    writeFile: () => {},
    ensureDir: () => {},
    log: log.fn,
    warn: warn.fn,
    now: () => new Date("2026-05-13T00:00:00Z"),
  });
  assert.equal(result.persistent, true, "prior marker: persistent");
  assert.equal(result.priorBootIso, "2026-05-12T23:50:00.000Z");
  assert.equal(log.calls.length, 1);
  assert.match(log.calls[0], /persistent at \/data\/pi-agent/);
  assert.match(log.calls[0], /2026-05-12T23:50:00/);
  assert.equal(warn.calls.length, 0);
}

// Case 3: write failure surfaces as a warn + persistent:null, doesn't throw.
{
  const log = recorder();
  const warn = recorder();
  const result = checkPersistence({
    baseDir: "/readonly",
    fileExists: () => false,
    fileStat: () => ({ mtime: new Date() }),
    writeFile: () => { throw new Error("EROFS: read-only file system"); },
    ensureDir: () => { throw new Error("EROFS"); },
    log: log.fn,
    warn: warn.fn,
  });
  assert.equal(result.persistent, null);
  assert.ok(result.error);
  assert.match(result.error, /EROFS/);
  assert.equal(warn.calls.length, 1);
  assert.match(warn.calls[0], /cannot write marker/);
}

// Case 4: missing baseDir throws synchronously.
{
  assert.throws(() => checkPersistence({}), /baseDir is required/);
}

// Case 5: stat failure on existing marker logs a warn but doesn't crash;
// the run proceeds as "no prior marker."
{
  const log = recorder();
  const warn = recorder();
  let wrote = false;
  const result = checkPersistence({
    baseDir: "/x",
    fileExists: () => true,
    fileStat: () => { throw new Error("EPERM"); },
    writeFile: () => { wrote = true; },
    ensureDir: () => {},
    log: log.fn,
    warn: warn.fn,
  });
  assert.equal(result.persistent, false);
  assert.equal(wrote, true, "stat err: still attempts write");
  assert.ok(warn.calls.some((c) => /stat failed/.test(c)));
}

console.log("✓ persistence-check: all cases pass");
