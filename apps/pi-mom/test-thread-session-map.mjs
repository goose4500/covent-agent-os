import assert from "node:assert/strict";
import { createThreadSessionMap } from "./lib/thread-session-map.mjs";

function makeFakeFs(initial = null) {
  const writes = [];
  const mkdirs = [];
  return {
    writes,
    mkdirs,
    file: initial,
    async readFile(_path, _enc) {
      if (this.file === null) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return this.file;
    },
    async writeFile(_path, contents) {
      this.file = contents;
      writes.push(contents);
    },
    async mkdir(p, _opts) {
      mkdirs.push(p);
    },
  };
}

// Case 1: fresh map → get returns undefined, set persists JSON to fs.writeFile.
{
  const fs = makeFakeFs();
  const map = createThreadSessionMap({ path: "/tmp/fake.json", fs, now: () => 1000 });
  assert.equal(await map.get("t1"), undefined, "empty: get returns undefined");
  await map.set("t1", "/sessions/a.jsonl");
  assert.equal(await map.get("t1"), "/sessions/a.jsonl", "after set: get returns the path");
  assert.equal(fs.writes.length, 1, "set: one write");
  assert.ok(fs.mkdirs.length >= 1, "set: parent mkdir called");
  const parsed = JSON.parse(fs.writes[0]);
  assert.equal(parsed.entries.t1.sessionFile, "/sessions/a.jsonl");
  assert.equal(parsed.entries.t1.lastTouched, 1000);
}

// Case 2: existing on-disk state is loaded on first get.
{
  const initial = JSON.stringify({
    entries: {
      thread_a: { sessionFile: "/sessions/aa.jsonl", lastTouched: 100 },
      thread_b: { sessionFile: "/sessions/bb.jsonl", lastTouched: 200 },
    },
  });
  const fs = makeFakeFs(initial);
  const map = createThreadSessionMap({ path: "/tmp/fake.json", fs });
  assert.equal(await map.get("thread_a"), "/sessions/aa.jsonl");
  assert.equal(await map.get("thread_b"), "/sessions/bb.jsonl");
  assert.equal(await map.get("thread_c"), undefined);
}

// Case 3: LRU eviction by lastTouched when over maxEntries.
{
  const fs = makeFakeFs();
  let t = 0;
  const map = createThreadSessionMap({
    path: "/tmp/fake.json",
    fs,
    maxEntries: 3,
    now: () => ++t,
  });
  await map.set("a", "/s/a.jsonl"); // lastTouched=1
  await map.set("b", "/s/b.jsonl"); // lastTouched=2
  await map.set("c", "/s/c.jsonl"); // lastTouched=3
  await map.set("d", "/s/d.jsonl"); // lastTouched=4 -- evicts 'a' (oldest)
  assert.equal(await map.get("a"), undefined, "oldest evicted");
  assert.equal(await map.get("b"), "/s/b.jsonl");
  assert.equal(await map.get("c"), "/s/c.jsonl");
  assert.equal(await map.get("d"), "/s/d.jsonl");
}

// Case 4: corrupt/non-JSON file is tolerated; map starts empty.
{
  const fs = makeFakeFs("definitely-not-json{");
  const map = createThreadSessionMap({ path: "/tmp/fake.json", fs });
  assert.equal(await map.get("whatever"), undefined, "corrupt file falls back to empty");
}

// Case 5: empty threadTs / sessionFile are no-ops on set.
{
  const fs = makeFakeFs();
  const map = createThreadSessionMap({ path: "/tmp/fake.json", fs });
  await map.set("", "/s/x.jsonl");
  await map.set("t", "");
  await map.set(null, "/s/x.jsonl");
  assert.equal(fs.writes.length, 0, "no writes on invalid set args");
}

// Case 6: clear() resets entries and persists.
{
  const fs = makeFakeFs();
  const map = createThreadSessionMap({ path: "/tmp/fake.json", fs, now: () => 1 });
  await map.set("t1", "/s/a.jsonl");
  await map.clear();
  assert.equal(await map.get("t1"), undefined);
  const parsed = JSON.parse(fs.writes[fs.writes.length - 1]);
  assert.deepEqual(parsed.entries, {});
}

// Case 7: snapshot() returns a copy, not the live state.
{
  const fs = makeFakeFs();
  const map = createThreadSessionMap({ path: "/tmp/fake.json", fs, now: () => 1 });
  await map.set("t1", "/s/a.jsonl");
  const snap = await map.snapshot();
  snap.entries.t1.sessionFile = "/MUTATED";
  assert.equal(await map.get("t1"), "/s/a.jsonl", "snapshot mutation does not affect map");
}

console.log("thread-session-map tests passed");
