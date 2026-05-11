import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function sanitizeRun(run = {}) {
  const allowed = [
    "id", "status", "runnerMode", "prompt", "channel", "threadTs", "messageTs", "user", "team", "sourceUrl",
    "createdAt", "updatedAt", "startedAt", "finishedAt", "approvedBy", "canceledBy", "events", "result", "canvas", "error",
  ];
  const out = {};
  for (const key of allowed) {
    if (run[key] !== undefined) out[key] = run[key];
  }
  out.events = Array.isArray(out.events) ? out.events : [];
  return out;
}

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
  let state = { runs: [], sessions: {} };

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
        state = {
          runs: Array.isArray(parsed.runs) ? parsed.runs.map(sanitizeRun) : [],
          sessions: sanitizeSessions(parsed.sessions),
        };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = { runs: [], sessions: {} };
      }
      trace("agent.store_loaded", { runs: state.runs.length, sessions: Object.keys(state.sessions).length });
      return state;
    },

    async create(draft) {
      const run = sanitizeRun({ ...draft, createdAt: draft.createdAt || nowIso(), updatedAt: draft.updatedAt || nowIso() });
      if (!run.id) throw new Error("run id is required");
      if (state.runs.some((existing) => existing.id === run.id)) throw new Error(`run already exists: ${run.id}`);
      state.runs.unshift(run);
      await persist();
      return run;
    },

    async get(id) {
      return state.runs.find((run) => run.id === id);
    },

    async update(id, patch) {
      const index = state.runs.findIndex((run) => run.id === id);
      if (index < 0) throw new Error(`run not found: ${id}`);
      const merged = sanitizeRun({ ...state.runs[index], ...patch, updatedAt: patch.updatedAt || nowIso() });
      state.runs[index] = merged;
      await persist();
      return merged;
    },

    async listRecent(limit = 20) {
      return state.runs.slice(0, limit);
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
