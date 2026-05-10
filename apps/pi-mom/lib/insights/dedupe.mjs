export function createDedupeStore({ ttlMs }) {
  const seen = new Map();

  function gc(now) {
    if (seen.size < 256) return;
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(key);
    }
  }

  return {
    checkAndRecord(hash) {
      const now = Date.now();
      gc(now);
      const expiresAt = seen.get(hash);
      if (expiresAt && expiresAt > now) return true;
      seen.set(hash, now + ttlMs);
      return false;
    },
    size() {
      return seen.size;
    },
    clear() {
      seen.clear();
    },
  };
}
