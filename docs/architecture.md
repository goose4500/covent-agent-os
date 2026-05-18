# Architecture

> **Status:** current pi-mom architecture as of 2026-05-14. Parent Pi runs are in-process; route prefixes shape workflow only; all registered tools/skills/app extensions are default-on for Pi-backed Slack turns.

## What you're looking at

`covent-pi-mom` is a Slack Socket Mode bridge that runs Pi (an AI coding agent) in-process and streams answers back to Slack threads. Bolt's Assistant container, DMs, slash fallback, and legacy `app_mention` events all converge on the same request path in `apps/pi-mom/index.mjs`.

The bridge keeps route parsing simple: `apps/pi-mom/lib/routes.mjs` owns route labels, workflow instructions, help text, and status text. It does **not** own tool allowlists. Normal Pi turns activate every registered SDK tool by default.

## The 3 primitives

```text
@earendil-works/pi-coding-agent@0.75.3   ─►  in-process parent Pi agent
@slack/bolt@4.7.2 + @slack/web-api@7.16.0  ─►  Slack runtime + streaming + canvases
apps/pi-mom/lib/routes.mjs               ─►  route labels/instructions/help/status
```

Everything else is wiring. No YAML control plane. No post-stream Linear scraper. No route-specific safety extension layer.

## End-to-end flow

```text
Slack event (app_mention | Assistant userMessage | DM | /thread-spec)
  │
  ▼
Bolt receiver
  │
  ▼
handleRequest / route parsing
  │
  ▼
resolveAction(command) ──► { name, routeKey, route }
  │
  ▼
buildPiPrompt(route.instruction + Slack thread context + user text)
  │
  ▼
runTurn({ surface, threadTs, prompt, sink, uiContext })
  │
  ├─► SessionManager.open(thread_session_map[threadTs]) or .create(repoRoot)
  │
  ├─► createAgentSession({ model, sessionManager, resourceLoader, … })
  │      .bindExtensions({ uiContext: slackUI })
  │      .setActiveToolsByName(all registered tool names)
  │
  ├─► session.subscribe(evt ─► sink.handle(evt))
  │
  └─► session.prompt(prompt)

Pi events stream out:
  text_delta       ─► slack-sink batches every 200ms → chat.appendStream
                      canvas-sink debounces → canvases.edit (spec: route)
  tool_call        ─► registered Pi tools run directly
  subagent events  ─► subagent-canvas-sidecar-sink creates/updates child canvases (team: route)
  agent_end        ─► chat.stopStream + final action chunks
```

## Tool / extension posture

Normal Slack Pi turns omit `tools`, so `apps/pi-mom/lib/pi-sdk-runner.mjs`:

1. creates the SDK session with tools enabled;
2. reads `session.getAllTools()`;
3. calls `session.setActiveToolsByName([...allToolNames])`.

`DefaultResourceLoader` keeps ambient extension auto-discovery disabled with `noExtensions: true`, but explicitly loads app-approved factories/paths:

- `extensions/linear-tools.ts`
- `extensions/slack-interactive-tools.ts`
- `extensions/browser-use-tools.ts`
- `extensions/git-checkpoint.ts`
- official `pi-subagents@0.24.3`
- official `pi-web-access@0.10.7` via `additionalExtensionPaths`

Skills are also default-on: repo skills plus `pi-web-access/skills` are added explicitly, and `noSkills: false` allows the SDK's normal skill discovery. `PI_OFFLINE=1` remains set so the SDK does not auto-install user-scope packages at session creation.

An explicit internal `tools: []` still creates `noTools: "all"` for tests/non-Pi bridge replies. Route definitions no longer pass tool arrays.

## File tree

```text
apps/pi-mom/
├── index.mjs                         bun entry; Slack/Bolt boot; request handling; App Home
├── lib/
│   ├── routes.mjs                    route labels/instructions/help/status
│   ├── dispatch.mjs                  dispatch helper
│   ├── pi-sdk-runner.mjs             createAgentSession/resource-loader glue
│   ├── pi-session.mjs                per-thread SessionManager + runTurn
│   ├── thread-session-map.mjs        JSON-on-disk threadTs → session path
│   ├── slack-sink.mjs                Pi events → chat.startStream/appendStream
│   ├── slack-ui-context.mjs          Pi ExtensionUIContext → Slack UI
│   ├── canvas-sink.mjs               spec: output → Slack canvas
│   ├── subagent-canvas-sidecar-sink.mjs team: child runs → sidecar canvases
│   ├── composite-sink.mjs            fan one Pi stream to multiple sinks
│   ├── redaction.mjs                 streaming/output redaction helpers
│   └── home-view.mjs                 App Home view builder
└── test-*.mjs                        bun smoke/unit suites
```

## Active routes

| Route | What it does |
|---|---|
| `plain` (no prefix) | Full default Pi agent |
| `help` | Hard-coded menu |
| `status` | Bridge health/config |
| `summarize` | Thread → decisions/questions/owners/next-actions |
| `linear` | Linear issue/comment workflow |
| `agenda` | Thread → meeting agenda |
| `spec` | Thread → PRD draft; mirrors to Slack canvas |
| `team` | Team subagent workflow; creates Canvas sidecars for child runs |
| `bash` | Explicit shell workflow |

Again: this table is not a security matrix. All Pi-backed routes have the same registered tool surface.

## Streaming + canvases

`lib/slack-sink.mjs` is the only Slack streaming path. It batches Pi `text_delta` events every ~200ms and emits zero-width-space heartbeats every 25s to keep long thinking runs alive. On `agent_end`, it calls `chat.stopStream` with final action chunks.

`spec:` uses `canvas-sink.mjs` to mirror long-form output to a standalone Slack canvas. `team:` uses `subagent-canvas-sidecar-sink.mjs` to create/update child-run sidecar canvases and append footer links back into the main Slack stream.

## Linear as modular custom tools

`extensions/linear-tools.ts` registers:

| Tool | Purpose |
|---|---|
| `linear_search_issues` | Find likely duplicates / previous issues |
| `linear_create_issue` | Create a new issue in the configured team/project/state |
| `linear_add_comment` | Comment on an existing issue |

Idempotency lives in model reasoning and route instructions, not in a post-stream scraper.

## Production notes

- Railway production service: `covent-pi-mom`, source branch `main`.
- Parent Pi auth is seeded by `PI_AUTH_JSON_B64` into `${PI_AGENT_DIR}/auth.json` on cold boot.
- `PI_OFFLINE=1` should stay set.
- Child subagent runs spawn the `pi` CLI, so the deployment image must keep `pi` on PATH.
- Real secrets live in Railway variables only; docs and tests use placeholders.

## Current references

- [`README.md`](../README.md)
- [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md)
- [`docs/SYSTEM_INDEX.md`](SYSTEM_INDEX.md)
- [`apps/pi-mom/README.md`](../apps/pi-mom/README.md)
- [`apps/pi-mom/lib/routes.mjs`](../apps/pi-mom/lib/routes.mjs)
- [`apps/pi-mom/lib/pi-sdk-runner.mjs`](../apps/pi-mom/lib/pi-sdk-runner.mjs)
