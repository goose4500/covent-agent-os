// Per-thread Pi session resumption. Looks up a Slack threadTs in the
// thread-session-map, opens the corresponding SessionManager file (or
// creates a fresh one if absent or stale), and delegates the actual
// streaming to pi-sdk-runner.runPi with the resolved SessionManager.
//
// Tool/skill/extension availability is default-on in the runner — the
// bridge no longer routes user messages through a fixed set of prefixed
// workflows, so this layer just hands the prompt to the agent and lets
// it choose tools/skills dynamically.
//
// Public surface:
//   runTurn({ surface, threadTs, prompt, onOutput, signal, sink, uiContext }) → Promise<string>
//
// Factory `createSession` is DI-friendly for tests: inject runPi, the map,
// the SessionManager class, and the fs.existsSync probe.

import { existsSync } from "node:fs";
import { SessionManager as DefaultSessionManager } from "@earendil-works/pi-coding-agent";
import { runPi as defaultRunPi } from "./pi-sdk-runner.mjs";
import { createThreadSessionMap } from "./thread-session-map.mjs";

const DEFAULT_WORKDIR =
  process.env.PI_WORKDIR || process.env.HOME || process.cwd();

export function createSession({
  threadSessionMap,
  runPi = defaultRunPi,
  SessionManager = DefaultSessionManager,
  fileExists = existsSync,
  workdir = DEFAULT_WORKDIR,
  trace = () => {},
} = {}) {
  const map = threadSessionMap || createThreadSessionMap();

  async function runTurn({ surface, threadTs, prompt, onOutput, signal, sink, uiContext } = {}) {
    if (!threadTs) throw new Error("runTurn requires threadTs");
    if (typeof prompt !== "string" || !prompt) {
      throw new Error("runTurn requires non-empty prompt");
    }

    const existing = await map.get(threadTs);
    let sessionManager;
    let resumed = false;
    if (existing && fileExists(existing)) {
      try {
        sessionManager = SessionManager.open(existing);
        resumed = true;
      } catch (error) {
        trace("pi_session.open_failed", {
          threadTs,
          path: existing,
          error: error?.message || String(error),
        });
        sessionManager = SessionManager.create(workdir);
      }
    } else {
      sessionManager = SessionManager.create(workdir);
    }
    trace("pi_session.session_resolved", {
      surface,
      threadTs,
      resumed,
      toolMode: "all",
    });

    const runPiOptions = { onOutput, signal, sessionManager };
    if (sink) runPiOptions.sink = sink;
    if (uiContext) runPiOptions.uiContext = uiContext;
    const result = await runPi(prompt, runPiOptions);

    const sessionFile = sessionManager.getSessionFile?.();
    if (sessionFile) {
      await map.set(threadTs, sessionFile);
      trace("pi_session.session_persisted", { surface, threadTs, sessionFile });
    }

    return result;
  }

  return { runTurn };
}

const _defaultSession = createSession();
export const runTurn = _defaultSession.runTurn;
