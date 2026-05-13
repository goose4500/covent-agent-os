// Bounded in-memory dedup cache for webhook delivery IDs.
//
// Phase-1 of the event-driven Pi runtime (see issue #48): we need a cheap way
// to ignore retried webhooks. Linear (and GitHub) re-deliver on 5xx or on
// network blips, and our handler must not double-fire downstream agents.
//
// Design notes:
//   - Map preserves insertion order, so we get FIFO eviction for free once
//     `size > maxEntries`.
//   - TTL is checked lazily on `seen()`: if the recorded timestamp is older
//     than `ttlMs`, we treat the key as unseen and clear the stale entry.
//     Avoiding a background interval keeps this module pure and testable.
//   - `_prune()` is exposed for tests that want to force a sweep without
//     calling `seen()` for every key. Production callers don't need it.
//
// No external deps; no I/O. Same shape as other DI-friendly factories in
// apps/pi-mom/lib so the receiver can take a dedup instance via options.

const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h: covers Linear's retry window

export function createDedupCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) {
  const entries = new Map(); // key -> recordedAtMs

  function isExpired(recordedAt) {
    return now() - recordedAt > ttlMs;
  }

  function seen(key) {
    if (!entries.has(key)) return false;
    const recordedAt = entries.get(key);
    if (isExpired(recordedAt)) {
      // Lazy expiry: drop the stale entry so the next record() can re-insert.
      entries.delete(key);
      return false;
    }
    return true;
  }

  function record(key) {
    // Re-insert to refresh insertion order on update (rare, but keeps the
    // FIFO eviction honest).
    if (entries.has(key)) entries.delete(key);
    entries.set(key, now());
    // FIFO trim. Loop in case maxEntries was lowered between records.
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }
  }

  function size() {
    return entries.size;
  }

  function _prune() {
    for (const [key, recordedAt] of entries) {
      if (isExpired(recordedAt)) entries.delete(key);
    }
  }

  return { seen, record, size, _prune };
}
