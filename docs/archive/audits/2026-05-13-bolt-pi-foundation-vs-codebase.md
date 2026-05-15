> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Bolt + Pi foundation guide vs. covent-agent-os — point-by-point audit

Date: 2026-05-13
Branch: `claude/audit-codebase-architecture-EhgLY`
Scope: Compares an external "Recommended foundation" guide (TS Bolt + Pi AgentSession + TypeBox tools + SKILL.md + YAML config) against the current state of `covent-agent-os` (commit `80b1618` on `main`).

This audit is mechanical and code-grounded: every codebase claim links a file and line. Verdicts use four buckets:

- **Match**: codebase already follows the recommendation.
- **Partial**: codebase follows the spirit but misses an explicit detail.
- **Mismatch**: codebase diverges; the divergence is either explicit (documented elsewhere) or unintentional.
- **N/A**: recommendation does not yet apply (e.g. GitHub integration that does not exist).

Reading order follows the guide's section order.

---

## 1. Recommended foundation

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| TypeScript Slack app for a small engineering team | The Slack app is `apps/pi-mom`, an ES-module **JavaScript** (`.mjs`) Bolt app — not TypeScript. Extensions (`extensions/*.ts`, `packages/pi-ext-covent-aws`) and inline factories are TS; the entrypoint and lib are `.mjs`. | **Partial** | Effectively a hybrid: tools and policy live in `.ts`, but the Slack glue is plain JS. `package.json` at the root runs `tsc --noEmit` over the workspace for type-only checking. There is no TS build step; Bun's native `.ts` loader is used at runtime (`apps/pi-mom/lib/pi-sdk-runner.mjs:87` imports `extensions/permission-gate.ts` directly). |
| Bolt JS for Slack events, routing, messages, buttons, and UI | `apps/pi-mom/index.mjs:1` imports `App, Assistant, LogLevel` from `@slack/bolt` v4.6. Action/view handlers cover button + modal flows. | **Match** | Uses the Assistant container (`index.mjs:928-959`) in addition to the legacy `app_mention` + `message.im` adapter. The guide explicitly suggests Assistant surfaces are "phase 2"; pi-mom enabled them already. |
| Pi SDK / AgentSession as the reasoning and execution engine | `apps/pi-mom/lib/pi-sdk-runner.mjs:154-307` builds Pi sessions via `createAgentSession` from `@earendil-works/pi-coding-agent`. `apps/pi-mom/lib/pi-session.mjs:34-82` is the per-thread session runner. | **Match** | The legacy `spawn(PI_COMMAND, ...)` subprocess runner has been removed (see `pi-sdk-runner.mjs:1-12` comment). All Pi work is now in-process via the SDK, including `setActiveToolsByName` for per-Action gating. |
| TypeBox-defined tools for Linear, GitHub, Slack, repo access | `extensions/linear-tools.ts:30-31` imports `Type` from `typebox` and registers three typed Linear tools via `pi.registerTool` with `parameters: Type.Object({...})`. Repo access (read/grep/find/edit/write/bash) uses Pi's **built-in** tools — they are typed by the SDK, not TypeBox. There are no Slack tools and no GitHub tools. | **Partial** | TypeBox is used where the codebase defines tools (Linear, the planned `browser_use_run`). Slack context is fetched via Slack Web API directly inside `index.mjs:265-279` (`getThreadMessages` / `getThreadContext`) and is not exposed to the model as a tool. |
| SKILL.md files for repeatable workflows | `skills/` contains 57 skill directories, each with a `SKILL.md`. | **Match** | Inventory is far larger than the guide implies (the guide suggests ~7 to start: `linear-triage`, `github-pr-review`, etc.). pi-mom's Pi resource loader currently **disables** skill loading at runtime (`pi-sdk-runner.mjs:179` sets `noSkills: true`), so these files exist as durable knowledge but are not loaded into the model's prompt by the Slack bridge. |
| YAML only for declarative configuration | YAML drives `apps/pi-mom/manifest.yaml`, `apps/pi-mom/control-plane/registry.yaml`, `agent-kits/profiles/*.yaml`, `railway.toml` is TOML, `apps/pi-mom/nixpacks.toml` is TOML. | **Match** | No YAML is used for executable logic. Route gating is loaded from YAML into JS objects (`apps/pi-mom/lib/control-plane/registry-loader.mjs:117-119`). |
| Do not start with a giant multi-agent framework, MCP sprawl, or a "do-anything" bot | One Slack bridge → one Pi `AgentSession` per Slack thread. Pi resource loader has `noExtensions: true`, `noSkills: true`, `noPromptTemplates: true`, `noContextFiles: true` (`pi-sdk-runner.mjs:174-180`). | **Match** | Two inline factories are added explicitly: `permission-gate` and `linear-tools`. There is no model-driven subagent dispatch at runtime. MCP is bounded — `manifest.yaml:87` sets `is_mcp_enabled: false`. |
| Start with one reliable loop (Slack thread → Bolt → thread session store → Pi AgentSession → small typed tool set → streamed Slack response → auditable state and approvals) | The loop is implemented end-to-end: `index.mjs:915-923` (Bolt routing) → `lib/dispatch.mjs` → `index.mjs:620-726` (`handleRequest`) → `lib/pi-session.mjs:34-82` (thread → session map) → `lib/pi-sdk-runner.mjs` (Pi) → `lib/slack-sink.mjs` (chat-stream) → `lib/slack-ui-context.mjs` (approvals). | **Match** | The "auditable state" portion is the weakest link — see §14 below. Approvals are visible in Slack and in the App Home (`lib/home-view.mjs`), but there is no durable tool-call audit log written to disk. Trace events are stdout-only. |
| Slack is the control plane / Pi is the reasoning engine / Linear is task SOR / GitHub is code SOR | Slack and Pi are wired this way. Linear is the task SOR (`docs/AGENT_CONTEXT.md:54`, `docs/adr/0002-linear-is-execution-truth.md`). GitHub has **no integration** in code. | **Partial** | The GitHub claim exists only in docs and ADR text; there is no Octokit dependency, no GitHub App, no PR or issue tools. The "code SOR" boundary lives entirely on the human side via `git push`. |

---

## 2. First-principles architecture

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Treat a Slack thread as the smallest durable unit of work | `apps/pi-mom/lib/thread-session-map.mjs:36-107` maps Slack `threadTs` → Pi `sessionFile` and persists to disk under `PI_AGENT_DIR/pi-mom/thread-sessions.json`. | **Match** | The map is process-local (single-process Railway worker); concurrent writers would race (`thread-session-map.mjs:14`). For a one-process bot this is fine. |
| Use one active Pi session per Slack thread | `lib/pi-session.mjs:40-57` either opens the existing `SessionManager` file or creates a fresh one keyed by `threadTs`. | **Match** | Resumption only happens if the session file still exists on disk; otherwise a new session is created and traced (`pi-session.mjs:48-54`). |
| Key sessions by `team_id + channel_id + thread_ts` | Sessions are keyed by `threadTs` **alone**. See `lib/thread-session-map.mjs:82-93` and the caller in `lib/pi-session.mjs:40`. | **Mismatch (minor)** | Slack `thread_ts` is unique within a workspace+channel, so single-workspace deployments are safe. Across workspaces, two `thread_ts` collisions would currently share a Pi session. The bot is single-workspace today (`SLACK_ALLOWED_CHANNEL_ID` gate + `EXPECTED_SLACK_BOT_USER` preflight) so this is a latent risk, not a live bug. |
| Each Slack thread should contain intent, follow-ups, approvals, corrections, final outcome, source links | Pi session JSONL records the per-turn transcript; Slack thread carries the model's streamed response, approval buttons, canvas link (for `spec:`), final summary. | **Match** | Source links: Linear tools return `url` + `identifier` and the model is prompted to quote them (`extensions/linear-tools.ts:328` and registry suffix at `control-plane/registry.yaml:83`). Slack permalinks are not auto-attached on output, but the model can include them. |
| Do not create one global agent brain | Sessions are per-thread. No global "agent" object. | **Match** | The only process-global state is the `pendingApprovals` Map (`index.mjs:483`) and `homeWatchedUsers` Set (`index.mjs:490`). |
| Do not treat an entire Slack channel as one conversation | Channel-allowlist gates the bridge (`index.mjs:647-650`), but each request operates on its own `thread_ts`. | **Match** | DMs and Assistant chat thread use the same thread-scoped session model. |
| Do not let Slack messages become the task database | Linear is the task DB; Slack remains the trigger surface. `BOUNDARY.md:18-25` codifies this. | **Match** | Reinforced by `docs/AGENT_CONTEXT.md:50-58` and `docs/adr/0002-linear-is-execution-truth.md`. |
| Do not let the model directly mutate Linear/GitHub/repos without policy gates | Linear writes go through typed tools with explicit registry approval posture (`registry.yaml:78-84` has `approvals: tool`). The `bash` and `plain` routes guard `rm -rf / sudo / chmod 777 / chown 777` via `extensions/permission-gate.ts`. Edit/write tools have **no** approval prompt — they execute when the model calls them on the `plain` route. GitHub is not wired at all. | **Partial** | Linear mutations are not gated by a dry-run/preview modal — once routed to `linear:`, the model can call `linear_create_issue` directly without an explicit Slack approval click. The prompt suffix tries to keep the model honest (`registry.yaml:83`: "ALWAYS call linear_search_issues first ... Never call linear_create_issue twice for the same thread"), but the policy is in the prompt, not in code. `approvals: tool` is **advisory** today (see `lib/action-resolver.mjs:69-73` and `registry.yaml:56` comment). |

---

## 3. Roles of each system

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Slack thread = unit of work, human control surface, approval surface | `lib/slack-ui-context.mjs:116-242` posts confirm / select / input as in-thread blocks; the App Home (`lib/home-view.mjs`) lists pending approvals. | **Match** | The confirm/select paths use buttons-in-thread, not modals, because the trigger_id required by `views.open` is not available mid-agent-loop (`lib/slack-ui-context.mjs:6-13`). Input is the only modal path (it gets a fresh trigger_id from the "Provide input" button click). |
| Pi session = agent memory, execution trace, reasoning lifecycle | Pi `SessionManager.open(...)` persists JSONL per session (`lib/pi-session.mjs:43-44`). | **Match** | Pi SDK owns the format; the bridge only owns the threadTs → file map. |
| Tool = narrow, typed, specific side effect or read | Linear tools are narrow and typed (`extensions/linear-tools.ts` — `search`, `create`, `add_comment`). Built-in Pi tools (`bash`, `read`, `edit`, `write`, `grep`, `find`) are wide — `bash` especially. | **Partial** | `bash` on the `plain` route violates the "narrow, typed" rule literally; the only narrowing is the danger-pattern gate in `permission-gate.ts:11`. |
| Skill = reusable workflow, not stuffed into the global system prompt | The system prompt in `buildPiPrompt` (`index.mjs:281-309`) injects route-specific suffixes from the registry, not a global skill dump. SKILL.md files exist but are not auto-loaded (`pi-sdk-runner.mjs:179` `noSkills: true`). | **Match** | Trade-off: skills are durable docs but the bridge does not load them. Future Stages could opt-in selected skills per Action. |
| Extension = policy enforcement (approvals, protected paths, audit logging, context injection, safety gates) | `extensions/permission-gate.ts` (bash danger gate), `extensions/env-guard.ts` (secret-bearing path guard), `extensions/git-checkpoint.ts` (turn-start `git stash create`), `extensions/slack-mcp-guard.ts` + `extensions/linear-mcp-guard.ts` (legacy MCP write gates). | **Partial** | `permission-gate` + `linear-tools` are the only extensions actually loaded in the pi-mom inline-factory list (`pi-sdk-runner.mjs:175`). `env-guard`, `git-checkpoint`, `linear-mcp-guard`, `slack-mcp-guard` are listed under `package.json#pi.extensions` for the local Pi package install path but are not wired into pi-mom's resource loader. **There is no tool-audit-log extension.** |
| Linear issue = product/task SOR | Confirmed (`docs/adr/0002-linear-is-execution-truth.md`). | **Match** | — |
| GitHub PR/issue = code SOR | Asserted in docs (`docs/SYSTEM_INDEX.md:14-22`) and `BOUNDARY.md:23`. Not enforced by code; no GitHub tool exists. | **Mismatch** | The boundary is honored by convention only. |

---

## 4. Slack interaction model

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Handle only `@agent` mention, DM, reply in agent thread | Bolt wires `app.event("app_mention", ...)` (`index.mjs:915`), DM via `app.message` filtered to `channel_type === "im"` (`index.mjs:919-923`), and the Assistant container (`index.mjs:928-959`). Replies inside an existing thread are routed by `event.thread_ts` and resolved via `lib/thread-session-map.mjs`. There is also a `/thread-spec` slash command (`index.mjs:783-786`). | **Match** | Slash command is an extra entry point beyond the guide's three, but it is operator-only fallback (`docs/SYSTEM_INDEX.md:100-106`). |
| Ignore random channel messages without `@agent` | The `message` listener returns early on `subtype`, `bot_id`, or `channel_type !== "im"` (`index.mjs:920-922`). The Bot is only subscribed to `app_mention` and `message.im` in `manifest.yaml:82-84`. | **Match** | Slack itself only delivers events listed under `bot_events`; ambient channel messages never reach the bot. |
| Ignore unrelated thread replies | A reply inside a non-allowed channel is rejected at `index.mjs:647-650`. A reply inside an allowed channel hits `handleRequest` and dispatches by `threadTs`. | **Partial** | Strictly speaking, the bot only reaches `handleRequest` when it is mentioned again or when the user is in DM. A reply that does **not** mention the bot in a channel will not deliver an `app_mention` event, so it is implicitly ignored. The guide's intent is satisfied. |
| Ignore bot messages | `index.mjs:920` skips messages with `subtype` or `bot_id`. | **Match** | — |
| Top-level `@agent` mention starts a new job and creates/attaches a Pi session | `handleRequest` derives `threadTs = event.thread_ts || event.ts` (`index.mjs:625`). The first mention's `event.ts` becomes the durable session key. | **Match** | — |
| Reply inside an existing agent thread continues the same job/session | `lib/pi-session.mjs:40-46` calls `map.get(threadTs)` and `SessionManager.open(existing)`. | **Match** | A turn that resumes is traced as `pi_session.session_resolved` with `resumed: true` (`lib/pi-session.mjs:58`). |
| DM to agent is always handled | The DM path bypasses the channel allowlist (`index.mjs:646` comment: "DMs (direct_message) and the Assistant chat tab (assistant) are private to one user and bypass the gate"). | **Match** | — |
| Random channel message: ignore | Not subscribed via manifest events; impossible to reach. | **Match** | — |

---

## 5. Slack UX defaults

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Acknowledge work briefly, inspect context, propose actions, ask for approval before writes, return durable links | The bridge posts an initial `"👀 Covent Pi is thinking… (req: {reqId})"` message (`index.mjs:406`), streams text via `chat.startStream`, surfaces tool execution as `task_update` blocks (`lib/slack-sink.mjs:196-208`), and returns the Linear URL on success. Approval clicks are required for `permission-gate`-flagged bash commands. | **Partial** | For Linear, the **approval is implicit** in the routed mention text ("`@Covent Pi create Linear issue`" is treated as approval — `docs/AGENT_CONTEXT.md:46-47`). There is no explicit "Approve / Revise / Cancel" gate between the model's draft and the `linear_create_issue` call. The guide's "Pattern C: Slack button confirmation" is implemented for **danger-bash** but not for **Linear writes**. |
| Read Slack thread, search Linear, search GitHub, propose actions, ask before writing | Thread fetch via `conversations.replies(limit:12)` at `index.mjs:265-279`. Linear search via `linear_search_issues` (`extensions/linear-tools.ts:171-260`) with a prompt that requires search-before-create. **No GitHub search.** | **Partial** | The Linear flow nudges the model toward "search → comment-or-create" in the prompt (`registry.yaml:83`), but enforcement is prompt-only. GitHub search/get/comment is absent entirely. |
| Status updates, periodic Slack updates, no per-token spam | `lib/slack-sink.mjs:19` `DEFAULT_APPEND_BATCH_MS = 200` batches `text_delta`s into ~200 ms append windows. Heartbeats (`lib/slack-sink.mjs:17-18`) fire zero-width-space appends every ~30 s when the model is quiet. Stream rotation kicks in before Slack's per-message char ceiling (`lib/slack-sink.mjs:29` `DEFAULT_MAX_STREAM_CHARS = 9000`). | **Match** | This is more sophisticated than the guide demands: it solves real Slack quirks (`msg_too_long` poisoning a stream, ~3 min idle stream session timeout). Comment at `lib/slack-sink.mjs:21-29` documents the foot-guns. |
| Final responses include Slack permalink, Linear issue link, GitHub link, concise summary | Linear: yes (the tool returns identifier + URL and the prompt asks the model to quote it). Slack permalink: not auto-attached to the final post. GitHub: N/A. Spec route mirrors the run into a Slack canvas (`lib/canvas-sink.mjs`) and posts the canvas link back into the thread (`index.mjs:410-421`). | **Partial** | Slack permalink injection at the end of the run is not implemented. The thread itself **is** the permalink for the human, so this is partly redundant. |

---

## 6. Slack app configuration

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Minimal scopes: `app_mentions:read`, `chat:write`, `im:history`, optional `channels:history`/`groups:history`/`mpim:history`/`users:read`. Add `files:read/write`, `reactions:write`, `assistant:write` later. | `apps/pi-mom/manifest.yaml:31-79` requests **48** bot scopes including `channels:manage`, `channels:join`, `files:read`, `files:write`, `groups:write`, `im:write`, `mpim:write`, `bookmarks:read/write`, `calls:read/write`, `canvases:read/write`, `pins:read/write`, `reactions:read/write`, `remote_files:read/share/write`, `team:read`, `usergroups:read/write`, `users.profile:read`, `users:read.email`, `users:write`, `workflow.steps:execute`, `incoming-webhook`, `links:read/write`, `emoji:read`, `metadata.message:read`. | **Mismatch** | This is the guide's primary deviation: scopes are POC-broad. `docs/SYSTEM_INDEX.md:165` explicitly flags this — *"Slack manifest scopes are still POC-broad and should be reviewed before hardening."* `canvases:read/write` is actually used by the `spec:` canvas-sink (`lib/canvas-sink.mjs:85-91`); `assistant:write` is used by the Assistant container; the rest are unjustified for the current Action set. |
| Start events with `app_mention` + `message.im`. Add `message.channels` / `message.groups` / `message.mpim` later with strict filtering. | `manifest.yaml:82-84` subscribes to only `app_mention` and `message.im`. | **Match** | Tight match — this is the strongest config alignment. |
| Slack AI App / Assistant surfaces are useful later (phase 2). Build `@mention`, DM, thread continuation first. | All three legacy entry points exist, **and** the Assistant container is wired (`index.mjs:928-959`). | **Partial** | Phase 0/1 (mention + DM + threads + Pi session) is solid. Assistant surfaces were brought forward because Bolt 4.7 makes them cheap; this is not a regression but it is "ahead of the guide's phase plan." |

---

## 7. Slack security

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Verify Slack HTTP requests with signing secret | Not applicable: the bridge runs Socket Mode, not HTTP. `apps/pi-mom/index.mjs:470-475` constructs `new App({ socketMode: true, ... })`. `manifest.yaml:89` sets `socket_mode_enabled: true`. | **N/A (Socket Mode)** | Preflight (`index.mjs:447-458`) verifies the App-Level Token can open Socket Mode before booting. Bot identity is verified against `EXPECTED_SLACK_BOT_USER` (`index.mjs:443-445`). |
| Socket Mode is fine for local dev; prefer HTTP in production | Codebase uses Socket Mode in **production** on Railway. | **Mismatch** | This is intentional (`docs/runbooks/covent-pi-mom-known-good.md` and `README.md:74-82` describe it as a "long-running Socket Mode worker, not a web/serverless function"). The guide's HTTP recommendation is for OAuth/multi-tenant scenarios — pi-mom is single-tenant. |

---

## 8. Pi integration

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Use Pi SDK directly from the TypeScript app | Yes — `lib/pi-sdk-runner.mjs:73-92` imports `AuthStorage, DefaultResourceLoader, ModelRegistry, SessionManager, createAgentSession, getAgentDir` from `@earendil-works/pi-coding-agent`. The previous subprocess-based runner was removed. | **Match** | The "TypeScript app" wording is a slight misnomer because the entrypoint is `.mjs`; the SDK calls themselves are typed by the package's `.d.ts`. |
| Don't control Pi through subprocess RPC unless process isolation / non-TS host / CLI integration is required | The codebase ripped out the subprocess runner. | **Match** | History: commit `a75858f` "feat(pi-mom): Stage 10 — delete legacy paths, enable bash by default on plain route" finalized the SDK-only path. |
| Prefer SDK/AgentSession for main app; RPC as fallback; JSON stream mode for simple UIs | SDK is the only path. | **Match** | — |
| Pi session lifecycle: thread starts → create/load AgentSession; first prompt → `session.prompt(...)`; reply while running → `session.steer(...)` or queue; reply after stop → `session.prompt(...)`/`session.followUp(...)`; cancel → `session.abort()`; inactive → compact/archive. | Codebase implements **create/load** + **prompt** + **abort**. `lib/pi-sdk-runner.mjs:261-265` calls `session.abort()` and `session.dispose()` on settle/timeout/error/abort. There is no `steer` or `followUp` path: if a second mention arrives while the previous turn is still streaming, `runTurn` opens a fresh prompt on the same SessionManager (`lib/pi-session.mjs:73`) — Pi serializes inside the session. Inactive-session compaction/archive is not implemented. | **Partial** | Mid-turn steering is not surfaced. A user who DMs/mentions again mid-stream will create a queued turn against the same session rather than steering the running one. The thread session map LRU-evicts at `maxEntries = 200` (`lib/thread-session-map.mjs:38`); session files themselves are not garbage-collected. |

---

## 9. Thread state

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Store a durable mapping from Slack thread to Pi session | `lib/thread-session-map.mjs:36-107` writes `PI_AGENT_DIR/pi-mom/thread-sessions.json` on every set. | **Match** | The map persists across Railway redeploys when `PI_AGENT_DIR` points at a persistent volume (`lib/thread-session-map.mjs:21-32` documents this and `lib/persistence-check.mjs` runs a cold-boot probe). |
| SQLite initially or Postgres once shared | Codebase uses a **JSON file**, not SQLite. | **Mismatch (intentional simplification)** | Single-process bot, one writer, ~hundreds of entries. JSON is adequate; SQLite would buy concurrent-write safety and indexing for not much else at this scale. |
| Store team ID, channel ID, thread timestamp, started-by user, Pi session ID/path, repo/workspace, related Linear issue, related GitHub PR, active status, timestamps | Stored fields: `sessionFile` (path), `lastTouched` (ts). Nothing else (`thread-session-map.mjs:90`). | **Mismatch** | Team/channel/user/Linear/GitHub linkage is not persisted in the thread-state file. The Pi SessionManager JSONL captures conversational history but not relational metadata. There is no relational store to join Slack ↔ Linear ↔ GitHub. |
| The invariant: Slack thread → durable Pi session mapping must never be lost | The probe at `lib/persistence-check.mjs` exists specifically to enforce this on Railway cold boots. `lib/pi-sdk-runner.mjs:53-71` seeds `auth.json` from `PI_AUTH_JSON_B64` on cold boot so OAuth state survives. | **Match** | This invariant is the most carefully engineered piece of the codebase. |

---

## 10. File-type philosophy

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| TypeScript for executable behavior | Slack routing + Pi integration: **`.mjs`** (Bolt + Pi SDK loader). Tools and extensions: **`.ts`** (loaded by Bun natively). Tests: **`.mjs`** under `apps/pi-mom/test-*.mjs`. | **Partial** | TypeScript is used where the guide expects it for tools and policy; the bridge entrypoint is JS by historical inertia. |
| YAML for declarative config (manifest, channel routing, repo mapping, tool allow/deny, protected paths, env, GH Actions) | `manifest.yaml`, `control-plane/registry.yaml` (route → tools/approvals/system prompt), `agent-kits/profiles/*.yaml` (agent profile policy). `.github/dependabot.yml` and `.github/workflows/` directory exist. | **Match** | Channel routing is **partly** declarative (allowed channel via `SLACK_ALLOWED_CHANNEL_ID` env var, not a YAML map). Repo mapping is not declarative — the bridge has one Pi workdir (`PI_WORKDIR`). |
| Markdown / SKILL.md for procedures | `skills/*/SKILL.md` (57 files) plus `prompts/*.md` and `docs/runbooks/*.md`. | **Match** | — |
| JSONL for durable logs (Pi sessions, Slack event logs, tool audit logs, webhook delivery) | Pi SessionManager writes JSONL (handled inside the SDK). `lib/thread-session-map.mjs` writes JSON (not JSONL). No `slack_event_log.jsonl`, **no `tool_audit.jsonl`**, no `webhook_delivery.jsonl`. | **Partial** | Pi sessions are JSONL by SDK; everything else is in-memory trace lines on stdout. |
| Do not use YAML for business logic / Markdown as DB / system prompt as procedure dump | Confirmed. `registry.yaml` is declarative; route logic is in `action-resolver.mjs`. System prompt suffixes are intentionally short per-route (`registry.yaml:76-104`). | **Match** | The Linear route's system prompt suffix (`registry.yaml:83`) is long and procedural — borderline. It pushes back against the "don't dump procedures into system prompt" guidance. |

---

## 11. Pi skills

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Use skills as lightweight company workflow memory | 57 skill directories under `skills/`. | **Match in spirit, mismatch in scope** | Many skills (`caveman`, `elon-es`, `excalidraw`, `figma-browser`, `gemini-cli`, etc.) are personal/tool-oriented rather than company workflows. |
| Good initial skills: `linear-triage`, `github-pr-review`, `slack-thread-summary`, `bug-report-to-linear`, `incident-update`, `release-notes`, `repo-change-proposal` | The guide's seven recommended skills are **not present by name**. Closest equivalents: `linear-covent`, `linear-auditor`, `linear-subissue-audit`, `pi-slack-contextprime`, `repo-worker`. No `github-pr-review`, no `release-notes`, no `incident-update`, no `bug-report-to-linear`. | **Partial** | The skills inventory predates this guide; it covers Linear and repo workflows but misses the GitHub-and-release-management half. |
| A skill should contain name, description, allowed tools, step-by-step procedure | `skills/repo-worker/SKILL.md` has YAML front-matter `name` + `description`, no `allowed_tools` field. Workflow steps are in the body. | **Partial** | `agent-kits/profiles/*.yaml` carry `tools:` + `skills:` arrays per profile, so allowed-tools live one level up. There is a validation script (`scripts/validate-skills.mjs`) — but it enforces presence of front-matter, not the full guide-recommended shape. |
| Skills should load only when relevant | pi-mom's resource loader sets `noSkills: true` (`pi-sdk-runner.mjs:179`). **Skills are not loaded at all** by the Slack bridge. | **Mismatch** | This is a deliberate trade-off: keep the Slack runtime predictable and avoid prompt-bloat. Skills are still useful for local Pi CLI sessions (developer workbench) but the Slack agent never reads them. |

---

## 12. Tool design

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Keep the tool surface tiny; narrow, typed tools only | Per-route allowlists: `summarize` `[]`, `agenda` `[]`, `spec` `[]`, `help/status` `[]`, `linear` `[search, create, comment]`, `bash` `[bash]`, `plain` `[bash, read, grep, find, edit, write]`. (`registry.yaml:62-104`) | **Partial** | `plain` route is the divergence — it gives the model six built-in tools including `bash`, `edit`, `write`. The `bash` route is at least scoped to a single tool. |
| Slack tools: `slack_get_thread`, `slack_get_permalink`, `slack_search_context` later | **No Slack tools** are registered. Thread context is fetched in `index.mjs:265-279` and embedded into the prompt; permalinks are not fetched at all. | **Mismatch** | The model never makes Slack tool calls; it only sees Slack as static prompt input. |
| Linear tools: `linear_search_issues`, `linear_get_issue`, `linear_create_issue`, `linear_update_issue`, `linear_comment` | Present: `linear_search_issues` (`extensions/linear-tools.ts:171`), `linear_create_issue` (`:263`), `linear_add_comment` (`:342`). Missing: `linear_get_issue`, `linear_update_issue`. | **Partial** | The three present tools cover the guide's "create + dedupe + comment" workflow. Update is the obvious next add for state/priority changes. |
| GitHub tools: `linear_get_pr`/`linear_get_issue`/`linear_search_code`/`linear_comment_on_pr`/`linear_create_pr` (gated) | **None.** | **Mismatch** | — |
| Repo tools: read-only first (`read`, `grep`, `find`, `ls`); mutation later, gated (`edit`, `write`, `bash`) | Pi SDK exposes `read/grep/find` as built-ins. The `plain` route enables all of `bash`, `read`, `grep`, `find`, `edit`, `write` simultaneously. `bash` is danger-pattern-gated; `edit`/`write` are **not gated** by `permission-gate.ts` (the gate only matches `event.toolName === "bash"` at `extensions/permission-gate.ts:14`). `env-guard.ts` would gate writes to secret paths, but it is **not loaded** by pi-mom's resource loader (`pi-sdk-runner.mjs:175` lists only `permissionGate` and `linearTools`). | **Mismatch** | Net effect: a `plain`-route mention in an allowed channel can drive `edit`/`write` to arbitrary repo paths on the production worker with no approval prompt, governed only by Codex sign-in and channel allowlist. |
| Do not expose arbitrary GraphQL / arbitrary GitHub REST / unrestricted bash / vague tools | Linear tools are **explicit GraphQL operations** (`extensions/linear-tools.ts:35-70`) — `IssueCreate`, `CommentCreate`, `IssueSearch`, `IssueLookup`. They do **not** expose an `executeGraphQL` escape hatch. Bash is unrestricted on the `plain` route except for the four danger patterns. | **Partial** | GraphQL surface is locked down. Bash is the open seam. |

---

## 13. Write-action safety

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Pattern A: dry run first (`apply: false` → preview → human approve → `apply: true`) | Not implemented for any tool. | **Mismatch** | — |
| Pattern B: separate plan/apply tools (`linear_plan_issue` / `linear_apply_issue`) | Not implemented. `linear_create_issue` is direct. | **Mismatch** | — |
| Pattern C: Slack button confirmation before write | Implemented **only** for `permission-gate`'s bash danger patterns. `linear_create_issue` runs without a confirm button; the prompt suffix relies on the model to "ALWAYS call linear_search_issues first" (`registry.yaml:83`). The general `ExtensionUIContext` `confirm/select/input` API is in place (`lib/slack-ui-context.mjs:116-242`) — it just is not invoked by `linear-tools.ts`. | **Partial** | The infrastructure for Pattern C exists; only the wiring is missing. A Linear tool that called `ctx.ui.confirm("Create Linear issue?", preview)` before issuing the mutation would close the gap. |
| Model may reason autonomously; side effects require deterministic approval policy | Bash dangerous side effects → approval. Linear, edit, write side effects → no approval. | **Partial** | — |

---

## 14. Approval system

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Approval is visible, boring, auditable, tied to exact tool arguments | `pendingApprovals` Map (`index.mjs:483`) stores per-call `{approvalId, type, channel, threadTs, requestId, title, message, options, ...}` (`lib/slack-ui-context.mjs:120-220`). The approval is bound to the in-flight tool call by being awaited inside the agent loop. | **Partial** | Visible: yes (Slack message + App Home). Auditable: only in stdout traces. **Not** stored on disk. Tied to exact arguments: **partially** — the approval prompt includes a preview of the dangerous command (`extensions/permission-gate.ts:25`) but no argument hash, and the approval value is the `approvalId`, not the argument hash. |
| Store pending approvals with: approval ID, thread key, requesting user, tool name, tool argument hash, preview, status, creation time, expiration time | Stored: `approvalId`, `channel`, `threadTs`, `requestId`, `type`, `title`, `message`, `options`, `messageTs`, `defaultValue`, `signal`, `timeoutTimer`. **Missing:** `requestingUserId` (the body.user.id is read at click time, not at create time), explicit `toolName`, `toolArgumentHash`, `status`, `createdAt`, `expiresAt`. All entries are in-memory; restart drops them. | **Partial** | Timeout is supported via `opts.timeout` (`lib/slack-ui-context.mjs:88-90`), but the guide's full schema is not realized. |
| Approval invariants: binds to exact arguments, expires, authorizes one tool call only, is logged, approving user must be allowed by policy | One-tool-call-only: yes (the awaited promise resolves once). Expiration: yes via `opts.timeout`. Logging: stdout trace only. Approving-user policy: not enforced — any user who clicks the button resolves the approval (`lib/slack-ui-context.mjs:336` records `body.user.id` for display but does not gate). | **Partial** | A non-requesting user can approve another user's bash command if they have access to the thread. |
| Never let a vague earlier "looks good" authorize a different later mutation | The current design *cannot* leak this way for `permission-gate` because the approval is allocated at the moment of the dangerous bash call. For Linear writes, there is no approval at all, so the inverse failure mode applies. | **Partial** | — |

---

## 15. Tool output discipline

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Tool results should be small; return concise result, IDs, URLs, next-action needed | Linear tools return a short text + structured `details` (`extensions/linear-tools.ts:236-258`, `:325-337`). Search results are capped at `limit ≤ 25` (`:194`). | **Match** | — |
| Store raw API summaries / immutable IDs / audit metadata separately from what goes to the model | Linear tool returns `{ content, details }`. `details` is intended for the SDK's structured-result surface; `content` is for the model. There is no separate persistent audit store. | **Partial** | The "separate audit store" piece is missing — see §14. |
| Do not dump full PR diffs, full channels, huge logs, giant API responses into the model | Slack thread fetch is capped at 12 messages (`index.mjs:266`). Linear search is capped. There is no PR-diff tool to dump. Bash output is gated only by Pi's own truncation policy. | **Match** | — |

---

## 16. Pi extensions

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| First extensions: `approval-gate.ts`, `protected-paths.ts`, `dirty-repo-guard.ts`, `git-checkpoint.ts`, `tool-audit-log.ts`, `slack-context-injector.ts` | Codebase has `permission-gate.ts` (≈ approval-gate for bash), `env-guard.ts` (≈ protected-paths for secret files), `git-checkpoint.ts` (matches), `slack-mcp-guard.ts` + `linear-mcp-guard.ts` (legacy global MCP gates). **No** `dirty-repo-guard`, **no** `tool-audit-log`, **no** `slack-context-injector` extension. | **Partial** | Slack context is injected as plain prompt text in `buildPiPrompt` (`index.mjs:281-309`), not via an extension. A future extension-based injector would let the model fetch fresh thread context mid-turn. |
| Wired into pi-mom resource loader | Of the seven `extensions/*.ts` files, only `permission-gate` and `linear-tools` are loaded by pi-mom (`pi-sdk-runner.mjs:175`). `env-guard`, `git-checkpoint`, `linear-mcp-guard`, `slack-mcp-guard`, `browser-use-tools` are listed under `package.json#pi.extensions` for the user-scope Pi install (developer-workbench mode), but not pi-mom. | **Partial / Mismatch** | This is the most surprising single gap: `env-guard.ts` exists, is well-tested in concept, but does not gate the Slack-driven `edit`/`write` flow. |
| Policy lives outside the model; model proposes, extension enforces | True for bash danger patterns. Not true for Linear writes, edits, writes, or secret-path writes from the Slack bridge. | **Partial** | — |

---

## 17. Linear boundary

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Treat Linear as the task SOR | Asserted (`ADR-0002`) and operationally enforced — Linear writes only happen through one tool factory. | **Match** | — |
| Start with: search issues, get issue, list teams/projects/labels, create issue, comment on issue, update status/assignee/priority | Implemented: search, create, comment. Missing: get-by-id (only used internally for identifier resolution in `linear_add_comment` at `:380-394`), list teams/projects/labels, update. | **Partial** | The internal `IssueLookup` query (`:382-384`) exists; it is not exposed as its own tool. |
| Do not start with deletion / bulk mutations / admin / arbitrary GraphQL | None of these exist. `linear-tools.ts` only ships three explicit GraphQL operations. | **Match** | — |
| For a small company, use restricted app/service actor first; per-user OAuth later | Uses a **service actor** with `LINEAR_API_KEY` (`extensions/linear-tools.ts:119-126`). | **Match** | — |
| Use Linear webhooks for synchronization, not autonomous decisions | **No webhooks ingested.** The codebase is purely push (Slack → Pi → Linear writes), with zero Linear → Slack subscription. | **Match (by absence)** | The guide's bad pattern ("every Linear change wakes the agent") is structurally impossible today. |

---

## 18. GitHub boundary

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Treat GitHub as the code SOR | Asserted in docs (`docs/SYSTEM_INDEX.md`, `BOUNDARY.md`). | **Match (by convention)** | — |
| Start with read and comment: get PR, get issue, list changed files, get file contents, search code/issues/PRs, comment on PR, comment on issue | **Nothing implemented.** No Octokit dependency, no GitHub tools, no PR-related code paths. | **Mismatch** | The `.github/dependabot.yml` and `.github/workflows/` exist purely for repo CI, not for runtime GitHub interaction. |
| Add later: create branch, push commit, create PR | Not present. | **N/A** | — |
| Mutation only after sandboxing, approval gates, protected paths, branch discipline, audit logging | Not relevant yet (no mutation surface). | **N/A** | — |
| Prefer a GitHub App for long-lived integration; PATs only for local/short-lived | Not present. | **N/A** | — |
| Use webhooks for awareness, not autonomous mutation | No webhook receiver exists. | **N/A** | — |

This is the largest single absence vs. the guide. The codebase explicitly stops at "Linear is the durable target" today.

---

## 19. Slack context, Real-Time Search, MCP

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Default Slack context tool: fetch current thread via Slack Web API | `index.mjs:265-279` calls `client.conversations.replies({ channel, ts: rootTs, limit: 12 })`. | **Match** | — |
| Use broader Slack search only when current thread is insufficient | The bridge never broadens beyond the current thread automatically. The Pi prompt explicitly instructs against using Slack MCP to post and to treat Slack as data, not commands (`slack-mcp-guard.ts:17`). | **Match** | — |
| Use Slack Real-Time Search across Slack when needed | Not implemented. | **Partial** | — |
| Use Slack MCP only if external clients or external agent hosts need Slack access | Slack MCP is **not loaded** by pi-mom. `manifest.yaml:87` sets `is_mcp_enabled: false`. `slack-mcp-guard.ts` exists for the developer-workbench Pi install and would gate writes if MCP were ever attached. | **Match** | — |
| For a Slack-native Bolt + Pi app, direct Slack Web API is simpler; MCP should not be the first abstraction | Direct Slack Web API is the only Slack path the bridge uses. | **Match** | — |

---

## 20. Repo execution and sandboxing

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Use a workspace per repo or per thread | `lib/pi-sdk-runner.mjs:97` sets a single `PI_WORKDIR` (or `$HOME` / `process.cwd()`). The same workdir is used for all Slack threads. | **Mismatch** | No per-thread worktree. A single shared cwd means `plain`-route `edit`/`write` calls from two different threads land in the same files. |
| Preferred flow: create worktree → run agent there → read-only first → propose edits → wait for approval → apply → tests → PR → post link to Slack | The codebase does **not** implement worktree-per-thread. There is no automatic PR creation. `permission-gate` does not require approval for `edit`/`write`. There is no automatic test-run after edits. | **Mismatch** | — |
| Bash allowlist: tests, lint, typecheck, rg, git diff, git status; block: `rm -rf`, `curl \| sh`, deploy commands, prod credentials, terraform apply, destructive K8s | `extensions/permission-gate.ts:11` only checks four patterns: `rm -rf`, `sudo`, `chmod 777`, `chown 777`. There is no allowlist; everything not on the deny list runs without prompt. | **Mismatch** | `curl | sh`, `terraform apply`, `kubectl delete`, `npm publish`, `railway up`, `git push --force`, `git checkout -- .` are all currently runnable from a `plain` mention without an approval prompt. The `bash` route is similarly minimal. |
| Use Docker / another sandbox before enabling real bash/write | No Docker sandbox. The Railway worker runs in a normal container; bash runs in that container's filesystem. | **Mismatch** | The current mitigation is channel allowlist + Codex sign-in + the four-pattern danger gate. |

---

## 21. Memory and compaction

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Three layers: thread session memory (Pi JSONL), project memory (repo docs / `.pi/skills`), company memory (docs of principles, conventions, policies) | Thread session: Pi SessionManager JSONL (per-thread, persisted under `PI_AGENT_DIR`). Project memory: `docs/`, `.pi/agents/`, `skills/`. Company memory: `BOUNDARY.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/adr/**`. | **Match** | All three layers exist as files. |
| Don't rely on one giant forever context | Pi handles its own per-turn context; the bridge does not inject the whole skills tree (`noSkills: true`). | **Match** | — |
| Never hide critical business rules only in model memory | Codified in repo docs. | **Match** | — |
| Compaction | No compaction logic in pi-mom; Pi SDK may compact internally per-session. | **Partial** | — |

---

## 22. Operating modes (Ask / Draft / Apply)

| Guide point | Codebase reality | Verdict | Nuance |
|---|---|---|---|
| Mode 1 Ask/summarize — no write tools | `summarize:`, `agenda:`, `spec:`, `help`, `status` routes all set `tools: []` (`registry.yaml:67-92`). | **Match** | — |
| Mode 2 Draft/propose — dry run only | Not modeled explicitly. The closest analogue is the `spec:` route which produces a canvas + Slack draft without any external write (no Linear, no GitHub). | **Partial** | The `spec:` flow happens to be "draft mode" because it has no write tools. There is no formal dry-run flag on Linear, edit, write, or bash. |
| Mode 3 Apply — requires explicit approval | The `linear:` route writes without an explicit Slack button approval; the explicit-mention is treated as approval (`docs/ADR-0002`, `docs/AGENT_CONTEXT.md:46`). The `bash` route writes (executes side effects) with permission-gate only for the four danger patterns. | **Partial** | The three-mode separation is not explicit in code; it is achieved implicitly by per-route tool gating. The same Slack input could be either Draft or Apply depending on which route the parser picks. |

---

## 23. Implementation phases

| Guide phase | Codebase reality | Verdict |
|---|---|---|
| **Phase 0** — Slack skeleton: Slack app, Bolt router, app_mention, DM, thread continuation, thread state store, echo response | Implemented (`index.mjs` echo path at `:674-682`, dispatcher, thread session map). `PI_MOM_MODE=echo` is still supported. | **Match** |
| **Phase 1** — Pi session per thread, prompt → Pi → Slack response, basic streaming, cancel/abort, audit logs, read-only tools | Implemented except for the **audit-log** piece. `lib/pi-session.mjs`, `lib/slack-sink.mjs`, `lib/pi-sdk-runner.mjs:253-265` for abort/timeout. Audit logs are stdout traces only. | **Partial** |
| **Phase 2** — Linear: search, get, create-dry-run, Slack approval, create-apply | Implemented as: search, create, comment. **No dry-run**, **no Slack-button approval before create**. | **Partial** |
| **Phase 3** — GitHub read + comments, propose comments, approve comments, post comments | **Not started.** | **N/A** |
| **Phase 4** — Repo mutation: worktree, protected paths, git-checkpoint, edit/write, tests, PR creation | Partial: the `plain` route exposes `edit`/`write` without worktree or protected-paths enforcement; `git-checkpoint.ts` exists as a file but is **not loaded** by pi-mom's resource loader. No automatic test-run, no PR creation. | **Mismatch** |

In short: Phase 0 and Phase 1 (minus audit logs) are done. Phase 2 is half done (writes work but without the explicit approval gate). Phase 3 is missing. Phase 4 is enabled (edit/write) but skipped its prerequisites.

---

## 24. What not to do

| Guide anti-pattern | Codebase reality | Verdict |
|---|---|---|
| Listen to every Slack message | Subscribes only to `app_mention` and `message.im`; DM filter rejects non-IM messages. | **Match** |
| Create one global forever agent session | Per-thread sessions only. | **Match** |
| Give the model arbitrary GraphQL | Linear tools expose three explicit operations; no `execute_graphql` escape hatch. | **Match** |
| Give the model arbitrary GitHub REST | No GitHub surface at all. | **Match** |
| Run bash on the host without sandboxing | `plain` and `bash` routes run bash on the Railway host, gated only by `rm -rf / sudo / chmod 777 / chown 777` patterns. | **Mismatch** |
| Use YAML for executable logic | YAML is declarative only; route logic is in JS. | **Match** |
| Put every workflow in the system prompt | Per-route suffixes are short; SKILL.md files are not auto-loaded into the prompt. | **Match (with Linear-route caveat)** |
| Post a Slack update for every token | 200 ms batching + heartbeats (`lib/slack-sink.mjs:19,17`). | **Match** |
| Let Linear/GitHub webhooks trigger autonomous writes | No webhook receivers exist. | **Match (by absence)** |
| Multi-agent routing before one agent is reliable | Single `AgentSession` per thread; no multi-agent dispatch. | **Match** |

---

## 25. Final recommended foundation — feature-by-feature

| Final recommendation | Codebase reality | Verdict |
|---|---|---|
| **Runtime: TypeScript Node service** | Bun runtime, `.mjs` bridge + `.ts` extensions. `package.json` requires Bun ≥ 1.3.0 and Node ≥ 22. Production on Railway runs Bun (`apps/pi-mom/nixpacks.toml`). | **Partial** (Bun, not Node; JS, not TS at the entry) |
| **Slack: Bolt JS, app_mention, message.im, gated thread replies, Assistant surfaces later** | Bolt 4.6; app_mention + message.im subscribed; thread replies are gated; Assistant container is wired today (not "later"). | **Match (Assistant brought forward)** |
| **Pi: SDK, one AgentSession per Slack thread, read-only built-ins first, custom Slack/Linear/GitHub tools, SKILL.md workflows, extensions for approval/security/audit** | SDK ✓, one session/thread ✓, mixed-mode built-ins (read+write+bash on `plain`) ✗, custom Linear tools ✓, no Slack/GitHub tools ✗, SKILL.md exists but not loaded ✗, approval extension ✓, security/env-guard extension exists-but-unloaded ✗, audit extension missing ✗. | **Partial** |
| **Data: SQLite first or Postgres later; thread_state, pending_approval, tool_audit_log, webhood_delivery, Pi session JSONL** | JSON file (not SQLite) for thread→session map; in-memory pending_approval; no tool_audit_log; no webhook_delivery; Pi session JSONL ✓. | **Partial / Mismatch** |
| **Linear: @linear/sdk, restricted app/service actor first, OAuth later, no arbitrary GraphQL tool** | Custom GraphQL client via `fetch` (not `@linear/sdk`); service actor via `LINEAR_API_KEY`; three explicit operations only. | **Partial** (no `@linear/sdk` dep) |
| **GitHub: App, Octokit REST + GraphQL, webhook ingestion, no mutation until approval and sandboxing exist** | Nothing implemented. | **Mismatch** |
| **Config: YAML for manifest/policy/channel routing/repo mapping; Markdown SKILL.md; TypeScript for behavior** | Manifest YAML ✓; policy YAML (registry, profiles) ✓; channel routing is env-var, not YAML ✗; repo mapping not declarative ✗; SKILL.md ✓; behavior is `.mjs` + `.ts`. | **Partial** |
| **Deepest principle: every tool narrow, typed, auditable, permissioned, attached to the right Slack thread** | Linear tools satisfy this. `plain`-route built-ins do not. Audit (in a strict sense) is missing. | **Partial** |

---

## Top-level summary

What the codebase already does well — and matches the guide:

- **Slack interaction model**: `app_mention` + `message.im` only, thread-scoped session, allowlist-gated channels. (`index.mjs:915-923`, `manifest.yaml:82-84`)
- **Per-thread Pi session continuity**: a durable JSON map between `threadTs` and the `SessionManager` JSONL file, with a cold-boot persistence probe and OAuth auth.json seeding. (`lib/thread-session-map.mjs`, `lib/persistence-check.mjs`, `lib/pi-sdk-runner.mjs:53-71`)
- **Slack streaming hygiene**: 200 ms batching, heartbeats, stream rotation under cumulative char ceilings — solves the foot-guns the guide hand-waves. (`lib/slack-sink.mjs`)
- **Narrow, typed Linear tools**: three explicit GraphQL operations, search-then-create dedupe pressure baked into the prompt. (`extensions/linear-tools.ts`)
- **Per-route tool gating**: declarative YAML registry → action-resolver → `setActiveToolsByName` at session creation. (`apps/pi-mom/control-plane/registry.yaml`, `lib/action-resolver.mjs`, `lib/pi-sdk-runner.mjs:230-232`)
- **Per-user OAuth gate** before any Pi model call (`apps/pi-mom/index.mjs:690-694`, `lib/codex-signin.mjs`, `lib/user-auth-store.mjs`). The guide does not require this; it goes further than the guide on identity.
- **Spec-route canvas mirror**: a long-form artifact lives in a canvas, with the link posted back into the thread. (`lib/canvas-sink.mjs`, `index.mjs:374-421`)
- **App Home cockpit** showing pending approvals in a read-only view, pushed on add/remove. (`lib/home-view.mjs`, `index.mjs:483-534`)

Where the codebase clearly diverges from the guide — ordered by severity:

1. **`plain` route enables `bash`, `edit`, `write` without per-call approval, without worktree isolation, without sandbox, without `env-guard` loaded, without protected-paths enforcement, without dry-run, and without a tool-audit log.** This is the single biggest delta from the guide. (`registry.yaml:62-65`, `pi-sdk-runner.mjs:175` for the loaded extensions list)
2. **No GitHub integration.** Octokit, GitHub App, PR/issue tools, webhook ingestion — all absent. (`README.md`, `extensions/`, `package.json` confirm)
3. **No Slack-button approval before Linear writes.** The mention-text "create Linear issue" is treated as approval; the model can call `linear_create_issue` directly. (`docs/AGENT_CONTEXT.md:46-47`, `registry.yaml:78-84`)
4. **Slack manifest scopes are POC-broad** — 48 bot scopes vs. the guide's ~7 starter scopes. (`manifest.yaml:31-79`) Documented as a known issue (`docs/SYSTEM_INDEX.md:165`).
5. **Thread state schema is minimal**: stored fields are `sessionFile` + `lastTouched`. Team/channel/user/Linear/GitHub linkage is not persisted relationally. (`lib/thread-session-map.mjs:90`)
6. **Approvals are in-memory only.** A bridge restart drops every pending approval. There is no durable `pending_approval` row, no argument hash, no per-user policy check. (`index.mjs:483`, `lib/slack-ui-context.mjs:74-114`)
7. **No tool-audit log.** Trace events go to stdout; there is no `tool_audit.jsonl` or DB table. (`grep -r tool_audit` finds nothing in code)
8. **Multiple useful extensions exist as files but are not loaded by pi-mom**: `env-guard.ts`, `git-checkpoint.ts`, `slack-mcp-guard.ts`, `linear-mcp-guard.ts`. They protect the developer-workbench Pi install but not the Slack runtime. (`pi-sdk-runner.mjs:175` vs. `package.json#pi.extensions`)
9. **Session key is `threadTs` alone**, not `team_id + channel_id + thread_ts`. Single-workspace deploys are safe; multi-workspace would collide. (`lib/thread-session-map.mjs:82-93`)
10. **Skills exist (57 of them) but pi-mom does not load any** (`pi-sdk-runner.mjs:179` `noSkills: true`). The "company workflow memory" layer is real for developers, invisible to the Slack agent.

Where the codebase is **ahead** of the guide:

- **Per-user Codex OAuth gate** with manual-paste fallback for Railway, including a Slack modal for code submission. The guide does not contemplate per-user model attribution; the codebase makes it a hard prerequisite. (`apps/pi-mom/index.mjs:684-694`, `lib/codex-signin.mjs`)
- **Slack stream rotation** before Slack's hidden cumulative-char ceiling poisons a stream. The guide does not mention this; the codebase had to discover and document it. (`lib/slack-sink.mjs:21-29`)
- **Spec canvas mirror** with rate-limited debounced edits and final replace-pass. (`lib/canvas-sink.mjs`)
- **Assistant container** in the same bridge as the legacy `app_mention` path, sharing the dispatcher. (`index.mjs:928-959`, `lib/dispatch.mjs`)
- **Cold-boot persistence probe** to give Railway a "persistent volume yes/no" verdict in deploy logs. (`lib/persistence-check.mjs`, called from `preflight` at `index.mjs:463-468`)

---

## Recommended next steps to close the largest gaps

These are listed in dependency order; each one is small enough to do as one stage.

1. **Wire `env-guard.ts` into pi-mom's `extensionFactories`** (`pi-sdk-runner.mjs:175`). One line of code; closes the secret-file write hole on the `plain` route.
2. **Wire `git-checkpoint.ts` into pi-mom's `extensionFactories`**. Same change as #1; gives a per-turn stash so risky edits can be rolled back from within Pi.
3. **Add a `pi_uictx_confirm` call inside `linear_create_issue.execute()`** before issuing the GraphQL mutation. The infrastructure exists (`lib/slack-ui-context.mjs:116-156`). Closes the largest Linear-write gap.
4. **Add a `tool-audit-log.ts` extension** that subscribes to `tool_call` / `tool_result` and appends one JSONL line per call to `PI_AGENT_DIR/pi-mom/tool-audit.jsonl`. Closes the audit gap and gives the App Home a real backing store.
5. **Persist `pendingApprovals` to disk** (single JSONL or SQLite). Combine with #4. This is a precondition for surviving Railway redeploys mid-approval.
6. **Tighten `permission-gate.ts` from a deny list to an allow list** for bash on the `plain`/`bash` routes. Move tests/lint/typecheck/rg/git diff/git status into the allow list and prompt on everything else.
7. **Trim the Slack manifest scopes** to the actually-used set: `app_mentions:read`, `chat:write`, `chat:write.customize`, `assistant:write`, `commands`, `im:history`, `im:write`, `channels:history`, `groups:history`, `canvases:read`, `canvases:write`, `users:read`. Drop the remaining ~36.
8. **Add `team_id` + `channel_id` to the thread session key** (or to the stored value at minimum). Cheap migration: include them in `set()` and use them when calling `chat.postMessage` to disambiguate.
9. **Start a `github-app` package** with read-only `gh_get_pr`, `gh_get_issue`, `gh_search_code`, gated by the same TypeBox + registry pattern as `linear-tools.ts`. This unlocks Phase 3 of the guide.
10. **Add `dry_run: boolean` to `linear_create_issue`** and split `linear_create_issue_plan` + `linear_create_issue_apply` if the team prefers Pattern B. The simpler Pattern A change is one branch inside the existing tool.

Once #1 through #5 land, the codebase will sit cleanly inside the guide's Phase 2 with all the safety primitives the guide names.
