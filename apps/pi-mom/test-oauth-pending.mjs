import assert from "node:assert/strict";
import { createOAuthPendingStore } from "./lib/oauth-pending.mjs";

function fakeTimers() {
  let id = 0;
  const timers = new Map();
  const setTimeoutFn = (fn, ms) => {
    id += 1;
    timers.set(id, { fn, ms });
    return id;
  };
  const clearTimeoutFn = (t) => timers.delete(t);
  const fire = (t) => {
    const entry = timers.get(t);
    if (!entry) return false;
    timers.delete(t);
    entry.fn();
    return true;
  };
  const fireAll = () => {
    for (const t of [...timers.keys()]) fire(t);
  };
  return { setTimeoutFn, clearTimeoutFn, fire, fireAll, timers };
}

// Case 1: happy path — start, resolve, promise yields pasted value.
{
  const { setTimeoutFn, clearTimeoutFn, timers } = fakeTimers();
  const store = createOAuthPendingStore({ setTimeoutFn, clearTimeoutFn });
  const p = store.startPending("U1");
  assert.equal(store.hasPending("U1"), true, "happy: hasPending true after start");
  assert.equal(timers.size, 1, "happy: ttl timer registered");
  assert.equal(store.resolvePending("U1", "http://localhost:1455/auth/callback?code=abc&state=xyz"), true, "happy: resolve returns true");
  assert.equal(store.hasPending("U1"), false, "happy: cleared after resolve");
  assert.equal(timers.size, 0, "happy: timer cleared after resolve");
  const value = await p;
  assert.equal(value, "http://localhost:1455/auth/callback?code=abc&state=xyz");
}

// Case 2: resolving an unknown user is a no-op (returns false).
{
  const store = createOAuthPendingStore();
  assert.equal(store.resolvePending("UNOBODY", "x"), false, "unknown: returns false");
}

// Case 3: cancel rejects with reason; promise rejects.
{
  const store = createOAuthPendingStore();
  const p = store.startPending("U2").catch((err) => err);
  assert.equal(store.cancelPending("U2", "user_dismissed"), true);
  const err = await p;
  assert.match(err.message, /user_dismissed/);
  assert.equal(store.hasPending("U2"), false);
}

// Case 4: starting a second flow for the same user supersedes the first.
{
  const store = createOAuthPendingStore();
  const first = store.startPending("U3").catch((err) => err);
  const second = store.startPending("U3");
  const firstErr = await first;
  assert.match(firstErr.message, /superseded/, "supersede: first rejects");
  assert.equal(store.resolvePending("U3", "code"), true);
  assert.equal(await second, "code", "supersede: second wins");
}

// Case 5: TTL expiry rejects the promise.
{
  const { setTimeoutFn, clearTimeoutFn, fireAll } = fakeTimers();
  const store = createOAuthPendingStore({ setTimeoutFn, clearTimeoutFn, ttlMs: 100 });
  const p = store.startPending("U4").catch((err) => err);
  fireAll();
  const err = await p;
  assert.match(err.message, /expired/);
  assert.equal(store.hasPending("U4"), false);
}

// Case 6: resolving a user whose pending was already replaced doesn't
// resolve the old promise (handled by superseded path above) and returns
// true for the current one.
{
  const store = createOAuthPendingStore();
  store.startPending("U5").catch(() => {});
  const second = store.startPending("U5");
  assert.equal(store.resolvePending("U5", "ok"), true);
  assert.equal(await second, "ok");
}

// Case 7: _sizeForTests reports the count.
{
  const store = createOAuthPendingStore();
  assert.equal(store._sizeForTests(), 0);
  store.startPending("U6").catch(() => {});
  store.startPending("U7").catch(() => {});
  assert.equal(store._sizeForTests(), 2);
  store.cancelPending("U6");
  store.cancelPending("U7");
  assert.equal(store._sizeForTests(), 0);
}

console.log("✓ oauth-pending: all cases pass");
