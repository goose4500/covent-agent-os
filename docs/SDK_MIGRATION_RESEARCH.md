# SDK Migration Research & Architecture Decision Record

> Research synthesis for migrating `apps/pi-mom` from CLI-subprocess Pi invocation to in-process Pi SDK embedding, and aligning the broader `covent-agent-os` codebase to a simple Slack ↔ PI architecture branded **"Actions."**
>
> **Audience:** human reviewer + future agents picking up the work.
> **Status:** research complete, decisions verified, implementation pending.
> **Created:** 2026-05-11

---

## 0. Origin

This document originated from handwritten notes about Slack ↔ PI architecture, transcribed during a research session. The notes asked:

- How does Slack connect to PI (the AI agent layer)?
- What's the invocation grammar? (User's answer: `agent → skill (optional) → prompt`)
- Should Canvas be the artifact/output node?
- How do Block Kit, modals, buttons fit?
- How do feature flags and observability work?

The discussion identified that **"Actions"** is the team-facing brand and **`(agent, skill, prompt)`** is the underlying mechanics — different surfaces of the same primitive.

**User goals stated during the session:**
- Simple architecture, fundamental alignment
- Simplification and deletion (Elon-style cut)
- Leverage and velocity over security
- First-principles reasoning grounded in current (May 2026) docs and code

---

## 1. Workflow that produced this document

1. **Transcription** of handwritten notes → identified six architecture axes (inbound surfaces, invocation grammar, agent layer, outbound surfaces, observability, approval).
2. **Current-state map** of `covent-agent-os` against the ideal "Actions" architecture (Explore agent).
3. **Parallel research:** May 2026 Slack platform UX + Pi runtime identification (2 background agents).
4. **Six parallel verification agents** dug into pi-mono source code, OpenClaw docs, and Slack API docs to resolve open questions.
5. **Synthesis** into this document.

All findings are cited to primary sources (pi-mono on GitHub, OpenClaw docs, Slack API docs, file:line references in the local repo).

---

## 2. Original handwritten notes (transcribed)

> Create clear universal diagrams for architecture — high-level alignment first
>
> - Slack → PI
> - Modal-input-mode
> - App Mgr — UX / observability?
> - Buttons — diagnostic parsing / unknown is the top of UX
> - Slack Block Kit — how it all deals / fits / is fit?
> - Canvas or no? — artifact / output node?
> - Slack UI/UX mention → PI agent layer → output
> - 2nd used to feature flags. Covent-agent & Slack & prompt3
> - First arg is what specialized agent is being called
> - Next optional arg is what skill they want to use
> - Final is the prompt
> - Direct @ in channels, threads, private messages, /commands

---

## 3. Knowledge gained

### 3.1 Pi runtime identity

- **Project:** Pi (`@earendil-works/pi-coding-agent`), formerly `@mariozechner/pi-coding-agent`
- **Author:** Mario Zechner (`badlogic` on GitHub)
- **Latest version:** v0.74.0 (May 7, 2026)
- **Repo's pinned version:** `^0.73.1` of the **deprecated** namespace
- **Description:** Minimal coding-agent harness. ~200-token system prompt. Four built-in tools (`read`, `write`, `edit`, `bash`). Agent-loop + tool-call event stream. Aggressive extension points instead of features.
- **OpenClaw** is the public AI-assistant product built on top of Pi via the SDK. It's the canonical "Pi-embedded-in-a-non-TUI host" reference. Per Armin Ronacher: *"Pi is the minimal agent within OpenClaw."*

### 3.2 Slack platform state (May 2026)

Major shifts since `apps/pi-mom` was written:

- **Streaming API GA (Oct 2025):** `chat.startStream` / `chat.appendStream` / `chat.stopStream`. Supports streaming Block Kit blocks, not just text. Tier 4 (100+/min).
- **Native agent blocks:**
  - `task_card` + `plan` (Feb 2026): canonical "agent thinking out loud" surface
  - `card` + `alert` + `carousel` (April 2026): run cards, approvals, multi-artifact results
  - `table` (Aug 2025): structured tabular output
  - `markdown` (Feb 2025): explicit AI-app intent
- **Canvas API GA:** `canvases.create` / `canvases.edit`. **Markdown only, Block Kit NOT supported inside Canvas.** Programmatic, addressable per-thread, append-only audit surface.
- **`assistant.threads.setStatus`** now accepts `chat:write` scope (March 2026) — "Thinking…" loaders without partner gating.
- **Slack MCP Server + Real-Time Search API** (Feb 2026): orthogonal — makes Slack a tool for external agents.
- **Dialogs deprecated.** Modals are the only modal-pattern surface.

### 3.3 Pi embedding contract

- **`createAgentSession(options)`** returns `{ session }`. Accepts shared singletons: `sessionManager`, `authStorage`, `modelRegistry`, `resourceLoader`. Build once at boot, reuse per request.
- **Session methods:** `prompt(text)`, `steer(text)`, `followUp(text)`, `subscribe(listener)` (returns unsubscribe fn), `abort()`, `dispose()`, `compact()`, `setModel()`, `navigateTree()`.
- **Event taxonomy from `subscribe()`:** `message_update`, `tool_execution_start/update/end`, `message_start/end`, `agent_start/end`, `turn_start/end`, `queue_update`, `compaction_*`, `auto_retry_*`.
- **`bindExtensions({ uiContext, ... })`** — host injection point for `ctx.ui`. RPC mode is the reference non-TUI implementation; embedded hosts implement the `ExtensionUIContext` interface directly.
- **`SessionManager` modes:**
  - `inMemory()` — no persistence
  - `create(cwd, sessionDir?)` — file-backed JSONL, lazy file creation on first assistant response
  - `open(filePath)` — open existing
  - `continueRecent(cwd)` — resume most recent
- **Persistence:** synchronous `appendFileSync` per entry, no batching.
- **Extensions in SDK mode:** explicit array via `DefaultResourceLoader({ extensionFactories, additionalExtensionPaths })`. The repo's root `package.json#pi.*` block is **CLI-only and dead under SDK**.

### 3.4 Extension contract (verified from pi-mono source)

- **Factory signature:** `(pi: ExtensionAPI) => void | Promise<void>`. No second argument, no DI. **Closure is the only way to pass host context.**
- **Higher-order pattern (canonical):** `slackApprovalGate(deps) → (pi) => { ... }`. Host calls outer fn at module scope with Slack client + shared promise registry; inner fn registers handlers that close over `deps`.
- **`pi.events`** is untyped and silently swallows errors. Advisory signals only, not correctness-critical.
- **Async factories awaited before `session_start`** — safe to fetch config remotely.
- **Session replacement drops extensions.** Host must re-pass on `newSession`/`switchSession`/`fork`. Keep deps refs at module scope so closures survive replacement.
- **Don't `await` Bolt inside factory body.** Blocks `createAgentSession` forever. Wire Bolt at host scope; factory references a shared `Map<id, resolveFn>`.

### 3.5 Tool contract

- **`ToolDefinition`:** `name`, `label`, `description`, `parameters` (TypeBox `TSchema`, **NOT** Zod/raw JSON Schema). Optional: `promptSnippet`, `promptGuidelines`, `renderShell/renderCall/renderResult`, `prepareArguments`, `executionMode`.
- **`execute(toolCallId, params, signal, onUpdate, ctx)`** — full signature. `signal` is `AbortSignal` for cancellation. `onUpdate(partial)` streams `tool_execution_update` events. `ctx` is `ExtensionContext`.
- **Result format:** `AgentToolResult<T> = { content: (TextContent | ImageContent)[], details: T, terminate?: boolean }`. Content goes to LLM; `details` is opaque structured data. No file content type — return paths as text.
- **Error handling:** `throw new Error("...")`. Returning `{ isError: true }` is **ignored** (field doesn't exist on `AgentToolResult`). Runtime catches throw, sets `isError` on tool-result message, surfaces `error.message` to LLM.
- **Enums:** use `StringEnum` from `@earendil-works/pi-ai`, **NOT** `Type.Union(Type.Literal(...))` (incompatible with Google API).

### 3.6 System prompt injection (`before_agent_start`)

- **Fires once per `session.prompt()` call**, not per turn within the run.
- **Payload:** `{ prompt, images?, systemPrompt, systemPromptOptions }`.
- **Return:** `{ message?, systemPrompt? } | void`. Returning `systemPrompt` **replaces** the prompt for the next handler.
- **To augment:** `return { systemPrompt: event.systemPrompt + "\n\n..." }`. **Always base on the chained `event.systemPrompt`**, never the original. Multiple handlers chain in load order.
- **Async + blocking:** handler can be async; agent loop waits.
- **Errors are silently caught** into `ExtensionError` events. Failed template loads will leave the prompt unaugmented — log loudly.
- **Per-Action tool gating** lives here too: `pi.setActiveTools([...])` in `before_agent_start`. PRD Action exposes `[read, write, slack_*]`; Image Action exposes `[gpt_image_*]`. Moves tool-selection out of pi-mom Node code.

### 3.7 OpenClaw embedding pattern (reference)

OpenClaw is the canonical embedded host. Its choices:

- **In-process `createAgentSession()`**, not `--mode rpc` or CLI subprocess.
- **File-backed per-channel-thread sessions** under `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`. JSONL tree with id/parentId branching.
- **Bypasses `ctx.ui.*`** entirely — replaces TUI with `subscribeEmbeddedPiSession()` event subscription. Channel adapters translate events to Slack/Discord/Telegram primitives.
- **`EmbeddedBlockChunker`** for streaming: chunks on paragraph/newline/sentence boundaries, never splits inside code fences. Two strategies (`text_end` live, `message_end` buffered).
- **Tool pipeline:** built-in Pi tools (read/edit/write) + OpenClaw-specific tools (messaging, browser, canvas, sessions, cron, gateway). `bash` replaced with sandboxed `exec`/`process`.
- **AbortSignal threaded everywhere** for cancellation. `runs.ts` active-run table. `steer()` to interrupt, `followUp()` to queue.

**Note on `ctx.ui` bypass:** This is a *style* choice driven by OpenClaw's multi-channel UX needs (Slack, Discord, Telegram, WhatsApp each have different UI primitives). The SDK supports both patterns: bypass via events, OR implement `ExtensionUIContext` for in-host UI override. For Slack-only pi-mom, **the UI override pattern is cleaner** (zero changes to existing `permission-gate.ts`).

### 3.8 Subagents and skills in SDK mode

- **`pi-subagents` extension** must be imported and passed explicitly: `extensionFactories: [subagents]`. No auto-discovery from `~/.pi/agent/extensions/`.
- **Subagent invocation** via the registered `subagent` tool: model calls it, or host pre-injects `/run <agent> "..."` into the prompt.
- **Foreground events** surface to parent's `subscribe()` listener as wrapped `tool_execution_*`. **Background** (`--bg`) returns immediately; completion arrives as `subagent-notify` events.
- **Skills auto-selected by description** when loaded. `resources_discover` event is the clean injection point:
  ```ts
  pi.on("resources_discover", () => ({ skillPaths: [...], promptPaths: [...] }))
  ```
- **Gap:** the repo's 12 `agents/*.md` files (outside `.pi/agents/`) are invisible to pi-subagents. Must move/symlink to `.pi/agents/`.

### 3.9 Session lifecycle for long-running Node

- **Construction is expensive** if `resourceLoader` is rebuilt per request. Pass shared singletons (`authStorage`, `modelRegistry`, `settingsManager`, `resourceLoader`) built at boot.
- **`session.subscribe()` listeners are fire-and-forget.** Pi does **NOT** await them. The agent loop blasts events as fast as it produces them. **Host owns backpressure** — Slack rate limits (~1/sec per channel) require a queue/throttle in the listener.
- **`dispose()` is mandatory** — frees listener closures (often Slack client refs), agent subscription, extension registrations. Forgetting leaks.
- **`abort()` then `dispose()`** is the safe order mid-stream. `abort()` emits `agent_end` and is **NOT terminal** — `prompt()` can be called again.
- **Concurrency cap:** no hard limit from source. Recommended: start at **5 concurrent streaming sessions** per process on Railway 1vCPU/512MB, monitor, raise.
- **Persistence pattern:** `Map<thread_ts, sessionFile>` on disk. Hit → `SessionManager.open(savedPath)`. Miss → `SessionManager.create(cwd)`. Always `dispose()` at end of request handler. Never keep `AgentSession` instances alive between Slack events.

### 3.10 UI adapter bridge (verified GREEN)

- **`AgentSession.bindExtensions({ uiContext })`** is a public, documented SDK injection point.
- Host implements `ExtensionUIContext` (interface at `pi-mono/packages/coding-agent/src/core/extensions/types.ts:124-216`).
- Every `ctx.ui.select/confirm/input/notify` call inside any extension routes to host code.
- RPC mode's `rpc-mode.ts:129-304` is the canonical non-TUI implementation; embedded hosts skip the JSON wire layer.
- **TUI-only methods** (`setWidget`, `setEditorComponent`, etc.) are designed to be no-op'd — RPC mode no-ops them, the SDK does not throw.
- **`ctx.hasUI`** auto-returns `true` once `bindExtensions({ uiContext })` is called with a non-undefined context — so `permission-gate.ts:20-23`'s "block by default when no UI" branch fires correctly only when Slack is unavailable.

---

## 4. Verified decisions

| # | Decision | Verification source |
|---|---|---|
| 1 | SDK embedding (not `--mode rpc`, not subprocess) | OpenClaw reference + 6 verification agents |
| 2 | Shared singletons at process boot | `session-manager.js` construction cost analysis |
| 3 | Per-`thread_ts` persistent sessions | Sessions are file-backed; `open()` is cheap (one `readFileSync`) |
| 4 | `bindExtensions({ uiContext })` for existing `ctx.ui.*` calls | Agent 1 GREEN; `permission-gate.ts` unchanged |
| 5 | Higher-order extension factories for Slack-aware extensions | Factory signature has no DI; closure is the only way |
| 6 | `before_agent_start` augments (`event.systemPrompt + "..."`) | `runner.js:700-752` chain semantics |
| 7 | `pi.setActiveTools([...])` for per-Action tool gating | `extensions.md:1217` |
| 8 | Tools throw on error (no `isError` field) | `types.d.ts:281-291` |
| 9 | Listeners are fire-and-forget; host owns backpressure | `agent-session.js:219-223` |
| 10 | `abort()` then `dispose()` pairing | `agent-session.js:508-513`, `:1057-1061` |
| 11 | "Actions" is brand, `(agent, skill, prompt)` is mechanics | User decision, locked in |
| 12 | Canvas = durable markdown artifact; thread = ephemeral run log | Slack Canvas is markdown-only by design |
| 13 | Adopt 4 Slack native blocks: `task_card`/`plan` (progress), `card` (run/result), `alert` (approval), `carousel` (multi-artifact) | Slack May 2026 changelog |
| 14 | Streaming via `chat.startStream`/`appendStream`/`stopStream`, not `chat.update` loop | Slack Oct 2025 GA |

---

## 5. Current state of `apps/pi-mom`

- **Pi invocation:** subprocess via `spawn(PI_COMMAND, args)` at `index.mjs:778` with `--no-tools --no-extensions --no-session -p @<tempfile>`.
- **Stream parsing:** ANSI strip + idle-timer "done" heuristic (`cleanPiOutput`, `PI_OUTPUT_IDLE_MS`).
- **Approval state machine:** parallel Slack-side button handlers at `index.mjs:1238` (`agent_run_start`) / `:1312` (`agent_run_cancel`).
- **Block Kit:** custom `lib/agent-run-card.mjs` (137 lines).
- **Canvas:** `lib/slack-canvas.mjs` exists but `PI_MOM_AGENT_CANVAS_ENABLED=false` by default.
- **Streaming:** `runPiWithSlackStream()` `chat.update` loop at `index.mjs:856`.
- **Image route:** `lib/openai-image-client.mjs` (313 lines) — completely parallel to the unused `extensions/openai-image-tools.ts`.
- **Routes:** 13 hardcoded `legacyRoutes` in `index.mjs`. One `run-action` Action in `registry.yaml`. Migration ~10% done.
- **Vocabulary drift:** "agent" everywhere in code (`agent_run_start`, `PI_MOM_AGENT_*`, `lib/agent-run-card.mjs`) vs "Action" in docs.
- **Extensions:** 7 in `extensions/`. All currently dead because `--no-extensions`.
- **Subagents:** 26 across `agents/` + `.pi/agents/`. All currently dead because `--no-extensions`.
- **Skills:** 30+ in `skills/`. All currently dead because `--no-extensions`.

---

## 6. The verified simple architecture

```
Slack (native APIs)
  ├─ inbound: @mention | message shortcut | slash → modal
  ├─ envelope: { action, agent?, skill?, prompt, source:{channel, thread_ts, user} }
  ↓
pi-mom worker (Node, single service)
  ├─ singletons at boot: authStorage, modelRegistry, settingsManager, resourceLoader
  ├─ thread_ts → sessionFile map (extends agent-run-store.mjs)
  ├─ Bolt action handlers feed a shared pendingApprovals Map
  ↓
createAgentSession({ resourceLoader, sessionManager })
session.bindExtensions({ uiContext: slackUI })
  extensions: [
    pi-subagents,
    resources_discover(skills, prompts),
    env-guard, permission-gate, *-mcp-guard, git-checkpoint,   ← existing, unchanged
    openai-image-tools,                                        ← existing, now wired
    actionRouter(registry),                                    ← NEW: before_agent_start + setActiveTools
    slackApprovalGate({ slackClient, pendingApprovals }),      ← NEW (optional)
    slackPostTool({ slackClient }),                            ← NEW (optional)
  ]
  ↓
session.subscribe(event):
  message_update    → chat.appendStream (markdown_text)
  tool_execution_*  → task_card + plan blocks (streamed in place)
  agent_end         → chat.stopStream + final card + optional Canvas
  ↓
Outputs
  ├─ ephemeral: thread (task_card/plan/card streaming)
  ├─ approval: alert block (via uiContext OR slackApprovalGate)
  └─ durable: canvases.create() markdown, linked into thread
```

**5 components. Every arrow has source-level citation.**

---

## 7. Deletion list

| Delete | Replaced by | Lines |
|---|---|---|
| `index.mjs:769-854` `runPi()` (spawn, ANSI strip, idle timer, timeout, tempfile) | `session.prompt()` + `session.subscribe()` | ~85 |
| `index.mjs:856-` `runPiWithSlackStream` `chat.update` loop | `chat.startStream`/`appendStream`/`stopStream` from `subscribe()` | ~80 |
| `lib/openai-image-client.mjs` | `extensions/openai-image-tools.ts` (already exists, complete) | 313 |
| `lib/agent-run-card.mjs` | Slack native `card` + `alert` blocks | 137 |
| Button handlers `:1238 agent_run_start` + `:1312 agent_run_cancel` | `bindExtensions({ uiContext })` + `session.abort()` | ~150 |
| 13 hardcoded `legacyRoutes` in `index.mjs` | one Action dispatcher reading `registry.yaml` + `actionRouter` extension | ~300 |
| Custom `trace()` event taxonomy | Pi native lifecycle events forwarded with Slack correlations | partial |
| `PI_MOM_AGENT_CANVAS_ENABLED` flag | per-Action `canvas: true` in registry | gone |
| `PI_MOM_AGENT_ROUTE_ENABLED` flag | unconditional Action dispatcher | gone |
| `--no-tools --no-extensions` flags | dropped — extensions ARE the safety layer | gone |
| 5 overlapping docs | one canonical `ARCHITECTURE.md` | ~4 files |

**Conservative estimate: ~1000 lines deleted from `apps/pi-mom`** plus consolidation of overlapping docs.

---

## 8. What stays (and finally turns on)

- `registry.yaml` — Actions catalog (seam between brand and mechanics)
- `agents/*.md` + `.pi/agents/*.md` — subagent definitions (need consolidation; see §10)
- `skills/*/SKILL.md` — 30+ skills, auto-selected by description
- 7 extensions in `extensions/` — finally load:
  - `permission-gate.ts`, `env-guard.ts`, `slack-mcp-guard.ts`, `linear-mcp-guard.ts`, `git-checkpoint.ts` — use only `ctx.*`; safe to keep auto-discovered
  - `browser-use-tools.ts`, `openai-image-tools.ts` — tool registrations, finally callable
- `BOUNDARY.md` authority model

---

## 9. Migration gaps to handle

1. **Package rename:** `@mariozechner/pi-coding-agent ^0.73.1` → `@earendil-works/pi-coding-agent ^0.74.x`. Update imports in 7 extension files + `apps/pi-mom/package.json`. Lockfile literally says *"please use @earendil-works going forward."*
2. **`package.json#pi.*` is CLI-only.** Root `package.json:24` `pi.extensions/skills/agents/prompts` paths are dead under SDK. Host must enumerate explicitly via `DefaultResourceLoader({ extensionFactories, additionalExtensionPaths })` + `resources_discover` event for skills/prompts.
3. **`agents/*.md` invisible to pi-subagents.** pi-subagents only scans `.pi/agents/`. Move or symlink the 12 files in `agents/` → `.pi/agents/`.

---

## 10. Open questions / remaining decisions

1. **Action marker format on the prompt.** How does `actionRouter` know which Action this is?
   - **(a)** Prefix marker `[covent:action=draft_prd] ...` in user text — visible but trivial
   - **(b)** Side-channel via `session_start` payload + `appendEntry` — clean but more code
   - **(c)** Slack-side dispatcher resolves Action → system prompt before `session.prompt()` — simplest, **recommended**
2. **Consolidate `agents/` directories.** Move 12 files to `.pi/agents/`, symlink, or upstream a PR to pi-subagents to scan both. Move is simplest.
3. **Approval pattern per Action.** Some want `ctx.ui.confirm` (simple yes/no via existing permission-gate), others want richer Slack-native approval (timeouts, allowed-approvers, audit log via `slackApprovalGate`). Decide per Action.
4. **Canvas trigger rule.** Per-Action `canvas: true` property, or smarter rule (output length > N or output type in `{spec, digest, prd}`)?
5. **Migration order of 13 legacy routes.** Suggested: trivial first (`help`, `status`) → medium (`summarize`, `agenda`, `escalation`, `digest`) → heavy (`spec`, `linear`) → special-case (`image:` migrates by virtue of `openai-image-tools.ts` being loaded; standalone client cuts).
6. **Concurrency cap actual value.** Start at 5; raise as observed.

---

## 11. First-principles reasoning summary

The unifying insight: **almost every "thing to delete" maps to "we're not using the SDK."**

Grouped by root cause:

**"We're parsing Pi's output instead of subscribing to events":**
- `cleanPiOutput` ANSI stripper
- `PI_OUTPUT_IDLE_MS` idle timer
- `PI_TIMEOUT_MS` + `child.kill`
- Custom `trace()` event taxonomy
- `runPiWithSlackStream` `chat.update` loop

**"We're managing process state instead of session state":**
- Tempfile prompt dance
- Per-request subprocess spawn cost

**"We're reimplementing what extensions already do":**
- Slack-side approval state machine (button handlers at `index.mjs:1238`, `:1312`)
- `lib/openai-image-client.mjs` (313 lines parallel to the unused `extensions/openai-image-tools.ts`)

SDKs exist for projects like pi-mom. Subprocess + stdout-scrape is the lowest-common-denominator integration; SDK is the higher-leverage integration. Pi-mom's `--no-tools --no-extensions` posture means the entire safety + capability layer (7 extensions, 26 subagents, 30+ skills) is currently dead. **The SDK migration is not just a refactor — it's the moment the repo's actual capabilities turn on for the first time intentionally.**

OpenClaw is the reference embedder and confirms the in-process SDK pattern is canonical for non-TUI hosts. The user values leverage and velocity; the SDK provides both. The only legitimate RPC/subprocess use cases (different language host, hard process isolation, multi-tenant) don't apply here.

**The "Elon cut" (alignment + simplification + deletion) and "use the SDK" are the same sentence.**

---

## 12. Pinned tension worth naming

Today's `--no-extensions` posture means **none of the safety extensions actually run.** Turning on the SDK turns them on for the first time. Expect post-migration:
- `permission-gate` to surface dangerous-command prompts you've never seen
- `env-guard` to flag env-leak attempts
- `linear-mcp-guard` / `slack-mcp-guard` to enforce write boundaries

**This is not regression** — it's the safety net catching things the blanket `--no-tools` previously hid. Plan for the first week post-migration accordingly: budget for false positives, surface approval prompts in a low-friction surface (Slack `alert` block), monitor blocked-tool rates.

---

## 13. Vocabulary alignment (cosmetic but high-leverage)

The docs say "Action," the code says "agent." This was the cheapest, highest-leverage alignment fix identified:

| Code today | Should be |
|---|---|
| `agent:` prefix route | `action:` or removed in favor of Action dispatcher |
| Button IDs: `agent_run_start`, `agent_run_cancel` | `action_run_start`, `action_run_cancel` |
| Env flags: `PI_MOM_AGENT_*` | `PI_MOM_ACTION_*` |
| `lib/agent-run-card.mjs` | Deleted, replaced by Slack native `card` block |
| Trace events: `agent.confirmation_posted`, `agent.succeeded` | `action.confirmation_posted`, `action.succeeded` |
| `agent:` prefix route literally surfaces "agent" to users | Removed; users only see Action names |

---

## 14. Citations

### Slack platform
- [AI in Slack overview](https://docs.slack.dev/ai/)
- [AI apps best practices](https://docs.slack.dev/ai/ai-apps-best-practices/)
- [Chat streaming announcement (Oct 2025)](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/)
- [`chat.appendStream` reference](https://docs.slack.dev/reference/methods/chat.appendStream/)
- [Task cards & plan blocks (Feb 2026)](https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks/)
- [Alert/Card/Carousel blocks (Apr 2026)](https://docs.slack.dev/changelog/2026/04/16/block-kit-new-blocks/)
- [Table block (Aug 2025)](https://docs.slack.dev/changelog/2025/08/14/block-kit-table-block/)
- [Markdown block (Feb 2025)](https://docs.slack.dev/changelog/2025/02/03/block-kit-markdown/)
- [`setStatus` scope update (Mar 2026)](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/)
- [Canvases surface](https://docs.slack.dev/surfaces/canvases/)
- [`canvases.create`](https://docs.slack.dev/reference/methods/canvases.create/) · [`canvases.edit`](https://docs.slack.dev/reference/methods/canvases.edit/)
- [Modals surface](https://docs.slack.dev/surfaces/modals/)
- [Powering agentic collaboration (RTS + MCP)](https://slack.com/blog/news/powering-agentic-collaboration)

### Pi runtime
- [pi-mono on GitHub (badlogic)](https://github.com/badlogic/pi-mono)
- [earendil-works/pi (current org)](https://github.com/earendil-works/pi)
- [Pi docs root](https://pi.dev/docs/latest)
- [Pi SDK docs](https://pi.dev/docs/latest/sdk)
- [Pi extensions docs](https://pi.dev/docs/latest/extensions)
- [Pi sessions docs](https://pi.dev/docs/latest/sessions)
- [Pi skills docs](https://pi.dev/docs/latest/skills)
- [Pi usage docs](https://pi.dev/docs/latest/usage)
- [pi-subagents extension](https://github.com/nicobailon/pi-subagents)

### OpenClaw (reference embedder)
- [OpenClaw Pi integration docs](https://docs.openclaw.ai/pi)
- [OpenClaw agent runtimes](https://docs.openclaw.ai/concepts/agent-runtimes.md)
- [OpenClaw streaming and chunking](https://docs.openclaw.ai/concepts/streaming.md)
- [OpenClaw docs index (llms.txt)](https://docs.openclaw.ai/llms.txt)
- ["Pi: The Minimal Agent Within OpenClaw" — Armin Ronacher](https://lucumr.pocoo.org/2026/1/31/pi/)
- ["How to Build a Custom Agent Framework with PI" — dabit3 gist](https://gist.github.com/dabit3/e97dbfe71298b1df4d36542aceb5f158)
- [Mario Zechner: Pi coding agent post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

### Local repo references
- `/home/user/covent-agent-os/apps/pi-mom/index.mjs` — Slack worker (1380 lines)
- `/home/user/covent-agent-os/apps/pi-mom/package.json:17` — `@mariozechner/pi-coding-agent ^0.73.1` (deprecated)
- `/home/user/covent-agent-os/apps/pi-mom/control-plane/registry.yaml` — Actions catalog
- `/home/user/covent-agent-os/extensions/permission-gate.ts:20-29` — `ctx.ui.select` usage
- `/home/user/covent-agent-os/extensions/openai-image-tools.ts` — complete tool registration, currently dead
- `/home/user/covent-agent-os/docs/architecture.md` — declares "Actions" as team-facing primitive
- `/home/user/covent-agent-os/BOUNDARY.md` — authority model
- `/home/user/covent-agent-os/MIGRATION_MAP.md` — in-progress migration documentation
