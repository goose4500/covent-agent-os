// Stage-0 gate for the foundation-v2 rebuild.
//
// Verifies that under bun:
//   1. @slack/bolt loads and `new App(...)` + `new Assistant(...)` instantiate
//      without runtime errors (no token network call).
//   2. @earendil-works/pi-coding-agent loads and exposes the core primitives
//      the rebuild plan depends on (createAgentSession, SessionManager,
//      AuthStorage, ModelRegistry).
//   3. SessionManager.inMemory() returns a usable instance without disk I/O.
//   4. AuthStorage.create() / ModelRegistry.create() construct without throwing.
//
// If any check fails, Stage 1 is blocked. Run via `bun apps/pi-mom/test-bun-compat.mjs`.

import { strict as assert } from "node:assert";
import { App, LogLevel, Assistant } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

// 1. Bolt App constructs (Socket Mode, never connects without real tokens).
// tokenVerificationEnabled:false + deferInitialization:true skip the
// auth.test() call that Bolt would otherwise fire during instantiation.
const app = new App({
  token: "xoxb-fake-for-instantiation-only",
  appToken: "xapp-fake-for-instantiation-only",
  socketMode: true,
  logLevel: LogLevel.ERROR,
  tokenVerificationEnabled: false,
  deferInitialization: true,
});
assert.equal(typeof app.event, "function", "App should expose .event()");
assert.equal(typeof app.action, "function", "App should expose .action()");
assert.equal(typeof app.view, "function", "App should expose .view()");
console.log("ok   @slack/bolt App constructs under bun");

// 2. Bolt Assistant container constructs.
const assistant = new Assistant({
  threadStarted: async () => {},
  userMessage: async () => {},
});
assert.ok(assistant, "Assistant should construct");
console.log("ok   @slack/bolt Assistant constructs under bun");

// 3. WebClient constructs (no network call).
const web = new WebClient("xoxb-fake");
assert.equal(typeof web.chat.postMessage, "function");
assert.equal(typeof web.assistant.threads.setStatus, "function", "WebClient should expose assistant.threads.setStatus (Bolt 4.7+)");
assert.equal(typeof web.canvases.create, "function", "WebClient should expose canvases.create");
// chat.startStream is added at runtime by chat-stream extension; only check method shape exists.
console.log("ok   @slack/web-api WebClient exposes 2026 surfaces (assistant.threads, canvases)");

// 4. Pi SDK primitives are importable + callable.
assert.equal(typeof createAgentSession, "function", "createAgentSession should be a function");
assert.equal(typeof SessionManager, "function", "SessionManager should be a class");
assert.equal(typeof SessionManager.inMemory, "function", "SessionManager.inMemory should be a static method");
assert.equal(typeof SessionManager.create, "function", "SessionManager.create should be a static method");
console.log("ok   @earendil-works/pi-coding-agent exports core primitives under bun");

// 5. SessionManager.inMemory() returns a usable instance.
const sm = SessionManager.inMemory();
assert.ok(sm, "SessionManager.inMemory() should return an instance");
console.log("ok   SessionManager.inMemory() constructs");

// 6. AuthStorage + ModelRegistry construct (no auth required for instantiation).
const auth = await AuthStorage.create();
assert.ok(auth, "AuthStorage.create() should return an instance");
const registry = ModelRegistry.create(auth);
assert.ok(registry, "ModelRegistry.create(auth) should return an instance");
console.log("ok   AuthStorage + ModelRegistry construct without provider keys");

console.log("\nbun-compat smoke test passed — Stage 1 unblocked.");
