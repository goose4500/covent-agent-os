> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# pi-mom Slack programmatic UX seams — local reconnaissance

Branch: `feat/pi-mom-agent-run-card` (`git status` shows local modified/new docs + pi-mom agent-run-card files; no edits made except this report).

## Current shape

- Main app is still a Bolt monolith: `apps/pi-mom/index.mjs` registers Socket Mode app, env/config, route parsing, Pi subprocess, Linear, image route, agent card route/actions, slash command, events.
- Existing extracted seams:
  - `apps/pi-mom/lib/agent-run-card.mjs`: pure Block Kit builders and request parser.
  - `apps/pi-mom/lib/agent-run-store.mjs`: JSON run metadata store.
  - `apps/pi-mom/lib/agent-runners.mjs`: bounded fake/repo-health/supervised-pi runners.
  - `apps/pi-mom/lib/slack-canvas.mjs`: best-effort Slack Canvas creation.
  - `apps/pi-mom/lib/openai-image-client.mjs`: OpenAI image client used by image route.

## Exact integration seams

### Route detection / command parsing

- `apps/pi-mom/index.mjs:81-114` `ROUTES` is the current route registry for text prefixes: `summarize`, `linear`, `agenda`, `escalation`, `spec`, `digest`, `image`, `agent`.
- `apps/pi-mom/index.mjs:147-164` `parseCommand(text)` detects `<route>:` prefixes.
- `apps/pi-mom/index.mjs:166-212` natural-language app-mention shortcuts exist only for spec and Linear creation (`parseThreadSpecIntent`, `parseLinearCreateIntent`, `parseSlackRequestCommand`).
- Safe extraction target: `lib/domain/routes.mjs` or `lib/routes/registry.mjs` exporting `ROUTES`, `parseCommand`, natural intent parsers.

### Block Kit cards

- Existing pure card seam: `apps/pi-mom/lib/agent-run-card.mjs`:
  - `parseAgentRequest(text)` lines 3-7.
  - `formatRunSummary(run)` lines 26-29.
  - `buildAgentRunCard(run)` lines 50-92: confirmation card with `agent_run_start` and `agent_run_cancel` buttons.
  - `buildAgentRunUpdate(run)` lines 94-109: status/result/canvas update card.
- Posting seam: `apps/pi-mom/index.mjs:983-1013` creates run and posts `buildAgentRunCard(run)`.
- Update seam: `apps/pi-mom/index.mjs:1206-1258`, `1284-1297` update original card with `buildAgentRunUpdate(run)`.
- Smallest safe expansion: keep Block Kit builders pure; add new card/modal builders beside this file, then register handlers in a thin interactions module.

### Button actions / interactivity

- Manifest enables interactivity: `apps/pi-mom/manifest.yaml:85-86`.
- Registered Bolt actions:
  - `apps/pi-mom/index.mjs:1187-1259` `app.action("agent_run_start", ...)`: acks, feature-flag check, run lookup, channel scope check, status/concurrency check, starts runner, updates card, optionally creates Canvas, persists result.
  - `apps/pi-mom/index.mjs:1261-1299` `app.action("agent_run_cancel", ...)`: acks, feature-flag/channel checks, aborts active run or cancels pending run.
- Ephemeral action notices: `apps/pi-mom/index.mjs:1176-1185` `postAgentActionNotice`.
- In-memory concurrency/abort state: `apps/pi-mom/index.mjs:916` `activeRuns = new Map()`; run state persists but active controllers do not survive restart.
- Safe extraction target: `lib/interactions/agent-run-actions.mjs` exporting `registerAgentRunActions(app, deps)`.

### Modals

- No modal seam exists yet. Grep found no `app.view`, `views.open`, `views.update`, `trigger_id`, or `callback_id` usage under `apps/pi-mom` (excluding `node_modules`).
- Add modal scopes/manifest only when needed; current manifest has broad scopes but no `shortcuts`/modal callback declarations.
- Safe seam to introduce: pure `lib/ui/modals/*.mjs` builders plus `lib/interactions/modal-actions.mjs`; action handlers must `ack()` immediately, then call `client.views.open({ trigger_id, view })`.

### Message shortcuts

- No global or message shortcut is declared in `apps/pi-mom/manifest.yaml`; only slash command `/thread-spec` exists (`manifest.yaml:25-28`).
- No Bolt shortcut handlers exist (`app.shortcut` grep empty).
- Existing fallback UX is slash-command URL parsing:
  - `parseSlackThreadReference` in `apps/pi-mom/index.mjs:222-245`.
  - `handleThreadSpecSlashCommand` in `apps/pi-mom/index.mjs:1116-1169`.
  - `app.command("/thread-spec")` in `apps/pi-mom/index.mjs:1171-1174`.
- Smallest shortcut MVP: add one message shortcut in manifest (e.g. `create_agent_run` or `draft_spec_from_message`), register `app.messageShortcut(callback_id, ...)`, synthesize the same event shape used by `handleRequest`, or open a modal prefilled from the message.

### App Home

- Manifest enables App Home: `apps/pi-mom/manifest.yaml:9-13`, but there is no `app_home_opened` event subscription and no handler; grep found no `views.publish`.
- To implement App Home, add bot event `app_home_opened` to manifest and register `app.event("app_home_opened", ...)` that calls `client.views.publish({ user_id, view })`.
- Useful existing data source: `runStore.listRecent(limit)` in `apps/pi-mom/lib/agent-run-store.mjs:68-70` can back a “recent runs” Home tab.

### Agent profile registry / CLI

- Profiles live in `agent-kits/profiles/*.yaml`.
  - `agent-kits/profiles/covent-speed-operator.yaml`: high-agency trusted internal profile, `slackInvocationApproval: true`, shell/writes/external mutation allowed, audit protections `env-guard`, `git-checkpoint`.
  - Other profiles (`readonly-research`, `repo-writer`, `slack-safe`, `linear-operator`, `deploy-supervised`, `full-supervised`, `browser-operator`) are legacy safe-mode profiles.
- Profile README: `agent-kits/profiles/README.md` says `covent-speed-operator` is default for trusted EC2/local speed mode; explicit Slack invocation is approval while env/git guards remain.
- CLI seam: `scripts/scaffold-agent.mjs`:
  - `REQUIRED_PROFILE_KEYS` lines 11-22 defines required profile schema.
  - `parseArgs` lines 30-68 requires `<agent-name> --profile <profile-name>`.
  - reads profile at `agent-kits/profiles/${profile}.yaml` and writes `.pi/agents/<name>.md`, `skills/<name>/SKILL.md`, `prompts/<name>.md` (`scripts/scaffold-agent.mjs:221-256`).
- Validation seam: `scripts/validate-agents.mjs` validates `.pi/agents` and `agents` frontmatter, tools allowlist, and referenced skills.
- Root scripts: `package.json:18-20` exposes `validate:agents` and `agent:new`.
- Current gap: pi-mom agent run cards do not select/read these profiles. `PI_MOM_AGENT_RUNNER` is only one of `fake|repo-health|supervised-pi` (`apps/pi-mom/index.mjs:63-67`; `lib/agent-runners.mjs:124`).

### Runners / execution constraints

- `apps/pi-mom/lib/agent-runners.mjs`:
  - `REPO_HEALTH_COMMANDS` lines 113-122: fixed command tuples only.
  - `getAgentRunnerModes` / `getRepoHealthCommandTuples` lines 128-134.
  - `scrubSensitiveEnv` lines 154-161 removes token/secret/key/password/slack/linear/openai/aws/etc env vars.
  - `defaultCommandRunner` lines 191-224 uses `spawn(..., shell:false)`, timeout, output cap/redaction.
  - `runFakeAgent` lines 178-189 executes no tools.
  - `runSupervisedPiAgent` lines 226-239 is represented but explicitly not wired to execute Pi.
  - `runRepoHealthAgent` lines 241-267 runs fixed read-only checks.
  - `createAgentRunner` lines 269-280 dispatches mode.
- Pi subprocess path for non-agent routes: `apps/pi-mom/index.mjs:731-739` writes prompt to `0600` temp file and runs `pi ... --no-session -p @prompt`; if `PI_MOM_ALLOW_PI_TOOLS` is not false, tools/extensions are enabled (`index.mjs:50`, `738`). Env examples set it false; code default is enabled unless env is explicitly `false`.

### Persistence / Canvas

- Run store: `apps/pi-mom/lib/agent-run-store.mjs`:
  - `sanitizeRun` lines 8-18 allowlists metadata fields.
  - `persist` lines 25-29 writes `0600` JSON via temp+rename.
  - `create/get/update/listRecent` lines 46-70.
- Canvas: `apps/pi-mom/lib/slack-canvas.mjs:73-101` calls `canvases.create` with markdown clipped to 100k chars; failures trace and return `undefined`.
- Canvas integration after successful run: `apps/pi-mom/index.mjs:1234-1237`.

### Smoke tests / checks

- App package check: `apps/pi-mom/package.json:56-60` runs `node --check` for app/lib/test files, then `node test-agent-run-card.mjs`.
- Root check includes pi-mom: `package.json:12-16` `npm run check:pi-mom`.
- `apps/pi-mom/test-agent-run-card.mjs` covers:
  - card action IDs/button values and supervised-pi copy.
  - store persist/reload.
  - fake deterministic hash and abort.
  - runner modes and invalid mode rejection.
  - repo-health fixed command tuples and `shell:false`.
  - Canvas success/synthesized URL/failure.
- Doctor: `apps/pi-mom/doctor.mjs` checks Slack tokens/auth, OpenAI/Linear presence, Pi availability, channel-scope config. It currently makes Slack network calls; not a pure local smoke test.

## Manifest / Slack surface constraints

- Current events: only `app_mention` and `message.im` (`manifest.yaml:80-84`).
- Slash commands: only `/thread-spec` (`manifest.yaml:25-28`).
- Interactivity is enabled (`manifest.yaml:85-86`).
- App Home enabled but inactive: no `app_home_opened` event/handler.
- No shortcuts declared and no `app.shortcut` handlers.
- Broad speed-mode scopes are already present (`manifest.yaml:31-79`), including `chat:write`, `files:*`, `canvases:*`, `groups:history`, `im:*`, etc.; authority is supposed to be bound by route/profile, not ambient scope.

## Architectural constraints from docs

- `docs/specs/pr-closure-and-pi-mom-mvp-plan.md` calls for replacing big TypeScript/modularity work with small `.mjs` seams: `config`, `trace`, `domain`, `adapters`, `routes`, `interactions`, `agent-runs`; no behavior changes first.
- Same plan says Agent Run Card should be kept as first interactivity MVP but integrated via `routes/agent.mjs`, `interactions/agent-run-actions.mjs`, `agent-runs/*`.
- `BOUNDARY.md` and `docs/architecture.md`: Slack is cockpit/route selector; explicit authorized Slack invocation is approval for selected route/profile in trusted internal speed mode; broad scopes are acceptable only when route/profile-bound, logged, redacted, and revocable.
- `docs/specs/covent-slack-pi-harness.md` is archived safe-mode history; current authoritative posture is trusted internal speed mode, but secrets/raw private exports remain forbidden.

## Smallest-safe extraction plan

1. **Freeze behavior with local tests first**: keep `apps/pi-mom/test-agent-run-card.mjs`; add pure tests for command parsing and future UI builders before moving code.
2. **Extract pure config/trace/domain, no UX changes**:
   - `lib/config.mjs`: env parsing currently at `index.mjs:14-79`.
   - `lib/trace.mjs`: `trace` from `index.mjs:122-126`.
   - `lib/domain/routes.mjs`: `ROUTES`, `parseCommand`, natural intents, Slack URL parsing.
3. **Move existing agent run files under `lib/agent-runs/`** with re-export shims or one import update: card/store/runners/canvas. Keep tests green.
4. **Extract route handlers**:
   - `lib/routes/agent.mjs`: code from `index.mjs:983-1013`.
   - `lib/routes/image.mjs`: code around `handleImageRequest` (`index.mjs:574-671`) plus helpers.
   - `lib/routes/pi.mjs`/`linear.mjs`: general Pi/Linear route flow from `index.mjs:1031-1102`.
5. **Extract interactions**:
   - `lib/interactions/agent-run-actions.mjs`: `postAgentActionNotice`, `agent_run_start`, `agent_run_cancel`; inject `runStore`, `agentRunner`, `activeRuns`, config, `createRunCanvas`, trace.
6. **Add programmatic UX MVPs one at a time**:
   - Message shortcut first: manifest shortcut + `app.messageShortcut` that reuses existing route/modal seam.
   - Modal second: pure modal builder + `views.open` action handler + `app.view` submit handler.
   - App Home third: add `app_home_opened` event + `views.publish` using `runStore.listRecent`.
   - Profile selector last: load YAML profiles into a registry, expose safe subset in App Home/modal/card, but do not wire arbitrary profile execution until runner/profile authority mapping exists.
7. **Keep safety invariants**: all interactive handlers `ack()` fast; feature flags disable both trigger and action execution; no arbitrary shell from Slack prompt; supervised-pi remains not wired until a separate review; run state stores metadata only; redact before Slack output.
