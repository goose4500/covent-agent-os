import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserAuthStore } from "./lib/user-auth-store.mjs";

function fakeAuthStorage({ stored = {} } = {}) {
  const data = new Map(Object.entries(stored));
  return {
    has(p) { return data.has(p); },
    hasAuth(p) { return data.has(p); },
    set(p, v) { data.set(p, v); },
    get(p) { return data.get(p); },
    _data: data,
  };
}

// Case 1: per-user storage is created on first get(), cached on second.
{
  const baseDir = mkdtempSync(join(tmpdir(), "pi-mom-user-auth-test-"));
  try {
    let storageCalls = 0;
    let registryCalls = 0;
    const store = createUserAuthStore({
      baseDir,
      createAuthStorage: (p) => {
        storageCalls += 1;
        assert.match(p, /\/users\/U1234ABCD\/auth\.json$/, "cache: path under users/<id>");
        return fakeAuthStorage();
      },
      createModelRegistry: () => { registryCalls += 1; return {}; },
    });

    // Issue both calls before awaiting to exercise the in-flight promise
    // dedupe (concurrent first-mentions from the same user must not double
    // up createAuthStorage).
    const firstPromise = store.get("U1234ABCD");
    const secondPromise = store.get("U1234ABCD");
    assert.strictEqual(firstPromise, secondPromise, "cache: same in-flight promise");
    const first = await firstPromise;
    const second = await secondPromise;
    assert.strictEqual(first.authStorage, second.authStorage, "cache: same authStorage instance");
    assert.equal(storageCalls, 1, "cache: createAuthStorage called once");
    assert.equal(registryCalls, 1, "cache: createModelRegistry called once");
    assert.equal(store._sizeForTests(), 1);

    // ensureDir should have created the per-user folder
    assert.ok(existsSync(join(baseDir, "users", "U1234ABCD")), "cache: per-user dir created");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

// Case 2: hasCodexAuth reflects underlying storage.
{
  const storage1 = fakeAuthStorage({ stored: { "openai-codex": { type: "oauth" } } });
  const storage2 = fakeAuthStorage({ stored: {} });
  let calls = 0;
  const store = createUserAuthStore({
    baseDir: "/tmp/dummy",
    ensureDir: () => {},
    createAuthStorage: () => (calls++ === 0 ? storage1 : storage2),
    createModelRegistry: () => ({}),
  });
  assert.equal(await store.hasCodexAuth("UAAAAAAAAA"), true, "hasCodex: true when codex entry exists");
  assert.equal(await store.hasCodexAuth("UBBBBBBBBB"), false, "hasCodex: false when missing");
}

// Case 3: invalid slackUserId rejects with a descriptive error.
{
  const store = createUserAuthStore({ baseDir: "/tmp/x", ensureDir: () => {}, createAuthStorage: () => fakeAuthStorage(), createModelRegistry: () => ({}) });
  await assert.rejects(() => store.get(""), /slackUserId is required/);
  await assert.rejects(() => store.get("not lowercase"), /invalid slackUserId/);
  await assert.rejects(() => store.get("U" + "A".repeat(64)), /invalid slackUserId/);
}

// Case 4: forget evicts from cache; next get rebuilds.
{
  let calls = 0;
  const store = createUserAuthStore({
    baseDir: "/tmp/y",
    ensureDir: () => {},
    createAuthStorage: () => { calls += 1; return fakeAuthStorage(); },
    createModelRegistry: () => ({}),
  });
  await store.get("UFORGET01");
  await store.get("UFORGET01");
  assert.equal(calls, 1);
  store.forget("UFORGET01");
  await store.get("UFORGET01");
  assert.equal(calls, 2, "forget: re-creates on next get");
}

// Case 5: hasCodexAuth swallows errors from storage.has and returns false.
{
  const store = createUserAuthStore({
    baseDir: "/tmp/z",
    ensureDir: () => {},
    createAuthStorage: () => ({ hasAuth: () => { throw new Error("disk"); } }),
    createModelRegistry: () => ({}),
  });
  assert.equal(await store.hasCodexAuth("UERROR0001"), false, "errors are not propagated");
}

console.log("✓ user-auth-store: all cases pass");
