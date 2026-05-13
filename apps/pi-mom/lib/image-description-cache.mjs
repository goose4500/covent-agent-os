// Per-`file_id` cache for Gemini-generated image descriptions.
//
// Slack-uploaded files are immutable (their `file_id` never changes; the
// bytes never get rewritten), so a Gemini description we generated once is
// good forever. That makes this the easiest cache in the system: one file
// per image, write-once-read-many, no TTL, no fingerprinting.
//
// On-disk layout: ~/.pi/agent/image-descriptions/<fileId>.json
//
// Resilience contract:
//   - corrupt files → treat as miss (`null`), next write overwrites
//   - partial writes are impossible (atomic .tmp + rename)
//   - parent dir is created on demand (mkdir -p semantics)
//
// We intentionally do NOT keep an in-memory cache here. The volume is
// fast, the per-file cost is microseconds, and skipping it means
// concurrent describer calls for the same image converge correctly without
// us having to think about a shared map's locking.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function _resolveBaseDir() {
  if (process.env.PI_MOM_IMAGE_DESCRIPTION_DIR) {
    return process.env.PI_MOM_IMAGE_DESCRIPTION_DIR;
  }
  // Match `thread-session-map.mjs` so the same persistent Railway volume
  // (mounted at PI_AGENT_DIR / PI_CODING_AGENT_DIR) backs both. Without the
  // env-var lookup, redeploys would orphan every cached description.
  const agentDir =
    process.env.PI_AGENT_DIR ||
    process.env.PI_CODING_AGENT_DIR ||
    join(homedir() || "/tmp", ".pi", "agent");
  return join(agentDir, "image-descriptions");
}

function _isValidFileId(fileId) {
  // Slack file IDs are short, alphanumeric, no slashes. Anything else is
  // a caller bug and we refuse to let it traverse the filesystem.
  if (!fileId || typeof fileId !== "string") return false;
  return /^[A-Za-z0-9_-]+$/.test(fileId);
}

function _pathFor(baseDir, fileId) {
  return join(baseDir, `${fileId}.json`);
}

/**
 * Returns the cached descriptor entry for `fileId`, or `null` on miss.
 * Corrupt JSON / unreadable files count as a miss — the next `write` will
 * overwrite the bad data atomically.
 */
export async function lookup(
  fileId,
  { baseDir = _resolveBaseDir(), fs = { readFile } } = {},
) {
  if (!_isValidFileId(fileId)) return null;
  try {
    const raw = await fs.readFile(_pathFor(baseDir, fileId), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Must have at least a description to be useful. Anything else (missing
    // model, missing builtAt) we treat as a soft miss so the next call
    // generates a clean, complete record.
    if (typeof parsed.description !== "string" || !parsed.description) {
      return null;
    }
    return parsed;
  } catch {
    // ENOENT, EACCES, JSON syntax error — all collapse into "miss".
    return null;
  }
}

/**
 * Atomically writes `entry` for `fileId`. The temp file lives in the same
 * directory so `rename` is guaranteed to be on the same filesystem and
 * therefore atomic on POSIX.
 */
export async function write(
  fileId,
  entry,
  {
    baseDir = _resolveBaseDir(),
    fs = { writeFile, mkdir, rename },
  } = {},
) {
  if (!_isValidFileId(fileId)) return;
  if (!entry || typeof entry !== "object") return;
  const finalPath = _pathFor(baseDir, fileId);
  // Suffix with a short random so two concurrent writers for the same
  // fileId can't collide on the temp path. Race outcome is still "last
  // writer wins" which is fine — the entries are equivalent by construction.
  const tmpPath = `${finalPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.mkdir(dirname(finalPath), { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2));
  await fs.rename(tmpPath, finalPath);
}

// Test-only: expose the path resolver so tests can isolate inside a temp
// directory without monkey-patching node:os.
export const _internals = { _resolveBaseDir, _pathFor };
