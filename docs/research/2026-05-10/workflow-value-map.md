# Covent Agent OS workflow value map

Date: 2026-05-10  
Scope: product/workflow context map from the user's goal plus local repo docs/code. Repo was inspected read-only except for this requested output file.

## Executive read

Covent Agent OS is already centered on the right product loop:

```text
Slack discussion / explicit route invocation
  → pi-mom route/profile detection
  → Pi synthesis or bounded runner/tool execution
  → source-linked artifact in Slack, Linear, Git/GitHub, or repo docs
  → validation / audit / rollback path
```

The highest-value next implementation is not a broad autonomous agent platform. It is a polished set of explicit Slack cockpit workflows, backed by declared Pi profiles and bounded runner presets. The strongest first tranche is:

1. **Thread-to-Linear with duplicate guard + richer issue fields** — highest team value; already mostly built.
2. **Thread-to-spec / PRD as a polished Slack thread card** — high value and lowest implementation risk.
3. **Agent Run Card for repo-worker/test-writer/reviewer presets** — very high strategic reuse; current MVP exists but needs modularization and safer preset shape before write-capable runs.
4. **Daily context prime** — high leverage for founder/team memory; moderate complexity because it needs Slack/Linear/Git context policy and summarization boundaries.
5. **PR cleanup concierge** — high team value after agent-run presets exist; should start as review/report + checklist, not auto-merge.
6. **Smoke tests from Slack** — great polish/reuse and low risk when implemented as fixed runner presets.
7. **Create agent profile from Slack/CLI** — strategic but later; needs profile schema/policy validation and is easier to get wrong.

## Current source-backed product model

### Durable truth and authority model

- `docs/SYSTEM_INDEX.md:10-21` defines system roles: Slack is conversation/trigger context, Pi is synthesis/action, Linear is execution truth, Git/GitHub is implementation truth, repo docs are canonical system memory, Railway is runtime truth, and EC2 is the trusted operator substrate.
- `docs/SYSTEM_INDEX.md:23-40` states the current operating loop and the highest-value loop: Slack thread → explicit Covent Pi mention → route/profile authorization → route-allowed mutation → Slack confirmation → Git/Railway as needed; “Slack discussion becomes Linear truth, backed by Git implementation and repo documentation.”
- `BOUNDARY.md:16-28` makes trusted internal speed mode explicit: an authorized Slack app mention/slash command/profile invocation is approval for that selected route/profile; Pi, Linear, GitHub/Git, tools, browser, and EC2 authority are bounded by the declared profile.
- `BOUNDARY.md:30-44` says every route/profile must declare input shape, allowed context/tools/mutations, output, failure/idempotency, redaction/audit, and kill switch.
- `BOUNDARY.md:46-67` says ask again only for outside-profile, destructive, secret-bearing, ambiguous, duplicate/non-idempotent, irreversible, or incident/kill-switch cases; prefer summaries/source links over raw dumps.

### Current Slack UX and implementation seams

- `docs/SYSTEM_INDEX.md:89-108` lists supported primary UX: in-thread `@Covent Pi draft spec`, `@Covent Pi create Linear issue`, fallback `/thread-spec <Slack URL> [focus]`, and prefix routes `summarize:`, `linear:`, `agenda:`, `escalation:`, `spec:`, `digest:`, `image:`.
- `docs/SYSTEM_INDEX.md:110-125` states thread context is capped at 12 messages; normal/spec/linear routes are text-only; image route can collect PNG/JPEG/WebP.
- `docs/SYSTEM_INDEX.md:158-165` lists important current limits: no pagination, text-only spec/linear, no modal preview, non-idempotent Linear issue creation, basic Linear metadata, broad Slack scopes tied to route/profile controls.
- `apps/pi-mom/index.mjs:81-114` contains the in-code route registry for summarize, linear, agenda, escalation, spec, digest, image, and agent.
- `apps/pi-mom/index.mjs:147-213` parses `help`, `status`, explicit `route:`, natural in-thread spec intent, and natural Linear issue intent.
- `apps/pi-mom/index.mjs:295-309` fetches up to 12 Slack thread messages and formats only user/timestamp/text into context.
- `apps/pi-mom/index.mjs:730-743` launches Pi via a temp prompt file with `--no-session`; tools/extensions stay off unless `PI_MOM_ALLOW_PI_TOOLS=true`.
- `apps/pi-mom/index.mjs:934-1105` is the central request path: enforce channel policy, help/status, thread-required guard, agent card, echo, image route, Pi prompt build/stream, optional Linear creation, error reply.
- `apps/pi-mom/index.mjs:1171-1309` registers `/thread-spec`, `agent_run_start`, `agent_run_cancel`, `app_mention`, and DM message handling.

### Existing Linear route

- `docs/AGENT_CONTEXT.md:124-158` defines the Linear route contract: explicit `@Covent Pi create Linear issue` or `linear:` inside the target thread; allowed context is current Slack thread text capped at 12 messages; tools are Slack Web API, Pi subprocess, Linear GraphQL; output is Pi draft + Slack confirmation; idempotency is not yet solved.
- `apps/pi-mom/index.mjs:86-89` instructs Pi to output a Linear-ready issue with first line `Title: ...`.
- `apps/pi-mom/index.mjs:1052-1069` and `1083-1100` create a Linear issue after Pi output and post either `Created Linear issue ...` or a no-issue-created failure notice.
- `apps/pi-mom/README.md:165-170` documents the current target: Frontend Engineering / Distribution / Backlog and appends source Slack thread link + request ID.

### Existing Agent Run Card MVP

- `apps/pi-mom/README.md:144-151` documents the current `agent:` route: posts a Block Kit confirmation card with Start/Cancel; feature flag `PI_MOM_AGENT_ROUTE_ENABLED=false`; runner modes `fake`, `repo-health`; run state JSON metadata only; optional Canvas creation; keep `PI_MOM_ALLOW_PI_TOOLS=false`.
- `apps/pi-mom/lib/agent-run-card.mjs:50-91` builds the confirmation card with fields, source link, prompt preview, safety context, Start Run and Cancel buttons.
- `apps/pi-mom/lib/agent-run-card.mjs:94-109` builds update cards with recent events, result/error, and optional Canvas link.
- `apps/pi-mom/lib/agent-runners.mjs:4-15` defines fixed repo-health commands and runner modes `fake`, `repo-health`, `supervised-pi`.
- `apps/pi-mom/lib/agent-runners.mjs:27-52` redacts token-like output and scrubs secret-bearing environment variables.
- `apps/pi-mom/lib/agent-runners.mjs:69-80` fake runner is a deterministic no-tool smoke.
- `apps/pi-mom/lib/agent-runners.mjs:117-130` supervised-pi runner is explicitly not wired yet.
- `apps/pi-mom/lib/agent-runners.mjs:132-158` repo-health runs fixed commands with shell disabled, scrubbed env, timeouts, and capped output.

### Profiles and agents available

- `agent-kits/profiles/covent-speed-operator.yaml:1-14` is the high-agency trusted internal profile with read/grep/find/ls/bash/edit/write/mcp/web_search and external mutation allowed under explicit Slack invocation; env-guard and git-checkpoint remain enabled.
- `agent-kits/profiles/repo-writer.yaml:1-11` is a safer bounded local writer: shell + writes allowed, external mutation false, approval for push/deploy/external mutation.
- `agent-kits/profiles/slack-safe.yaml:1-11` is read/summarize only, no external mutation.
- `agents/test-writer.md` defines a focused test strategy agent that reports existing test framework/commands, cases, fixtures/mocks, files, and smallest verification command; it only writes code if explicitly delegated with write tools.
- `skills/repo-worker/SKILL.md` describes bounded repo change workflow: collect evidence, edit with assigned tools, validate with narrow checks, return actions/validation/risks/next step.
- There is no generic `reviewer` agent yet; closest local patterns are `frontend-polish.md`, `salesforce-reviewer.md`, `linear-auditor.md`, and `linear-subissue-auditor.md`.

### Architecture direction already decided

- `docs/specs/pr-closure-and-pi-mom-mvp-plan.md:9-23` says the core product surface is Slack and the core leverage is explicit, observable loops: Slack trigger → deterministic route → bounded context → visible progress/card → approval/action → artifact/source link. It explicitly prefers explicit routes, Block Kit cards/buttons/modals, bounded runner presets, `.mjs` modular seams, and one architectural direction.
- `docs/specs/pr-closure-and-pi-mom-mvp-plan.md:55-67` says replace the broad TypeScript modularity PR with smaller `.mjs` seams and keep Agent Run Card as the first Slack interactivity MVP.
- `docs/specs/pr-closure-and-pi-mom-mvp-plan.md:85-121` proposes the target pi-mom shape: boot-only `index.mjs`, `lib/config`, `domain/*`, adapters, route modules, interaction modules, and `agent-runs/*`.
- `docs/specs/pr-closure-and-pi-mom-mvp-plan.md:69-83` says private DM and insights routes should be reworked/decomposed and not added as passive/default hidden surfaces.

### Slack UX primitives to reuse

Local repo already uses Slack Socket Mode, app mentions, slash command, threaded replies, Block Kit buttons, interactivity actions, streaming chat APIs, file upload/download for image route, and optional Canvas creation.

External Slack docs confirm these are appropriate primitives:

- Slack surfaces include messages, modals, App Home, and Canvases; Block Kit works across messages, modals, and Home tabs, while Canvases use markdown-like document content. Source: https://docs.slack.dev/surfaces and https://docs.slack.dev/block-kit/
- Block Kit supports interactive elements like buttons and menus; apps should handle interactions promptly. Source: https://docs.slack.dev/block-kit/
- Bolt action/command/view handlers must `ack()` promptly; Slack recommends acknowledging immediately because apps have 3 seconds to respond. Source: https://docs.slack.dev/tools/bolt-js/concepts/acknowledge
- Bolt Socket Mode with `socketMode: true` and an app-level token is the current official model for receiving events over WebSocket. Source: https://docs.slack.dev/bolt-js/concepts/socket-mode
- `canvases.create` can create standalone canvases with title and `document_content`, and can be channel-tabbed with `channel_id`; bot/user token needs `canvases:write`. Source: https://docs.slack.dev/reference/methods/canvases.create

## Workflow ranking

Scoring: 5 = best/highest for team value or polish; 1 = lowest. Complexity: 1 = easy, 5 = hard. Reuse: 5 = high reuse of current setup.

| Rank | Workflow | Team value | Perceived polish | Impl. complexity | Reuse existing setup | Why this rank |
|---:|---|---:|---:|---:|---:|---|
| 1 | Thread-to-Linear issue | 5 | 4 | 2 | 5 | Core loop is live and verified; directly moves Slack ambiguity into Linear truth. Biggest missing pieces are idempotency, metadata, and optional preview/modal. |
| 2 | Thread-to-spec / PRD | 5 | 3 | 1 | 5 | Already supported as primary UX; lowest-risk visible win. Can polish with Block Kit summary card/source links without new external writes. |
| 3 | Run repo-worker/test-writer/reviewer from Slack | 5 | 5 | 4 | 4 | Agent Run Card proves confirmation + state + buttons. Needs preset registry, profile binding, runner wiring, output artifacts, and safeguards before write-capable agents. |
| 4 | Daily context prime | 4 | 4 | 3 | 4 | High leverage for reducing repeated context. Reuses Slack/Linear/Git/docs context-primer skills, but needs careful source-linking and privacy boundaries. |
| 5 | PR cleanup concierge | 4 | 4 | 3 | 3 | Strong operational value. Best as a Slack card/checklist/report first; write/merge actions should stay gated. Depends on GitHub tooling/profile decisions not fully shown in current pi-mom code. |
| 6 | Smoke tests from Slack | 4 | 5 | 2 | 5 | Easy polished demo using existing Agent Run Card + fixed runner presets. Low risk if it runs fixed non-secret checks only. |
| 7 | Create agent profile from Slack/CLI | 3 | 5 | 5 | 3 | Strategically reusable but high policy/schema risk. Better after route/profile registry and validation are stable. |
| 8 | Thread-to-Linear subissue/comment/update variants | 4 | 3 | 3 | 4 | Natural extension of Linear route, but should wait for duplicate guard and richer target metadata. |
| 9 | Private DM loop | 3 | 4 | 3 | 2 | Useful but current plan says rework with strict feature flag/user allowlist; lower priority than explicit thread routes. |
| 10 | Passive insights/channel analyzer | 3 | 3 | 5 | 2 | Docs explicitly warn against passive listeners before routing/cost/privacy/concurrency controls. |

## Workflow-by-workflow map

### 1. Thread-to-spec / PRD

**User/team job:** Turn a messy Slack thread into a concise implementation-ready spec without copying a URL or rewriting context.

**Current UX primitive:** In-thread app mention: `@Covent Pi draft spec`. Fallback slash command: `/thread-spec <Slack message/thread URL> [optional focus]`.

**Pi/profile primitive:** Restricted Pi subprocess by default (`--no-session --no-tools --no-extensions` unless explicitly enabled). Route profile is `spec` with current thread text context.

**Current implementation:**

- Natural intent parser detects `draft/write/create spec/prd/product requirements` (`apps/pi-mom/index.mjs:166-188`).
- Requires app mention in a thread; otherwise replies with usage hint (`apps/pi-mom/index.mjs:973-980`).
- Pulls capped thread context and builds a Pi prompt (`apps/pi-mom/index.mjs:1033-1047`).
- Streams or posts the result into Slack (`apps/pi-mom/index.mjs:1049-1082`).

**Recommended next polish:**

- Wrap output in a Block Kit “Spec draft” card: problem, proposed solution, AC, risks, validation, open questions.
- Add buttons: `Create Linear issue`, `Copy as markdown`/`Open Canvas` (if useful), `Regenerate with focus`.
- Keep the existing plain text fallback for reliability.

**Risks/gaps:** Thread context is capped at 12 messages, text-only, no files/canvases. Do not imply full-thread/document comprehension until pagination/media support lands.

### 2. Thread-to-Linear

**User/team job:** Promote a Slack thread into durable Linear execution truth with source link and request ID.

**Current UX primitive:** In-thread app mention `@Covent Pi create Linear issue` or prefix `linear:`.

**Pi/profile primitive:** Linear route: Pi drafts issue text; bridge-owned Linear GraphQL performs issue creation. Explicit Slack invocation is approval for this route.

**Current implementation:**

- Natural intent parser detects create/file/open/make issue/ticket (`apps/pi-mom/index.mjs:190-205`).
- Route instruction requires first line `Title: ...` (`apps/pi-mom/index.mjs:86-89`).
- Bridge creates issue after Pi output and posts link (`apps/pi-mom/index.mjs:1052-1069`, `1083-1100`).
- Defaults to Frontend Engineering / Distribution / Backlog (`docs/AGENT_CONTEXT.md:124-143`, `apps/pi-mom/README.md:165-170`).

**Recommended next polish:**

- P0: duplicate guard before `createLinearIssueFromPiOutput()` by scanning current thread for prior `Created Linear issue <linear link|FE-...>` confirmation. This directly addresses `docs/SYSTEM_INDEX.md:163`.
- P0/P1: optional Block Kit preview card or modal only if it does not slow speed mode. In speed mode, explicit command can still create directly; preview can be an alternate `linear preview:` route.
- P1: map labels/priority/assignee/parent when prompt output or Slack command supplies unambiguous values.
- P1: attach/source-link Slack permalink, request ID, and route/profile metadata consistently.

**Risks/gaps:** Non-idempotent today; Linear metadata is basic; no thread pagination/media. Modal preview increases polish but also friction.

### 3. Run repo-worker / test-writer / reviewer

**User/team job:** From Slack, launch bounded implementation/test/review work with visible confirmation, progress, cancel, and result artifacts.

**Current UX primitive:** `@Covent Pi agent: <bounded task>` posts a Block Kit card with Start/Cancel buttons.

**Pi/profile primitive:** Should become a preset registry mapping Slack-visible runner choices to declared profiles/skills, e.g.:

- `repo-health` → fixed no-write diagnostics (already exists).
- `test-writer-plan` → `test-writer` agent in read-only strategy mode.
- `repo-worker` → `repo-writer` or `covent-speed-operator` profile, but only after explicit profile policy and workspace constraints.
- `reviewer` → add a generic code reviewer profile/agent or repurpose focused reviewers where applicable.

**Current implementation:** Agent Run Card exists with pending/running/succeeded/failed/canceled states, Start/Cancel actions, fake/repo-health/supervised-pi modes, JSON run store, and optional Canvas.

**Recommended next polish:**

- Keep `agent:` as a card-first flow; add a typed request shape: `agent: repo-health`, `agent: test-writer <scope>`, `agent: review <PR/branch>`, `agent: repo-worker <Linear/branch/task>`.
- Add a runner preset registry instead of free-form prompt-to-shell.
- For write-capable repo-worker, create isolated worktree/workspace, git checkpoint, run checks, return diff/branch/PR draft; do not push/deploy unless profile permits or user explicitly requests.
- Emit result as Slack card + optional Canvas + Linear/GitHub links.

**Risks/gaps:** `supervised-pi` is not wired. Current `parseAgentRequest()` accepts any prompt. Index monolith needs modular seams before growing more interaction handlers. No generic reviewer agent exists yet.

### 4. Create agent profile from Slack/CLI

**User/team job:** Quickly codify a recurring workflow into a reusable Pi profile/route without editing YAML by hand.

**Slack UX primitive:** Best as modal or guided card, not plain text only:

- `@Covent Pi profile: create` opens a modal with name, purpose, inputs, allowed context/tools/mutations, outputs, validation, kill switch.
- CLI alternative: `npm run agent:new` already exists at root (`package.json`) and can scaffold local agent definitions.

**Pi/profile primitive:** Generates YAML under `agent-kits/profiles/` or agent markdown under `agents/`, validated by `npm run validate:agents` / `npm run check`.

**Recommended stage:** Later. First define a strict schema and validation around `BOUNDARY.md:30-44` route/profile policy. The profile generator should default conservative and require explicit fields for external mutation, browser access, and secret-bearing contexts.

**Risks/gaps:** High risk of minting overbroad authority. Needs schema tests and safe defaults before exposing in Slack.

### 5. PR cleanup concierge

**User/team job:** Turn open PR mess into a ranked cleanup plan: merge/close/rework, validation commands, risk notes, and source-linked status.

**Current evidence:** `docs/specs/pr-closure-and-pi-mom-mvp-plan.md` and `merge-pr1-pr3-report.md` show this workflow has already happened manually and is valuable.

**Slack UX primitive:** `@Covent Pi pr-cleanup: <repo/branch/PR list>` → card with PR statuses and recommended actions. Buttons: `Refresh checks`, `Draft Linear update`, `Run repo health`, `Create cleanup issue`. Avoid `Merge` button until GitHub auth/approval policy is explicit.

**Pi/profile primitive:** Start read-only with GitHub/Git/Linear context; later allow route/profile-approved GitHub actions. Use repo-worker only for local validation and report generation initially.

**Recommended next polish:**

- Implement as an agent-run preset that runs fixed GitHub/gh/git queries and `npm run check` where possible.
- Output a concise decision table similar to `docs/specs/pr-closure-and-pi-mom-mvp-plan.md:25-83`.
- Link results to Linear or Slack thread; do not auto-merge by default.

**Risks/gaps:** Current code does not show GitHub API integration in pi-mom. Shell/GitHub actions need route/profile declaration and token redaction.

### 6. Daily context prime

**User/team job:** Start each day with a compact, source-linked map of what changed, what matters, blockers, and next actions.

**Slack UX primitive:** Scheduled or manual `@Covent Pi daily prime`/`digest:`. Best delivery is a Slack message card with sections and links; optional Canvas for longer context.

**Pi/profile primitive:** `pi-slack-contextprime`, `covent-project-context-primer`, `linear-covent`, and repo docs. Could run under `slack-safe`/read-only first; speed-operator only if it writes Linear/docs.

**Recommended next polish:**

- Start manual, not scheduled: `digest: daily context prime for FE-460 / Covent Agent OS`.
- Inputs: recent Linear issues/comments, repo docs changed, open PR statuses, selected Slack threads by permalink/channel scope.
- Output: 5-bullet exec summary, decisions, blockers, today’s top 3, stale/ambiguous items, source links.
- Later add scheduled route once scope, privacy, and duplicate-output behavior are clear.

**Risks/gaps:** Broad Slack/Linear reads can become noisy/private. Must prefer summaries + source links, not raw dumps. Needs source selection controls.

### 7. Smoke tests

**User/team job:** Prove Slack/Pi/Linear/repo routes work from the cockpit without SSHing into the box.

**Current UX primitive:** `@Covent Pi status:`, `@Covent Pi agent: repo health smoke test`, Start/Cancel card.

**Pi/profile primitive:** Fixed runner presets only. No arbitrary shell. Current `repo-health` is a good base.

**Recommended next polish:**

- Add named presets: `smoke: bridge`, `smoke: routes`, `smoke: linear-config`, `smoke: repo-health`.
- Use cards with green/yellow/red result rows and request ID.
- Keep checks offline/non-secret where possible. Linear smoke should have a dry-run mode unless explicitly asked to create a test issue.

**Risks/gaps:** Avoid duplicate Socket Mode workers. Doctor may contact Slack and requires env but must not print secrets.

## Suggested implementation slices

### Slice A — Linear idempotency + route helper tests

**Value:** Highest. Prevents the most obvious production footgun.  
**Scope:** Extract pure route/redaction/thread helpers if needed, add tests, add duplicate guard before Linear create.

Acceptance:

- `linear:` skips creation and replies with the existing Linear link when prior success confirmation exists in the same thread.
- Draft/failure/no-key messages do not block creation.
- Tests run via `npm --prefix apps/pi-mom run check` and root `npm run check`.

### Slice B — Spec/Linear Slack polish card

**Value:** High polish, low risk.  
**Scope:** Add pure Block Kit builders for spec/Linear result cards; preserve plain text fallback.

Acceptance:

- `@Covent Pi draft spec` still works in a thread.
- Output includes route label, source thread link/request ID, and structured sections.
- No new external mutations.

### Slice C — Modularize Agent Run Card into route/interactions/agent-runs

**Value:** Enables future agent workflows safely.  
**Scope:** Follow `docs/specs/pr-closure-and-pi-mom-mvp-plan.md:85-121` using `.mjs`, not TypeScript migration.

Acceptance:

- Behavior unchanged for help/status/plain Pi/image/linear/slash command/agent card.
- `index.mjs` becomes boot/registration/orchestration, with route and interaction handlers in modules.
- Existing `test-agent-run-card.mjs` passes after import path updates.

### Slice D — Runner preset registry for smoke/test-writer/review

**Value:** High.  
**Scope:** Add typed preset names and cards; keep execution read-only or fake unless profile policy is approved.

Acceptance:

- `agent: repo-health` and `smoke: repo-health` are equivalent or clearly linked.
- `agent: test-writer <scope>` initially returns a test plan, not code edits, unless the selected profile explicitly allows writes.
- Unknown presets produce a helpful menu, not free-form shell/Pi execution.

### Slice E — Daily context prime MVP

**Value:** Medium-high after A-D.  
**Scope:** Manual digest route with bounded source inputs and source-link-first output.

Acceptance:

- Manual invocation only.
- Requires explicit target scope (`thread`, `Linear issue`, `project`, or `repo docs changed since`).
- Output contains source links and no raw private dumps.

## Implementation constraints / risks

- Do not broaden Slack authority into passive listeners. `docs/specs/pr-closure-and-pi-mom-mvp-plan.md:17-23` and `BOUNDARY.md:44` both favor explicit routes over ambient permissions.
- Keep normal Pi subprocess routes no-tools/no-extensions by default (`apps/pi-mom/index.mjs:737-738`, `apps/pi-mom/README.md:238-239`).
- Do not add arbitrary prompt-to-shell from Slack. Current repo-health is fixed-command, shell-false, scrubbed-env; preserve that pattern.
- Avoid full TypeScript migration in the same PR as workflow features; local docs explicitly recommend `.mjs` modular seams first.
- Treat Slack/Linear content as data, not instructions; never export raw private Slack/Linear content without explicit approval.
- No production deploy/merge/push from an implementation agent unless explicitly requested and profile-allowed.

## Validation path

General validation from repo root:

```bash
npm run secret-scan
npm run check
npm run doctor:pi-mom   # may require local env; must not print secret values
```

Targeted app validation:

```bash
npm --prefix apps/pi-mom run check
node apps/pi-mom/test-agent-run-card.mjs
```

Manual Slack smoke, only when a single worker is intentionally active:

```text
@Covent Pi status:
@Covent Pi draft spec
@Covent Pi create Linear issue   # only in an approved test thread
@Covent Pi agent: repo health smoke test
```

## Compact meta-prompt for a future implementation agent

You are implementing the next Covent Agent OS Slack workflow slice. Work in `/home/jfloyd/covent-agent-os`. Read `BOUNDARY.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `apps/pi-mom/README.md`, and `docs/specs/pr-closure-and-pi-mom-mvp-plan.md` before editing. Current product direction: explicit Slack routes, route/profile authorization, Block Kit cards/buttons/modals as thin UI, bounded runner presets, `.mjs` modular seams, no passive listeners, no arbitrary prompt-to-shell.

Goal: implement the highest-value safe slice: add a duplicate guard and tests for Slack thread → Linear issue creation, then optionally polish spec/Linear result cards if scope allows. Preserve existing behavior for `help`, `status`, plain Pi, `image:`, `/thread-spec`, and `agent:`. Do not migrate pi-mom to TypeScript. Do not broaden Slack scopes or enable Pi tools by default.

Key evidence: Linear route is parsed in `apps/pi-mom/index.mjs:190-205`; thread context fetch is `getThreadMessages/getThreadContext` at `apps/pi-mom/index.mjs:295-309`; Linear creation happens after Pi output at `apps/pi-mom/index.mjs:1052-1069` and `1083-1100`; current limitation says Linear creation is not idempotent in `docs/SYSTEM_INDEX.md:160-164`. Agent Run Card code exists in `apps/pi-mom/lib/agent-run-card.mjs` and `apps/pi-mom/lib/agent-runners.mjs`; do not expand it into write-capable execution unless explicitly asked.

Success criteria: `linear:` / `@Covent Pi create Linear issue` skips creation when the same thread already contains a prior clear `Created Linear issue` confirmation with a Linear URL/key, replies with the existing link, and does not call Linear. Drafts, failures, and missing-key notices must not block creation. Add offline unit tests for duplicate detection and any extracted parsing/redaction helpers. `npm --prefix apps/pi-mom run check` and root `npm run check` pass. No secrets, raw Slack exports, logs, generated images, or runtime state are committed.

Validation: run `npm run secret-scan`, `npm --prefix apps/pi-mom run check`, and `npm run check`. If `doctor:pi-mom` is run, summarize readiness without printing secret values. Manual Slack tests require confirming there is not a duplicate Railway/local/EC2 Socket Mode worker.

Stop/escalate: ask before deploying, pushing, merging, changing Slack manifest/scopes, enabling Pi tools for Slack routes, creating real Linear issues outside an approved test thread, or implementing write-capable repo-worker/profile creation. Stop if requirements imply passive Slack monitoring, raw private exports, or destructive external mutations without an explicit declared route/profile.
