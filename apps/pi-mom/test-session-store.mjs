// Round-trip + persistence tests for the session-path API added to
// agent-run-store.mjs. Uses only node:fs/promises + the store itself, so it
// runs without the Pi SDK installed.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRunStore } from "./lib/agent-run-store.mjs";

const tmpRoot = await mkdtemp(join(tmpdir(), "pi-mom-session-store-"));
const storePath = join(tmpRoot, "runs.json");

try {
  // --- Fresh store: load on missing file initialises empty sessions ---
  const store = createRunStore({ path: storePath });
  const initial = await store.load();
  assert.deepEqual(initial.runs, [], "runs starts empty");
  assert.deepEqual(initial.sessions, {}, "sessions starts empty");
  assert.equal(await store.getSessionPathForThread("1700000000.000100"), undefined, "missing thread returns undefined");

  // --- Round-trip: set then get ---
  const threadA = "1700000000.000100";
  const pathA = "/tmp/pi-sessions/threadA.session";
  await store.setSessionPathForThread(threadA, pathA);
  assert.equal(await store.getSessionPathForThread(threadA), pathA, "set/get round-trips threadA");

  const threadB = "1700000001.000200";
  const pathB = "/tmp/pi-sessions/threadB.session";
  await store.setSessionPathForThread(threadB, pathB);
  assert.equal(await store.getSessionPathForThread(threadB), pathB, "second thread coexists");
  assert.equal(await store.getSessionPathForThread(threadA), pathA, "first thread still resolves");

  // --- Delete clears the entry ---
  await store.deleteSessionPathForThread(threadA);
  assert.equal(await store.getSessionPathForThread(threadA), undefined, "delete clears threadA");
  assert.equal(await store.getSessionPathForThread(threadB), pathB, "threadB survives threadA deletion");

  // Deleting a missing key is a no-op (doesn't throw, doesn't persist garbage).
  await store.deleteSessionPathForThread("does-not-exist");

  // --- Persistence: a fresh store on the same path sees the same data ---
  const store2 = createRunStore({ path: storePath });
  const loaded = await store2.load();
  assert.equal(loaded.sessions[threadB], pathB, "sessions persisted to disk");
  assert.equal(loaded.sessions[threadA], undefined, "deleted entry didn't come back");
  assert.equal(await store2.getSessionPathForThread(threadB), pathB, "getter works after reload");

  // --- Back-compat: a JSON file without a `sessions` key still loads ---
  const legacyPath = join(tmpRoot, "legacy.json");
  const legacyStore = createRunStore({ path: legacyPath });
  await legacyStore.load(); // ENOENT path
  // Seed a run to force a write, then strip the sessions key off disk.
  await legacyStore.create({ id: "run-legacy", status: "queued" });
  const raw = JSON.parse(await readFile(legacyPath, "utf8"));
  delete raw.sessions;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(legacyPath, JSON.stringify(raw, null, 2));

  const legacyReload = createRunStore({ path: legacyPath });
  const legacyState = await legacyReload.load();
  assert.deepEqual(legacyState.sessions, {}, "legacy file without sessions key loads as empty map");
  assert.equal(legacyState.runs.length, 1, "legacy file preserves runs");
  // And we can still write a session into it.
  await legacyReload.setSessionPathForThread("legacy-thread", "/tmp/legacy.session");
  assert.equal(await legacyReload.getSessionPathForThread("legacy-thread"), "/tmp/legacy.session");

  // --- Input validation ---
  await assert.rejects(() => legacyReload.setSessionPathForThread("", "/x"), /threadTs/, "empty threadTs rejected");
  await assert.rejects(() => legacyReload.setSessionPathForThread("t", ""), /sessionFilePath/, "empty path rejected");
  assert.equal(await legacyReload.getSessionPathForThread(""), undefined, "getter on empty threadTs returns undefined");

  console.log("session store tests passed");
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}
