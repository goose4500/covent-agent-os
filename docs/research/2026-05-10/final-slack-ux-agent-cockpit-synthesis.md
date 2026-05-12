# Final synthesis: Slack UX agent cockpit

## Inherited decisions

- Slack is the cockpit and route selector, not the durable system of record. Linear, Git/GitHub, repo docs, and runtime state remain the durable truths.
- The approved architecture direction is explicit Slack route/profile invocation → bounded context → visible progress/card → route/profile-authorized action → source-linked artifact.
- Favor small `.mjs` seams in `apps/pi-mom` over TypeScript migration or platform rewrites.
- Keep the current pi-mom behavior stable while extracting seams; preserve `help`, `status`, app mentions, DMs, `/thread-spec`, `image:`, `linear:`, and existing `agent:` card behavior.
- Agent Run Card is the first interactivity MVP, but execution must stay bounded to `fake` / fixed `repo-health`; `supervised-pi` is explicitly not wired.
- Broad Slack scopes already exist, but authority must be constrained in code by route/profile flags, channel allowlists, idempotency, redaction, logging, and revocability.
- Do not add passive Slack listeners, arbitrary prompt-to-shell, Slack-triggered repo writes, profile creation from Slack, deploy/push/merge buttons, or general workflow-builder infrastructure.
- Canvases are useful output/report surfaces later, not the live cockpit primitive. App Home is a phase-two dashboard, not MVP-critical.

## Diagnosis

The roadmap is directionally aligned on Slack Block Kit, route extraction, agent run cards, modals, and bounded smoke tests, but it still overbuilds relative to the fastest team value. It optimizes toward an agent cockpit/platform and profile factory before fixing the highest-risk live workflow: non-idempotent Slack thread → Linear issue creation.

The fastest high-value vertical slice is not modal launch, App Home, canvas, or profile factory. It is:

1. Add a duplicate guard for thread-to-Linear creation.
2. Add small pure tests around route/thread parsing and duplicate detection.
3. Optionally wrap the Linear/spec outputs in a source-linked Slack card if still in scope.

This slice directly improves the existing production loop, reduces a real footgun, needs no new Slack scopes or manifest changes, and creates the helper seams needed for later cockpit polish.

## Drift / contradiction check

- The implementation roadmap puts route catalog extraction and Agent Run Card polish first, while the workflow value map ranks Linear idempotency as the highest-value safe slice. That is a priority drift.
- PRs 3-7 move into modal launcher and profile factory work too soon. Those are useful later, but they increase surface area before the current Linear route is safe and before agent execution policy is settled.
- “Do not remove broad scopes” is acceptable operationally, but it must not become “broad scopes are safe.” The code boundary has to be least-authority by route even if the app token is over-scoped.
- Adding message shortcuts/modals requires manifest changes and new interaction handlers. That conflicts with the fastest vertical slice because it adds Slack app configuration risk without solving the current duplicate/external-mutation risk.
- Profile factory preview is explicitly default-off and no-write, but it still encourages platformization. It should wait until route/profile registry and validation are stable.
- Improving Agent Run Card copy is safe, but expanding it into repo-worker/test-writer/reviewer is not safe until a preset registry exists and write-capable execution is separately approved.

## First-principles challenge

Build the narrowest thing that turns Slack ambiguity into durable execution truth safely. That means:

- Prefer one existing route with one external mutation over new cockpit surfaces.
- Prefer deterministic guards and tests over UI breadth.
- Prefer fixed runner presets over arbitrary agent prompts.
- Prefer Slack cards/buttons for visibility only after the mutation semantics are safe.
- Prefer source links and request IDs over copying raw private Slack content into files or run state.

The cockpit should emerge as thin UI over route/profile contracts, not as a new platform layer.

## Recommended next implementation prompt

Use this as the next executor prompt:

> Work in `/home/jfloyd/covent-agent-os`. Implement the fastest safe Slack UX vertical slice: add idempotency/duplicate protection for Slack thread → Linear issue creation in `apps/pi-mom`, with offline tests. Read `BOUNDARY.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `apps/pi-mom/README.md`, and `docs/specs/pr-closure-and-pi-mom-mvp-plan.md` first. Preserve existing behavior for `help`, `status`, plain Pi, `image:`, `/thread-spec`, DMs, and `agent:`. Do not migrate to TypeScript, change Slack manifest/scopes, add modals/shortcuts, enable Pi tools, or wire `supervised-pi`.
>
> Add a pure helper that detects a prior successful Linear creation confirmation in the same Slack thread, such as a `Created Linear issue` message containing a Linear URL or key. Before calling `createLinearIssueFromPiOutput()`, scan the fetched thread messages for that prior success. If found, reply with the existing Linear reference and skip creating a new issue. Drafts, failure notices, missing-key notices, or unrelated Linear mentions must not block creation.
>
> Add unit tests for the duplicate detector and any extracted parsing helper. Ensure the Linear create function is not called on duplicate. Run `npm --prefix apps/pi-mom run check`; run broader `npm run check` and `npm run secret-scan` if feasible. Do not commit secrets, raw Slack exports, runtime state, or generated artifacts.
>
> Stop and ask before deploying, pushing, merging, changing Slack app configuration, creating real Linear issues outside an approved test thread, or adding write-capable agent execution.

## Suggested follow-on sequence

1. **Linear idempotency + tests** — highest value and lowest new surface area.
2. **Spec/Linear result card polish** — source-linked Block Kit output, no new external mutation.
3. **Agent Run Card modular extraction** — move existing card/actions/runners into `.mjs` seams without behavior change.
4. **Runner preset registry** — fixed `repo-health` / smoke-test presets first; no arbitrary shell or write-capable Pi.
5. **Modal/message shortcut launcher** — only after the same run creation path is stable.
6. **Manual daily context prime** — bounded sources, summaries plus links, no passive monitoring.
7. **Profile factory core/preview** — later, default-off, preview-only from Slack, validated CLI/library first.

## Safety/security risks to keep front and center

- Existing broad Slack scopes (`groups:history`, `im:*`, `files:*`, `canvases:*`, etc.) mean bugs can expose private data even if the intended route is narrow.
- Socket Mode duplicate workers can double-handle interactions and duplicate Linear creations unless idempotency is explicit.
- Slack messages/files/canvases are data, not instructions; never let Slack content override route/profile policy.
- Do not store raw private Slack text, secrets, tokens, prompt files, or unredacted tool output in JSON run state, docs, canvases, or logs.
- All interactive handlers must `ack()` within Slack’s 3-second window, then do work asynchronously.
- Keep `PI_MOM_ALLOW_PI_TOOLS=false` by default for Slack routes.
- Preserve fixed-command, `shell:false`, scrubbed-env runner design for repo-health/smoke tests.

## Simplest architecture boundary for future agents

Define a future agent as a route/profile-bound preset, not a free-form Slack prompt:

- **Route**: trigger shape, allowed Slack context, output target, idempotency key, kill switch.
- **Profile**: allowed tools, allowed mutations, approval requirements, redaction/audit rules.
- **Runner preset**: fixed or typed execution path; no arbitrary prompt-to-shell.
- **UI**: Slack card/modal/button as thin state/control surface over the route, not the authority source.
- **Artifact**: Linear issue, Git diff/branch, repo doc, Slack card, or Canvas report with source links.

No executor handoff is warranted beyond the concrete implementation prompt above.
