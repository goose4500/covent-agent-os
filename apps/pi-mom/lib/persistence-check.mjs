// Verifies that PI_AGENT_DIR survives across deploys. The OAuth gate stores
// per-user auth.json under PI_AGENT_DIR/users/<id>/auth.json — if Railway
// (or whatever host the bot runs on) doesn't mount a persistent volume
// here, every restart wipes user credentials and forces re-sign-in.
//
// Mechanism: write a `.persistence-marker` containing the current boot
// timestamp on every startup. On the next boot, if the marker exists with
// a timestamp from a *prior* process, the volume is persistent. If the
// marker is missing, either this is the first boot after enabling the
// check, or the volume is ephemeral. Two consecutive boots are needed for
// a definitive "persistent" verdict.
//
// Intentionally a one-shot side-effect at preflight, not a periodic check
// — the answer never changes during a single process's lifetime.

import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MARKER_NAME = ".persistence-marker";

export function checkPersistence({
  baseDir,
  now = () => new Date(),
  log = (...args) => console.log(...args),
  warn = (...args) => console.warn(...args),
  fileExists = existsSync,
  fileStat = statSync,
  writeFile = writeFileSync,
  ensureDir = (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
} = {}) {
  if (!baseDir) throw new Error("checkPersistence: baseDir is required");

  const markerPath = join(baseDir, MARKER_NAME);
  const bootIso = now().toISOString();

  let priorBootIso = null;
  try {
    if (fileExists(markerPath)) {
      priorBootIso = fileStat(markerPath).mtime.toISOString();
    }
  } catch (err) {
    warn(`⚠ persistence check: stat failed at ${markerPath}: ${err?.message || err}`);
  }

  try {
    ensureDir(baseDir);
    writeFile(markerPath, bootIso, { mode: 0o600 });
  } catch (err) {
    warn(
      `⚠ persistence check: cannot write marker at ${markerPath}: ${err?.message || err}. ` +
      `Per-user OAuth credentials may not persist.`,
    );
    return { persistent: null, markerPath, priorBootIso: null, bootIso, error: String(err?.message || err) };
  }

  if (priorBootIso) {
    log(
      `✓ PI_AGENT_DIR is persistent at ${baseDir} ` +
      `(marker from prior boot: ${priorBootIso}; this boot: ${bootIso})`,
    );
    return { persistent: true, markerPath, priorBootIso, bootIso };
  }

  warn(
    `⚠ PI_AGENT_DIR has no prior-boot marker at ${markerPath}. ` +
    `If this is the first boot after merging the OAuth gate, that's expected — ` +
    `redeploy once and re-check. ` +
    `If you see this on every subsequent boot, the volume is NOT mounted and ` +
    `per-user auth.json will be wiped on every restart.`,
  );
  return { persistent: false, markerPath, priorBootIso: null, bootIso };
}
