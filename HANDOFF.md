# HANDOFF — 2026-05-12 audit cohort + PR #33

**Audience**: AI agents (and humans) analyzing [PR #33](https://github.com/goose4500/covent-agent-os/pull/33) or picking up one of the six follow-up issues it spawned (#27–#32). Read this first; it's the smallest viable context to act correctly.

**Scope of this file**: this handoff is specifically for the 2026-05-12 audit cohort. Future handoffs can overwrite this file; treat it as the *current* handoff, not a historical archive. The historical record lives in `docs/research/2026-05-12/`.

## What you're looking at

PR #33 is a **docs-only artifact** of a single 24-hour audit window (2026-05-11 18:00Z → 2026-05-12 18:00Z, the foundation-v2 merge window). It adds 7 markdown files under `docs/research/2026-05-12/`, +782 insertions, **0 lines deleted, 0 code touched**. Bot behavior on `main` is identical with or without this PR merged. The PR exists to capture the audit + the resulting 6-issue follow-up cohort as one reviewable git artifact anchored to the foundation-v2 commit it audits.

## Why the audit happened

[PR #24 (foundation-v2)](https://github.com/goose4500/covent-agent-os/pull/24) merged on 2026-05-12 16:01Z and was the largest single change in repo history: 27 commits, 76 files, net **−4,616 LOC**. It replaced the subprocess `pi` bridge with the in-process `@earendil-works/pi-coding-agent@0.74` SDK on bun 1.3.11, added a Bolt 4.7 `Assistant` container, per-route tool gating from `apps/pi-mom/control-plane/registry.yaml`, `slack-sink.mjs` streaming via `chat.appendStream`, `canvas-sink.mjs` mirroring `spec:` runs into Slack canvases, `slack-ui-context.mjs` translating Pi `ExtensionUIContext` into Slack approval modals, an App Home cockpit, and three composable Linear custom tools. The rebuild works (live-canaried on `covent-pi-mom-v2`) — but velocity that high inevitably ships some defensive code carried over from the pre-rebuild era. This audit catalogues which of that defensive code is genuinely required workaround for SDK/platform gaps versus which is wheel-reinvention of behavior the platform already gives us.

## How the audit was produced

`bun install` + `bun run check` (green: secret-scan + validators + 13 pi-mom suites + `tsc --noEmit`) + `gitleaks` (clean). Then three first-principles audit agents ran in parallel against the actual SDK source under `node_modules/`:

- **Pi harness** (read `@earendil-works/pi-coding-agent@0.74` source): verdict *"Two unnecessary layers, one wasted env-var setter, two genuinely-required pieces — otherwise idiomatic."*
- **Slack surface** (read `@slack/bolt@^4.6` + `@slack/web-api@^7.15.2` source): verdict *"Two layers we can collapse, one true bug (double-DM), the rest is idiomatic for the platform's missing pieces."*
- **Block Kit / UX** (read `@slack/types`, `@slack/bolt` Assistant container, `slack-ui-context.mjs`, `home-view.mjs`): verdict *"Under-using Block Kit on streaming + Home; one framework switch worth making, two not worth making."*

Findings were synthesized into 6 PR-execution-sized issue specs, mirrored to GitHub issues with type labels.

## The 6 issues this PR spawned

| # | Title | Label | Risk | Depends on |
|---|---|---|---|---|
| #27 | Pi harness cleanup: drop double-wired SDK options and dead defensive code | `cleanup` | Low | — |
| #28 | Slack surface cleanup: drop SDK-duplicate timers, monkey-patches, redundant filters | `cleanup` | Low | — |
| #29 | Block Kit UX: actionable App Home cockpit + final-message actions row + tiny internal DSL | `ux` | Medium | — |
| #30 | Operational hygiene: secret rotation, hardcoded IDs, duplicate agent file | `operational` | Variable | — |
| #31 | Decisions: plain-route blast radius, retire /thread-spec, dependabot triage | `decision` | n/a | — |
| #32 | Shared Pi execution host (EC2) vs covent-aws-operator as a bounded tool | `decision` | n/a | **hard-blocked on #31** |

Suggested execution order: **#27 → #28 → #31 → #30 → #29 → #32**. The two `cleanup` issues are pure no-behavior-change wins and unblock everything else; #31 needs human input (no autoland); #32 is hard-blocked on #31 because widening execution-host blast radius before tightening the plain-route gate would amplify risk in the wrong direction.

## What NOT to do in this PR (or while picking up an issue)

- **Do not implement any sub-task in this PR.** PR #33 is research + specification only. Each issue gets its own implementation PR.
- **Do not assume `main` reflects PR #33's content.** Read from `apps/pi-mom/`, `extensions/`, `packages/` — that's the actual code surface. The audit + spec files describe what should change; they aren't authoritative for what currently *is*.
- **Do not use this HANDOFF.md as the sole source of file:line citations.** Each issue spec under `docs/research/2026-05-12/issues/` has its own citations against the SDK and our code; those are the authoritative pointers for whichever issue you're working on.
- **Do not skip `bun install --frozen-lockfile`.** Several specs cite SDK source paths under `node_modules/`; without an install, those paths don't exist and CI's `tsc --noEmit` will fail loudly.
- **Do not implement #32 (shared EC2 host) without #31 closed first.** This dependency is repeated in #32's spec twice; respect it.

## Pointers

- **24h audit report**: `docs/research/2026-05-12/audit-24h.md` — activity stats, PR landscape, code-quality notes, security review, CI shape, concrete follow-ups.
- **Issue specs**: `docs/research/2026-05-12/issues/01-pi-harness-cleanup.md` through `06-shared-execution-host.md`.
- **Foundation-v2 merge being audited**: PR #24, merge commit `1ab169c`.
- **Bot code surface**: `apps/pi-mom/` (index.mjs, lib/, control-plane/registry.yaml), `extensions/` (linear-tools.ts, permission-gate.ts, et al.), `packages/pi-ext-covent-aws/` (scaffolded, not wired).
- **SDK source (after `bun install`)**: `node_modules/@earendil-works/pi-coding-agent/dist/core/` for `sdk.{d.ts,js}`, `agent-session.{d.ts,js}`, `auth-storage.{d.ts,js}`, `extensions/types.d.ts`, `resource-loader.js`, `session-manager.d.ts`.
- **Bolt + web-api source (after `bun install`)**: `node_modules/@slack/bolt/dist/` (App.js, Assistant.js, context/create-say-stream.js, middleware/builtin.js); `node_modules/@slack/web-api/dist/` (chat-stream.js, types/request/canvas.d.ts).
- **Threat model**: `BOUNDARY.md` — where the #31 plain-route policy decision and the #32 execution-host policy decision are intended to land.
- **Local DX + runbooks**: `LOCAL_DX.md`, `docs/runbooks/`.
- **Repo README** (high-level intent): `README.md` — Covent Agent OS, Actions / Runs / Approvals / Artifacts mental model.

## State of the cohort at handoff time

- **Audit branch**: `claude/audit-codebase-24h-8oYNm`, head commit `c480108`, pushed to origin.
- **PR #33**: open as **draft**, 7 files / +782 / -0. Mergeable, conflict-free, docs-only.
- **Issues #27–#32**: open on GitHub with `cleanup` / `ux` / `operational` / `decision` labels (auto-created). No assignees, no milestones, no project board.
- **`main` (1ab169c)**: green. No regressions from the foundation-v2 merge as of audit time.
- **Live services**: `covent-pi-mom` (production, post-merge auto-deploy from `main`) and `covent-pi-mom-v2` (canary) both healthy. Both share the same Slack Socket Mode app token — see PR #24's body for the cutover note.
- **Outstanding from PR #24's body**: secret rotation (now tracked by #30); `covent-aws-operator` wiring (now scoped by #32).
