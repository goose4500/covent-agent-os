// Event ledger for the event-driven Pi runtime (issue #48, phase 2).
//
// Append-only JSONL writer. One line per entry. Used by:
//
//   - event-receiver.mjs (Phase 1) — writes "started" / "completed" / "error"
//     entries from inside the setImmediate callback that runs after the HTTP
//     response is flushed.
//   - The integrator (Phase 3) — writes route-match, destination-resolved,
//     and session-completed milestones so a single grep on a deliveryId can
//     reconstruct what happened.
//
// Design choices:
//
//   - Sync I/O (`appendFileSync`). Each call is one short JSON line; the
//     extra overhead is below the noise floor of an outbound HTTP call. The
//     receiver already responded to the webhook before calling us, so we
//     are not blocking the request thread. Sync is simpler than queueing
//     and impossible to lose-on-crash.
//
//   - Errors are swallowed. The ledger is a debugging aid, not a system of
//     record. If the disk is full, the directory got chmod 000, the
//     filesystem is read-only, etc., the ledger MUST NOT take the runtime
//     down. Errors go to `logger.error` and the function returns normally.
//
//   - No batching. One entry, one line, one write. Predictable for `tail -f`
//     during incident response and trivial for `jq -c` to consume.
//
//   - `fs` is injected. Real callers get `node:fs`; tests can hand in a
//     thin double when they want to assert on I/O errors without creating
//     real read-only directories.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The default fs surface only exposes what the ledger touches — keeps the
// injection contract small and avoids tests having to mock the entire `fs`
// module surface area when they only care about these two calls.
const realFs = {
  appendFileSync,
  mkdirSync,
};

/**
 * Create a ledger writer bound to a single JSONL file.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] - JSONL file path. Created on first append.
 * @param {{appendFileSync: Function, mkdirSync: Function}} [opts.fs] - injected for tests
 * @param {{error?: Function, warn?: Function}} [opts.logger]
 * @param {() => string} [opts.now] - ISO timestamp factory
 */
export function createEventLedger({
  path = "sessions/event-runs.jsonl",
  fs = realFs,
  logger = console,
  now = () => new Date().toISOString(),
} = {}) {
  // mkdir tracking: we only want to call mkdirSync once per ledger instance.
  // EEXIST from mkdir is cheap (recursive:true makes it a no-op), but
  // remembering avoids even the syscall on the steady-state path.
  let parentEnsured = false;

  function ensureParent() {
    if (parentEnsured) return;
    try {
      fs.mkdirSync(dirname(path), { recursive: true });
      parentEnsured = true;
    } catch (err) {
      // Note we do NOT flip parentEnsured — a transient mkdir failure should
      // not become permanent. The next append() will try again.
      try {
        logger?.error?.(
          `event-ledger mkdir failed for ${path}: ${err?.message || err}`,
        );
      } catch {}
    }
  }

  return {
    /**
     * Append one entry to the ledger. Synchronous from the caller's POV but
     * errors are logged not thrown — never crashes the runtime.
     *
     * Entry shape (flexible; nothing is required, but these are the keys
     * the receiver + integrator actually write):
     *
     *   { deliveryId, source, event, status,
     *     route?, sessionId?, error?,
     *     startedAt?, completedAt?, ts? }
     *
     * If `ts` is missing, the ledger injects one from `now()` so every line
     * has a wall-clock timestamp suitable for `jq 'select(.ts > ...)'`.
     *
     * @param {object} entry
     */
    append(entry) {
      // Always inject a `ts` if the caller didn't already. We do this before
      // serialization so the order of keys in the JSONL is stable:
      // ts-first lines are pleasant to scan with `tail -f`.
      const enriched =
        entry && typeof entry === "object" && entry !== null && "ts" in entry
          ? entry
          : { ts: now(), ...(entry || {}) };

      let line;
      try {
        line = JSON.stringify(enriched) + "\n";
      } catch (err) {
        // Cyclic refs, BigInt, etc. — log and bail. We deliberately do not
        // try to "rescue" the entry by stripping fields because that masks
        // a real bug at the call site.
        try {
          logger?.error?.(
            `event-ledger JSON.stringify failed for ${path}: ${err?.message || err}`,
          );
        } catch {}
        return;
      }

      ensureParent();

      try {
        fs.appendFileSync(path, line, "utf8");
      } catch (err) {
        try {
          logger?.error?.(
            `event-ledger appendFileSync failed for ${path}: ${err?.message || err}`,
          );
        } catch {}
      }
    },

    // Exposed for tests. Treat as read-only.
    _path: path,
  };
}
