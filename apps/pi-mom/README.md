# Covent pi-mom Slack bridge

Local Socket Mode bridge for testing your first Pi AI agent in Covent Slack.

## 1. Paste the manifest

Open your Slack app settings → **App Manifest** → paste `manifest.yaml` → Save.

This enables:
- Socket Mode
- bot user `Covent Pi`
- `app_mention` + `app_home_opened` events
- DM events via `message.im`
- Assistant container events (`assistant_thread_started`, `assistant_thread_context_changed`)
- Agents & AI Apps surface (top-bar entry + split-view + Chat/History tabs in App Home) via `features.agent_view` with the four canonical suggested prompts (spec, linear, agenda, summarize)
- slash command `/thread-spec`
- private-channel thread context for channels the app is invited into

When updating the deployed Covent app, update the existing app that owns bot user `covent_pi` / `U0B0VJJDKFH`; do not create a new Slack app. If editing an existing remote manifest, merge this command into the exported app config instead of overwriting pre-existing shortcuts, commands, scopes, functions, or event subscriptions.

## 2. Reinstall the app

After changing scopes/events/slash commands, go to **OAuth & Permissions** and reinstall the app to Covent. Slash commands require the `commands` bot scope to be installed/authorized.

Copy the **Bot User OAuth Token** (`xoxb-...`) into your local secret manager. Do not paste it into chat or git.

## 3. Create the app-level Socket Mode token

Go to **Basic Information → App-Level Tokens → Generate Token and Scopes**.

Create a token with:

```text
connections:write
```

Copy the app token (`xapp-...`) into your local secret manager.

## 4. Install local dependencies

From the repo root:

```bash
bun install
```

## 5. Load tokens locally

Example with a local untracked shell only:

```bash
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_APP_TOKEN='xapp-...'
```

Preferred with 1Password/op:

```bash
export SLACK_BOT_TOKEN="$(op read 'op://Covent/Covent Pi Slack App/bot-token')"
export SLACK_APP_TOKEN="$(op read 'op://Covent/Covent Pi Slack App/app-token')"
```

Required before `PI_MOM_MODE=pi` unless you intentionally override with `PI_MOM_ALLOW_ANY_CHANNEL=true`:

```bash
export SLACK_ALLOWED_CHANNEL_ID='C0B05VBGJKF,C0B30N60HGW' # comma-separated channel IDs also supported
```

Optional for creating Linear issues from Slack threads:

```bash
export LINEAR_API_KEY='lin_api_...'
# Defaults target Frontend Engineering / Distribution / Backlog.
# Override only if the Linear target changes:
# export LINEAR_TEAM_ID='c9c8376e-7fd3-4921-9996-8c98fc2274f2'
# export LINEAR_PROJECT_ID='ba9682e2-c14e-4208-98a2-a89f3fb285b8'
# export LINEAR_STATE_ID='adfdb6e9-b118-4d65-ada3-ad11087b7dab'
```

## 6. Run the bridge

From the repo root:

```bash
bun --filter pi-mom run doctor
bun --filter pi-mom run start
```

Before live local testing, confirm whether the Railway production worker is already running. Do not intentionally run duplicate workers against the same Slack app/channel unless you are doing controlled debugging.

## 7. Test in approved Slack channels

In an approved Slack channel such as private `#idea-specs` or another ID listed in `SLACK_ALLOWED_CHANNEL_ID(S)`:

```text
/invite @Covent Pi
@Covent Pi hello — prove the Slack → Pi → Slack loop works
```

The app will reply in the thread. For Pi mode, keep `SLACK_ALLOWED_CHANNEL_ID` / `SLACK_ALLOWED_CHANNEL_IDS` set to the intended channel IDs so the bot fails closed outside those channels.

Built-in bridge commands:

```text
@Covent Pi help:
@Covent Pi status:
```

Preferred spec UX:

```text
# Reply inside the Slack thread you want turned into a spec
@Covent Pi draft spec
```

The app mention event includes the current thread context, so no one has to copy/paste a Slack URL. If this command is run outside a thread, the bot replies with a usage hint instead of guessing.

Fallback slash command:

```text
/thread-spec <Slack message/thread URL> [optional focus]
```

Use this only as an operator/debug fallback; the bridge replies ephemerally with usage/status and routes the spec draft into the referenced Slack thread.

Routed workflow prefixes (defined in `lib/routes.mjs`):

```text
@Covent Pi summarize: decisions, open questions, and next actions
@Covent Pi linear: create an issue from this thread (uses linear_create_issue tool, search-first)
@Covent Pi agenda: prep a meeting agenda from this thread
@Covent Pi spec: turn this idea into a safe implementation/spec draft (mirrors to a Slack canvas)
@Covent Pi team: doctor | context <scope> | plan <task> | review <target>   (subagent workflow)
@Covent Pi bash: <command>   (runs via the bash tool)
```

Bare mentions (no prefix) and all Pi-backed prefixes get the full registered Pi tool surface by default: bash/file tools, app extensions, skills, Linear tools, Slack UI tools, Browser Use, `pi-subagents`, and the app-pinned `pi-web-access` tools. Prefixes shape the workflow instruction; they do not restrict tools.

In `PI_MOM_MODE=echo`, the bridge acknowledges the detected route without invoking Pi. In `PI_MOM_MODE=pi`, the route injects a stronger workflow instruction into the Pi prompt.

Linear route behavior in `PI_MOM_MODE=pi`:

- Driven by the modular Linear Pi custom tools (`extensions/linear-tools.ts`): `linear_search_issues`, `linear_create_issue`, `linear_add_comment`.
- The model's prompt nudges it to search first, then comment-or-create — idempotency lives in the model's reasoning, not in a post-stream guard.
- Default target is Frontend Engineering / `Distribution` / `Backlog` (override with `LINEAR_TEAM_ID` / `LINEAR_PROJECT_ID` / `LINEAR_STATE_ID`).
- Requires `LINEAR_API_KEY`. Without it, each tool returns an `isError` result and the model reports the missing key to the user.

Team subagents behavior in `PI_MOM_MODE=pi`:

- `pi-subagents` is loaded by default from the app dependency (`pi-subagents@0.24.2`).
- The `team:` prefix is a workflow convenience for `doctor`, `context`, `plan`, and `review` style requests; the `subagent` tool is available to every Pi-backed route.
- Project-owned team profiles live in `.agents/team-*.md`; they inherit skills, omit tool allowlists, and load the same app-approved extension surface for child `pi` CLI runs.
- Child subagent runs spawn the `pi` CLI, so the deployment image must have `pi` on PATH.
- Team subagent Canvas sidecars are attached for the `team:` route when child runs emit subagent tool events.

Web access behavior in `PI_MOM_MODE=pi`:

- `pi-web-access@0.10.7` is loaded by default from the app-pinned dependency through `DefaultResourceLoader.additionalExtensionPaths`; ambient extension discovery remains off with `noExtensions: true`.
- Bundled `pi-web-access/skills` are loaded through `additionalSkillPaths`; no global/user package auto-install is required because `PI_OFFLINE=1` is preserved.
- Web tools are available across Pi-backed routes. Use them when public web or code-search context helps answer the user's request.
- Keep browser-cookie Gemini Web off by default (`PI_ALLOW_BROWSER_COOKIES=0`/unset). Optional provider keys are `EXA_API_KEY`, `PERPLEXITY_API_KEY`, and `GEMINI_API_KEY`.

Streaming behavior in `PI_MOM_MODE=pi`:

- Streaming is always on via `lib/slack-sink.mjs` (Stage 5). It batches Pi `text_delta` events every ~200ms and emits zero-width-space heartbeats every 25s to keep Slack's stream session alive across long thinking runs.
- Pi tool/skill/extension access is default-on for Pi-backed routes. `lib/routes.mjs` provides workflow instructions/help/status, not per-route allowlists. `lib/pi-sdk-runner.mjs` keeps ambient extension auto-discovery disabled (`noExtensions: true`) but explicitly loads app factories (Linear, Slack UI, Browser Use, git checkpoint, `pi-subagents`) plus the app-pinned `pi-web-access` extension and skills. Token-like output is redacted before posting. Per-thread session resumption is handled by `lib/pi-session.mjs`.

## Observability & Tracing (DX)

Tracing is enabled by default. Every request logs structured JSON lines prefixed with `[pi-mom-trace]` containing:

- `slack.received` — incoming mention/DM
- `slack.thread_context` — how much context was pulled from the thread
- `pi.prompt_built` — prompt size sent to Pi, including detected route when present
- `pi.output_ready` — Pi run completion (SDK agent_end or timeout)
- `slack.stream_started` / `slack.stream_stopped` / `slack.replied_pi_stream` — streaming response lifecycle
- `slack.replied_echo` / `slack.replied_pi` / `slack.replied_help` / `slack.replied_status` — bridge response type
- `error` — any failures

Each event includes a `requestId`, `durationMs`, lengths, and other useful metadata.

To disable:
```bash
export PI_MOM_TRACE=false
```

You can pipe logs or `grep "pi-mom-trace"` for easy observability. This gives you clear end-to-end visibility for DX and debugging without external services.

## Codex auth: one shared account for the whole bot

All Slack users transparently run on a **single shared ChatGPT Max account** that Andy owns. There is no per-user OAuth, no sign-in card, no `localhost:1455` paste dance — model calls just work for every member of the workspace.

The mechanism is straightforward:

1. **Bootstrap (one-time)** — on Andy's laptop, run `pi login openai-codex`. This produces `~/.pi/agent/auth.json` containing an `openai-codex` entry with refresh + access tokens for his ChatGPT Max subscription.
2. **Seed Railway** — base64-encode that file and set it as the `PI_AUTH_JSON_B64` env var on the `covent-pi-mom-v2` Railway service. On cold boot, `lib/pi-sdk-runner.mjs` writes it to `${PI_AGENT_DIR}/auth.json` *only if the file is missing* (so we never clobber rotated tokens).
3. **Rotation** — Pi's SDK rotates the access token on every model call and writes back to `auth.json`. The Railway volume mounted at `/data/pi-agent` keeps that file across redeploys. Refresh tokens last roughly 90 days; if a rotation fails for that long, Andy re-runs step 1 and reseeds `PI_AUTH_JSON_B64`.

Re-seed shortcut from his laptop:

```bash
base64 -w0 ~/.pi/agent/auth.json | xclip -selection clipboard   # then paste into Railway env
```

If you ever see "Codex authentication failed" in the bot logs, that's the signal to redo step 1.

## Known-good bare-bones state

As of 2026-05-03, the Covent Pi bridge has a working bare-bones path:

```text
@Covent Pi mention in #idea-specs
  → Socket Mode app_mention event
  → local bridge
  → Slack thread acknowledgement
  → in-process Pi SDK session (createAgentSession)
```

Known-good non-secret values:

- Expected bot user: `covent_pi`
- Observed bot user ID: `U0B0VJJDKFH`
- Test channel: `#idea-specs`
- Test channel ID: `C0B05VBGJKF`
- Default mode for proof: `PI_MOM_MODE=echo`
- Full mode: `PI_MOM_MODE=pi`
- Pi model: `PI_MOM_MODEL=openai-codex/gpt-5.5` with `PI_MOM_THINKING_LEVEL=high` by default

Detailed historical runbook: `docs/archive/runbooks/covent-pi-mom-known-good.md` (archived evidence only; not current instructions).

## MCP servers (pi-mcp-adapter)

The bridge plugs arbitrary MCP servers in through [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter), loaded inline alongside `pi-subagents` / `pi-web-access` in `lib/pi-sdk-runner.mjs#buildPiMomExtensionFactories`. The adapter registers one `mcp` proxy tool (~200 tokens) that handles discovery (`mcp({ search: "…" })`), describe, and call; servers start lazily on first tool call.

**Config file precedence** (first match wins):
1. `~/.config/mcp/mcp.json` — user-global shared
2. `${PI_AGENT_DIR}/mcp.json` — Pi global override (the Railway target)
3. `.mcp.json` — project shared
4. `.pi/mcp.json` — Pi project override (gitignored)

The schema lives in [`/examples/mcp.example.json`](../../examples/mcp.example.json). Use `${VAR}` / `$env:VAR` for header/env/bearer values so secrets stay in your secret manager.

**Railway:** set `PI_MCP_JSON_B64` to `base64 -w0 < mcp.json`. The runner seeds `${PI_AGENT_DIR}/mcp.json` on cold boot only when the file is missing, so OAuth tokens and `directTools` overrides persisted by the adapter on the volume are preserved across deploys. Rotate by deleting the file on the volume and redeploying.

**directTools:** by default every MCP tool is reached through the `mcp` proxy. Set `directTools: true` (or a list of original tool names) per server to register that server's tools as top-level Pi tools so the model sees them next to `read`, `bash`, `edit`, etc.

**Interactive auth:** OAuth flows (`/mcp-auth <server>`) require a TUI Pi session — run them locally against the same `PI_AGENT_DIR`, then redeploy. Bearer / `client_credentials` servers don't need this.

`bun run doctor:pi-mom` reports adapter resolution and the active `mcp.json` path/server count.

## Notes

- Streaming is always on via `lib/slack-sink.mjs`. The legacy `PI_MOM_STREAMING` knob was removed in Stage 5; there is no `chat.update` fallback path.
- Pi runs in-process with a session resolved per Slack thread (see `lib/pi-session.mjs`). Tool availability is default-all: normal Slack turns omit a route tool allowlist, and the runner activates every registered tool returned by the SDK session. Private Slack snippets are still not persisted in Pi session history.
- Trusted-operator + channel-allowlist + Codex sign-in are the perimeter for this POC; route-specific in-process safety extensions are not loaded.
- The bridge uses Slack Web API only for the current thread context, final reply, canvas mirror (spec: route), and approval modals.
- If private-channel thread context fails, verify the app is invited to the channel and has `groups:history`.
