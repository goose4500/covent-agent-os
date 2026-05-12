// Threadwise persistence for Pi sessions. Maps a Slack thread timestamp to
// the SessionManager session file on disk so the next mention in the same
// thread resumes the same Pi conversation (read/branch/think state, etc).
//
// On-disk format (JSON):
//   {
//     "entries": {
//       "<threadTs>": { "sessionFile": "/abs/path/...jsonl", "lastTouched": 1700000000000 }
//     }
//   }
//
// LRU-evicted at `maxEntries` (oldest `lastTouched` first). Write-through on
// every `set` keeps the file in sync with in-memory state. Single-process —
// not safe for concurrent writers; pi-mom is one process anyway.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// The map lives next to the SDK's session storage so a persistent Railway
// volume (mounted at PI_AGENT_DIR / PI_CODING_AGENT_DIR) keeps thread→session
// continuity across container restarts. Without this the JSON would land on
// ephemeral disk and every redeploy would orphan in-flight thread sessions.
function _resolveDefaultThreadSessionPath() {
  if (process.env.PI_MOM_THREAD_SESSION_PATH) {
    return process.env.PI_MOM_THREAD_SESSION_PATH;
  }
  const agentDir =
    process.env.PI_AGENT_DIR ||
    process.env.PI_CODING_AGENT_DIR ||
    `${process.env.HOME || "/tmp"}/.pi/agent`;
  return join(agentDir, "pi-mom", "thread-sessions.json");
}

const DEFAULT_PATH = _resolveDefaultThreadSessionPath();

export function createThreadSessionMap({
  path = DEFAULT_PATH,
  maxEntries = 200,
  fs = { readFile, writeFile, mkdir },
  now = () => Date.now(),
} = {}) {
  let state = null;
  let loadPromise = null;

  async function ensureLoaded() {
    if (state) return state;
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const raw = await fs.readFile(path, "utf-8");
          const parsed = JSON.parse(raw);
          state = parsed && typeof parsed === "object" && parsed.entries
            ? parsed
            : { entries: {} };
        } catch {
          state = { entries: {} };
        }
        return state;
      })();
    }
    return loadPromise;
  }

  async function persist() {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(state, null, 2));
  }

  function evictOldest() {
    const keys = Object.keys(state.entries);
    if (keys.length <= maxEntries) return;
    const sorted = keys
      .map((k) => [k, state.entries[k]?.lastTouched || 0])
      .sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.length - maxEntries;
    for (let i = 0; i < toRemove; i++) {
      delete state.entries[sorted[i][0]];
    }
  }

  return {
    async get(threadTs) {
      if (!threadTs) return undefined;
      await ensureLoaded();
      return state.entries[threadTs]?.sessionFile;
    },
    async set(threadTs, sessionFile) {
      if (!threadTs || !sessionFile) return;
      await ensureLoaded();
      state.entries[threadTs] = { sessionFile, lastTouched: now() };
      evictOldest();
      await persist();
    },
    async clear() {
      state = { entries: {} };
      await persist();
    },
    async snapshot() {
      await ensureLoaded();
      const entries = {};
      for (const [k, v] of Object.entries(state.entries)) {
        entries[k] = { ...v };
      }
      return { ...state, entries };
    },
  };
}
