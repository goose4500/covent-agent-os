> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Pi harness cleanup: drop double-wired SDK options and dead defensive code

**Type**: `cleanup`
**Source**: 2026-05-12 first-principles audit (`docs/research/2026-05-12/audit-24h.md`; Pi harness deep-dive findings)
**Surface**: `apps/pi-mom/lib/pi-sdk-runner.mjs`, `extensions/linear-tools.ts`
**Risk**: Low — no user-visible behavior change. All sub-tasks are SDK-idiomatic replacements of code paths the SDK already handles.
**Expected diff**: ~70 LOC deleted, 0 added (net).

## Context

The foundation-v2 rebuild (PR #24, merged 2026-05-12) replaced the legacy subprocess `pi` bridge with the in-process `@earendil-works/pi-coding-agent@0.74` SDK. The wiring works, but it carries five pieces of belt-and-suspenders code that the SDK already handles natively. One option (`sessionOptions.uiContext`) is a **no-op** — the SDK never reads it. One comment cites a wrong line number to justify it.

This issue collapses those five redundant code paths into their SDK-idiomatic equivalents. Tests should not need to change; the public contract of `runPi(prompt, {…})` is preserved.

## Why

From the Pi harness audit: *"Two unnecessary layers, one wasted env-var setter, two genuinely-required pieces — otherwise idiomatic."* This issue ships the unnecessary layers + the wasted env shim. The two genuinely-required pieces (`PI_OFFLINE`, `PI_AUTH_JSON_B64` seed) stay.

## Sub-tasks

### 1. Replace `noTools` + `setActiveToolsByName` with `sessionOptions.tools`
- [ ] In `apps/pi-mom/lib/pi-sdk-runner.mjs` (currently lines 181-213), delete the `toolsExplicit`/`effectiveAllowTools` branch and the post-create `session.setActiveToolsByName(tools)` call.
- [ ] Replace with `sessionOptions.tools = Array.isArray(tools) ? tools : undefined;` before `createSession(sessionOptions)`.
- [ ] Verify against `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:38-44` (`CreateAgentSessionOptions.tools?: string[]`) and `sdk.js:152-157` (atomic conversion to `allowedToolNames` + `initialActiveToolNames` including custom/extension tools).
- [ ] Keep the legacy `ALLOW_TOOLS = process.env.PI_MOM_ALLOW_PI_TOOLS === "true"` fallback for tests that construct a runner without `tools` — it can flip `sessionOptions.tools` to `undefined`/`[]` to match today's noTools posture.

### 2. Delete the dead `sessionOptions.uiContext` path + the `bindExtensions` try/catch
- [ ] In `pi-sdk-runner.mjs`, remove `if (uiContext) sessionOptions.uiContext = uiContext;` (currently lines 207-208) and its surrounding comment block (204-208).
- [ ] Keep `session.bindExtensions({uiContext})` (currently lines 215-225) but drop the `try/catch` + the stray `try { onOutput?.(""); } catch {}`. If `bindExtensions` throws here, it's a real bug and should not be silently swallowed — let it propagate so the error path in `runPi` (which already rejects the outer Promise) surfaces it.
- [ ] Verify the option doesn't exist: `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:11-55` defines `CreateAgentSessionOptions` with no `uiContext` field; `createAgentSession` in `sdk.js:83-281` never reads one. The line cited by the existing comment (`agent-session.d.ts:109`) is actually `ExtensionBindings.uiContext`, a different shape that only `bindExtensions` consumes (`agent-session.js:1608-1611`).

### 3. Convert `extensions/linear-tools.ts` from `ExtensionAPI` factory → plain `customTools` array
- [ ] Rewrite `extensions/linear-tools.ts` (currently lines 163-422) so it exports an array of three `ToolDefinition`s (`linearSearchIssues`, `linearCreateIssue`, `linearAddComment`) instead of an `ExtensionAPI` factory that calls `pi.registerTool` three times.
- [ ] The `ToolDefinition` shape is at `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:325-359` — it accepts exactly what `pi.registerTool` accepts (name, label, description, parameters, execute, promptSnippet, promptGuidelines).
- [ ] In `pi-sdk-runner.mjs`, drop `linearTools` from `extensionFactories: [permissionGate, linearTools]` (line 157) and pass it via `sessionOptions.customTools = [...linearTools]` instead (`CreateAgentSessionOptions.customTools?: ToolDefinition[]` at `sdk.d.ts:45-46`, wired at `sdk.js:268`).
- [ ] Permission-gate **stays** an `ExtensionAPI` factory — it uses `pi.on("tool_call", …)`, which only the extension surface exposes.
- [ ] Update `apps/pi-mom/test-linear-tools.mjs` to construct tools directly from the array export. No behavior change in tool execution.

### 4. Drop the `PI_AGENT_DIR` → `PI_CODING_AGENT_DIR` env-alias shim
- [ ] Remove `pi-sdk-runner.mjs` lines 24-30 (the `if (process.env.PI_AGENT_DIR && !process.env.PI_CODING_AGENT_DIR)` block).
- [ ] In the auth-storage construction inside `defaultGetDeps()` (currently `pi-sdk-runner.mjs:114-129`), pass the path explicitly: `AuthStorage.create(join(_resolveAgentDir(), "auth.json"))` and pass `agentDir: _resolveAgentDir()` into the `DefaultResourceLoader` options. The SDK then doesn't need to read either env var — we own the path resolution.
- [ ] Verify: `node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.d.ts:48-58` (`AuthStorage.create(path?)`) accepts an explicit path argument.

### 5. Fix the wrong-line citation in the `uiContext` comment
- [ ] Already covered by sub-task 2 (the comment is deleted along with the dead code). No separate action; called out here for traceability.

### 6. Optional follow-up: simplify the `subscribe + agent_end` settle loop
- [ ] Out of scope for this issue but worth flagging: `pi-sdk-runner.mjs:227-288` can collapse to `await Promise.all([session.prompt(text), new Promise(r => session.subscribe(e => e.type === "agent_end" && r()))])`. Skipping this here to keep the diff focused on dead code removal — open a follow-up if desired.

## Acceptance criteria

- [ ] `bun run check` green (secret-scan + validators + 13 pi-mom suites + `tsc --noEmit`).
- [ ] `apps/pi-mom/test-pi-sdk-runner.mjs` still passes with no expectation changes.
- [ ] `apps/pi-mom/test-linear-tools.mjs` updated to import the array export and still passes (24 expects min).
- [ ] Live canary on `covent-pi-mom-v2`: bare `@Covent-Agent uname -a`, `linear: file an issue about X`, `spec: turn this thread into a PRD` all behave identically to pre-PR.
- [ ] Net diff: `pi-sdk-runner.mjs` loses ~40 LOC; `linear-tools.ts` reshapes ~30 LOC (delta near zero); one env shim deleted.

## Out of scope

- The `subscribe + agent_end` simplification (#6 above) — separate issue if desired.
- Any change to `PI_OFFLINE=1` default (genuinely required — `DefaultResourceLoader.reload()` unconditionally calls `packageManager.resolve()` at `resource-loader.js:212`).
- Any change to `PI_AUTH_JSON_B64` seed mechanism (file-write path is the correct shape — `InMemoryAuthStorageBackend` would lose rotated tokens on restart, `auth-storage.js:125,334-339`).
- Any change to `thread-session-map.mjs` (`SessionManager` has no Slack-thread keying, `session-manager.d.ts:296-331`).
- Permission-gate stays a factory (uses `pi.on("tool_call", …)`).

## References

- 24h audit: `docs/research/2026-05-12/audit-24h.md`
- SDK source: `node_modules/@earendil-works/pi-coding-agent/dist/core/`
  - `sdk.d.ts:11-55` — `CreateAgentSessionOptions` (no `uiContext`)
  - `sdk.js:152-157,268` — tools/customTools wiring
  - `agent-session.d.ts:108-113` — `ExtensionBindings.uiContext` (the only `uiContext` surface)
  - `agent-session.js:568-582,1608-1624` — `setActiveToolsByName` + `bindExtensions`
  - `auth-storage.d.ts:48-58,114-134` — file/in-memory backends + OAuth refresh write-back
  - `extensions/types.d.ts:325-359` — `ToolDefinition` shape
