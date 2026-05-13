// Per-Slack-user AuthStorage instances, keyed by Slack user_id and persisted
// as one auth.json per user on the same volume the bot already uses for
// thread sessions. Pi's FileAuthStorageBackend handles file locking
// (proper-lockfile) and 0o600 perms, so we just have to hand it a per-user
// path and cache the instance so concurrent turns share the same lock.
//
// Layout under PI_AGENT_DIR (defaults to ~/.pi/agent):
//   users/<slackUserId>/auth.json     ← OAuth + API key creds for that user
//   thread-sessions.json              ← existing per-thread session map
//   auth.json                         ← legacy global creds (unused in pi-mom
//                                       once first-interaction gate is on,
//                                       but kept for tests + echo mode).
//
// Pi's AuthStorage.create(path) is synchronous and tolerates a missing file
// on first read — the underlying ensureFileExists call creates it lazily on
// first write. ModelRegistry.create(authStorage) binds to the provided
// storage, so we cache the registry alongside the storage.

import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

export const CODEX_PROVIDER_ID = "openai-codex";

function resolveAgentDir() {
  return (
    process.env.PI_AGENT_DIR ||
    process.env.PI_CODING_AGENT_DIR ||
    join(homedir(), ".pi", "agent")
  );
}

function authPathForUser(slackUserId, baseDir = resolveAgentDir()) {
  if (!slackUserId || typeof slackUserId !== "string") {
    throw new Error("user-auth-store: slackUserId is required");
  }
  if (!/^[A-Z0-9]{1,32}$/.test(slackUserId)) {
    throw new Error(`user-auth-store: invalid slackUserId '${slackUserId}'`);
  }
  return join(baseDir, "users", slackUserId, "auth.json");
}

export function createUserAuthStore({
  baseDir,
  createAuthStorage = (path) => AuthStorage.create(path),
  createModelRegistry = (storage) => ModelRegistry.create(storage),
  ensureDir = (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
} = {}) {
  const cache = new Map(); // slackUserId -> { authStorage, modelRegistry, path }

  function authPath(slackUserId) {
    return authPathForUser(slackUserId, baseDir || resolveAgentDir());
  }

  function get(slackUserId) {
    const existing = cache.get(slackUserId);
    if (existing) return existing;

    const path = authPath(slackUserId);
    ensureDir(dirname(path));
    const authStorage = createAuthStorage(path);
    const modelRegistry = createModelRegistry(authStorage);
    const entry = { authStorage, modelRegistry, path };
    cache.set(slackUserId, entry);
    return entry;
  }

  function hasCodexAuth(slackUserId) {
    try {
      const { authStorage } = get(slackUserId);
      return typeof authStorage.hasAuth === "function"
        ? authStorage.hasAuth(CODEX_PROVIDER_ID)
        : authStorage.has(CODEX_PROVIDER_ID);
    } catch {
      return false;
    }
  }

  function forget(slackUserId) {
    cache.delete(slackUserId);
  }

  function _sizeForTests() {
    return cache.size;
  }

  return { get, hasCodexAuth, forget, authPath, _sizeForTests };
}

const _defaultStore = createUserAuthStore();
export const getUserAuth = _defaultStore.get;
export const hasCodexAuth = _defaultStore.hasCodexAuth;
export const forgetUser = _defaultStore.forget;
export const authPathFor = _defaultStore.authPath;
