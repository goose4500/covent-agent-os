# PR audit memo: pi-mom modularity, TypeScript, Agent Run Card

Date: 2026-05-10  
Scope: GitHub PR #6 (`claude/refactor-app-modularity-FcmE5`) plus local branch `feat/pi-mom-agent-run-card`.

## Decision

Restart smaller from current `main`/Agent Run Card work; do not merge PR #6 as-is.

Keep the good idea from PR #6: split pi-mom into small, dependency-injected modules. Do **not** take the big `.mjs -> .ts` migration in the same change. It creates CI failures, merge conflicts with the Agent Run Card branch, and does not yet improve correctness enough to justify the blast radius.

Recommended order:

1. Land a minimal `.mjs` modularity slice that introduces the stable seams needed by Block Kit/actions/agent runs.
2. Integrate Agent Run Card as one route + two Slack action handlers using those seams.
3. Add small tests around cards/store/runners/command routing.
4. Migrate to TypeScript later, module-by-module, after behavior is stable.

## Findings

### PR #6

What is good:

- Extracts env parsing into `lib/config`.
- Extracts pure command/redaction/format/prompt modules.
- Introduces adapter factories for Slack, Linear, and Pi runner.
- Introduces an enriched route registry with `handle(ctx)` and `postProcess(ctx, result)` hooks.
- This is directionally right for image, Linear, and future agent routes.

Problems:

- CI is failing in `npm run typecheck`, not runtime syntax. Key errors are weak/narrow TS modeling: `Command` discriminated union used without narrowing, Slack event shapes missing properties, stream args inferred too narrowly, OpenAI image option objects inferred too narrowly.
- PR renames the entire pi-mom app to `.ts`, adds `allowImportingTsExtensions`, and relies on Node strip-types. That is a broad runtime/tooling change for a worker that currently deploys as plain Node ESM.
- It conflicts conceptually and textually with the local Agent Run Card branch: both heavily modify `apps/pi-mom/index.mjs`; PR #6 deletes/renames that file while Agent Run Card adds route/action logic to it.
- PR #6 modularity is not quite the architecture needed for Block Kit/buttons yet: route handlers are separated, but Slack interactivity handlers (`app.action`) still need an explicit place to live.

CI evidence:

- `apps/pi-mom/index.ts`: missing `Command` property narrowing (`text`, `routeKey`, `requiresThread`, etc.).
- `apps/pi-mom/lib/adapters/*`: Slack stream arg/event/object types too narrow.
- `apps/pi-mom/lib/openai-image-client.ts`: options object inferred as too narrow.

These are fixable, but fixing them means continuing a large TS migration while also trying to merge Agent Run Card. That is not the simplest path.

### Local Agent Run Card branch

What is good:

- MVP behavior is bounded and safety-oriented: `fake` and `repo-health` modes only; no shell; scrubbed env; timeouts; output caps; route kill switch.
- Block Kit card is simple and clear: Start + Cancel buttons with confirms.
- Local check passes: `npm --prefix apps/pi-mom run check` and `test-agent-run-card.mjs` pass.
- The JSON run store is adequate for MVP metadata.

Problems:

- It adds a substantial new feature directly into the 1,300-line monolith.
- It creates a second redaction implementation in `agent-runners.mjs` instead of sharing one canonical redactor.
- `parseAgentRequest()` currently accepts anything; for MVP this is okay only because runners are fixed, but future agent loops need a typed request shape.
- Slack action handlers live inline in `index.mjs`; this will not scale to modals, buttons, and multiple interactive surfaces.
- `repo-health` is not really an extensible agent loop yet; it is a fixed command checklist. That is fine for the first slice, but name it as a runner preset, not the final abstraction.

## Architecture we should actually implement

Use plain ESM `.mjs` now. Keep TypeScript out of the first merge.

Target repo layout:

```text
apps/pi-mom/
  index.mjs                 # boot only: load config, create app, register modules, start
  lib/
    config.mjs              # loadConfig(env), frozen config
    trace.mjs               # createTrace(config)
    domain/
      commands.mjs          # parse commands/intents
      routes.mjs            # pure route metadata
      prompt.mjs
      redact.mjs
      slack-format.mjs
      linear-payload.mjs
    adapters/
      slack.mjs             # Slack Web API helpers, stream args, image upload/download
      linear.mjs
      pi-runner.mjs
    routes/
      index.mjs             # register message routes
      image.mjs             # route.handle(ctx)
      linear.mjs            # route.postProcess(ctx, result)
      agent.mjs             # route.handle(ctx) posts run card
    interactions/
      index.mjs             # register app.action/app.view handlers
      agent-run-actions.mjs # start/cancel button handlers
    agent-runs/
      card.mjs              # Block Kit builders only
      store.mjs             # JSON metadata persistence
      runners.mjs           # fake/repo-health runner registry
      canvas.mjs            # optional Slack Canvas publishing
      types.mjs             # optional JSDoc typedefs/shared shapes, no runtime weight
```

Principles:

- `index.mjs` owns Bolt boot and registration only.
- Route modules own Slack message/app-mention workflows.
- Interaction modules own `app.action` and future `app.view` handlers.
- Block Kit builders are pure functions and tested separately.
- Runners are behind a tiny interface: `run({ run, signal, onEvent }) -> result`.
- State transitions are explicit and centralized enough to test; route/action handlers should not hand-roll many patches long term.
- Config is passed into factories; avoid free `process.env` reads outside config/adapters.
- Keep all Slack-posting through handlers/adapters; do not let agent runners post to Slack directly.

This gives simple extension points for:

- more Block Kit cards: add a pure builder + interaction handler;
- modals: add `app.view` registration in `interactions/`;
- new agent loops: add a runner preset under `agent-runs/runners.mjs` or `agent-runs/runners/<name>.mjs`;
- new Slack command routes: add route metadata + route module.

## Fix PR #6 or restart?

Recommendation: restart smaller.

Do not close the ideas; close/replace the PR implementation. The exact PR #6 code can be mined for extraction boundaries, but the next PR should be `.mjs` and smaller.

Why:

- Current branch already has working Agent Run Card tests.
- PR #6 fails CI and its TypeScript migration adds non-product risk.
- A small `.mjs` modularity PR can merge quickly and provide the right seam for Agent Run Card.
- TypeScript can be done later with much lower risk after modules have stable boundaries. If TypeScript is desired, prefer a dedicated PR that first adds JSDoc/checkJs or types only pure modules, then adapters, then boot.

## Exact first implementation slice

First PR title: `refactor(pi-mom): add modular route and interaction seams`

Files to add/extract, in order:

1. `lib/config.mjs`
   - Move env parsing/constants there.
   - Include existing Agent Run Card env vars if working from local branch.
   - Export `loadConfig()`.

2. `lib/domain/redact.mjs`, `commands.mjs`, `routes.mjs`, `slack-format.mjs`
   - Move pure functions only.
   - Add `agent` to the route metadata table.
   - Keep current behavior identical.

3. `lib/trace.mjs`
   - `createTrace(config)`.

4. `lib/adapters/slack.mjs`, `linear.mjs`, `pi-runner.mjs`
   - Move I/O helpers behind factories.
   - Preserve current function names and behavior.

5. `lib/routes/index.mjs`
   - `createRoutes(deps)` returning enriched routes.
   - Register `image.handle`, `linear.postProcess`, and `agent.handle`.

6. `lib/routes/agent.mjs`
   - Move only the app-mention/message side of Agent Run Card: parse `agent:`, create run, post card.

7. `lib/interactions/index.mjs` and `lib/interactions/agent-run-actions.mjs`
   - Export `registerInteractions(app, deps)`.
   - Move `agent_run_start` and `agent_run_cancel` out of `index.mjs`.

8. Move current Agent Run Card libs to:
   - `lib/agent-runs/card.mjs`
   - `lib/agent-runs/store.mjs`
   - `lib/agent-runs/runners.mjs`
   - `lib/agent-runs/canvas.mjs`

Acceptance criteria for first slice:

- `npm --prefix apps/pi-mom run check` passes.
- Existing `test-agent-run-card.mjs` passes after import path updates.
- `index.mjs` is reduced to boot/preflight/registration plus `handleRequest` orchestration; target under ~450 lines.
- No `.ts` rename and no root `tsconfig` change.
- Behavior unchanged for `help`, `status`, plain Pi, image, Linear, slash command, and Agent Run Card.

## Minimal integration plan for Agent Run Card

After first slice, Agent Run Card should plug in as:

- `routes/agent.mjs`: creates pending run and posts `buildAgentRunCard(run)`.
- `interactions/agent-run-actions.mjs`: starts/cancels run, updates card, writes store.
- `agent-runs/runners.mjs`: keeps `fake` and `repo-health` only.
- Optional Canvas stays best-effort in `agent-runs/canvas.mjs`.

Do not add arbitrary prompt-to-shell execution. The next extensible loop should still be a registered runner preset, not dynamic commands from Slack.

## Later TypeScript migration

When ready, do a separate TypeScript PR with one of these safer paths:

- Path A: keep `.mjs`, add JSDoc typedefs and `// @ts-check` to pure modules first.
- Path B: migrate only pure `domain/` modules to `.ts`, compile/check them, then adapters later.
- Path C: full Node strip-types migration only after CI and Railway Node versions are pinned to `>=22.6` and Slack/OpenAI option types are intentionally modeled.

Do not combine full `.ts` migration with feature work or architecture movement.
