// Per-thread summary index — telemetry/inspection only.
//
// Mirrors `lib/thread-session-map.mjs` and `lib/image-description-cache.mjs`
// (volume placement, atomic .tmp + rename writes, corrupt-file tolerance).
// One JSON file per thread under
//   <agentDir>/thread-summaries/<threadTs>.json
//
// IMPORTANT: this is **write-only telemetry** for the v1 design. The
// `buildThreadContext()` flow always regenerates the summary on each
// `app_mention` — it does NOT consult `get()` for hits. We persist the
// entry so operators can inspect what got summarized and how, without
// paying the cost of cache invalidation reasoning. See design doc §5.
//
// Entry shape:
//   {
//     summary: string,      // the Gemini-or-fallback summary text
//     cutoffTs: string,     // ts of the last "older" message included
//     fileFingerprint: string, // hash-ish of file ids included (telemetry)
//     route: string,        // action route name (`plain`, `linear:`, …)
//     builtAt: number       // ms epoch when this entry was written
//   }
//
// Resilience contract (matches image-description-cache):
//   - corrupt files / unreadable files → treat as miss (returns `null`)
//   - atomic write via `<final>.<pid>.<rand>.tmp` + `rename`
//   - parent dir created on demand (mkdir recursive)

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function _resolveBaseDir() {
  if (process.env.PI_MOM_THREAD_SUMMARY_DIR) {
    return process.env.PI_MOM_THREAD_SUMMARY_DIR;
  }
  // Same volume convention as `thread-session-map.mjs` /
  // `image-description-cache.mjs` — without this, Railway redeploys would
  // orphan every cached thread summary.
  const agentDir =
    process.env.PI_AGENT_DIR ||
    process.env.PI_CODING_AGENT_DIR ||
    join(homedir() || "/tmp", ".pi", "agent");
  return join(agentDir, "thread-summaries");
}

// Slack thread timestamps look like `1700000000.123456`. We allow digits,
// dots, dashes, and underscores — anything else is a caller bug and we
// refuse to let it traverse the filesystem.
function _isValidThreadTs(threadTs) {
  if (!threadTs || typeof threadTs !== "string") return false;
  return /^[A-Za-z0-9._-]+$/.test(threadTs);
}

function _pathFor(baseDir, threadTs) {
  return join(baseDir, `${threadTs}.json`);
}

/**
 * Returns the persisted summary entry for `threadTs`, or `null` on miss.
 * Corrupt JSON / unreadable files count as a miss — the next `set()` will
 * overwrite the bad data atomically.
 *
 * NOTE: per design doc §5, the production read path does NOT call this —
 * we always regenerate. It exists for inspection/debugging.
 */
export async function get(
  threadTs,
  { baseDir = _resolveBaseDir(), fs = { readFile } } = {},
) {
  if (!_isValidThreadTs(threadTs)) return null;
  try {
    const raw = await fs.readFile(_pathFor(baseDir, threadTs), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // A useful entry must at least have a `summary` string. Anything else
    // we treat as a soft miss so the next `set()` produces a clean record.
    if (typeof parsed.summary !== "string" || !parsed.summary) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomically write `entry` for `threadTs`. Temp file lives in the same
 * directory so `rename` is on the same filesystem (atomic on POSIX).
 */
export async function set(
  threadTs,
  entry,
  {
    baseDir = _resolveBaseDir(),
    fs = { writeFile, mkdir, rename },
  } = {},
) {
  if (!_isValidThreadTs(threadTs)) return;
  if (!entry || typeof entry !== "object") return;
  const finalPath = _pathFor(baseDir, threadTs);
  const tmpPath = `${finalPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.mkdir(dirname(finalPath), { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2));
  await fs.rename(tmpPath, finalPath);
}

/**
 * Best-effort deletion of the entry for `threadTs`. Missing file is a no-op.
 */
export async function del(
  threadTs,
  { baseDir = _resolveBaseDir(), fs = { unlink } } = {},
) {
  if (!_isValidThreadTs(threadTs)) return;
  try {
    await fs.unlink(_pathFor(baseDir, threadTs));
  } catch {
    /* missing file / EACCES — nothing actionable here */
  }
}

// `delete` is reserved as an identifier so we export `del`; the README
// for this module documents the naming. Callers should `import { del }`.

// Test-only: expose the path resolver so tests can isolate inside a temp
// directory without monkey-patching node:os.
export const _internals = { _resolveBaseDir, _pathFor };
