// JSON-backed map of Slack threadTs → on-disk Pi session file path.
//
// pi-runtime.mjs calls getSessionPathForThread() to decide whether to
// SessionManager.open() (resume) or SessionManager.create() (fresh), and
// setSessionPathForThread() to persist the path that the SDK assigned after
// a fresh create. Disk shape:
//
//   { "sessions": { "<threadTs>": "<absolute path to session.jsonl>" } }
//
// Older versions of this file also stored a `runs: []` array for the legacy
// bounded-runner approval-card flow. That flow has been deleted; the loader
// silently ignores the field if a tracked file still has it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function sanitizeSessions(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || typeof value !== "string") continue;
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

export function createRunStore({ path, trace = () => {} } = {}) {
  if (!path) throw new Error("run store path is required");
  let state = { sessions: {} };

  async function persist() {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  }

  return {
    async load() {
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        state = { sessions: sanitizeSessions(parsed.sessions) };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = { sessions: {} };
      }
      trace("session.store_loaded", { sessions: Object.keys(state.sessions).length });
      return state;
    },

    async getSessionPathForThread(threadTs) {
      if (typeof threadTs !== "string" || !threadTs) return undefined;
      const value = state.sessions[threadTs];
      return typeof value === "string" && value ? value : undefined;
    },

    async setSessionPathForThread(threadTs, sessionFilePath) {
      if (typeof threadTs !== "string" || !threadTs) {
        throw new Error("setSessionPathForThread: threadTs must be a non-empty string");
      }
      if (typeof sessionFilePath !== "string" || !sessionFilePath) {
        throw new Error("setSessionPathForThread: sessionFilePath must be a non-empty string");
      }
      state.sessions[threadTs] = sessionFilePath;
      await persist();
    },

    async deleteSessionPathForThread(threadTs) {
      if (typeof threadTs !== "string" || !threadTs) return;
      if (state.sessions[threadTs] === undefined) return;
      delete state.sessions[threadTs];
      await persist();
    },
  };
}
