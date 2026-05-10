# Pi Mom Three-Phase Agent Execution Plan

Status: source-of-truth plan for the current Pi Mom packaging and validation sequence
Owner: Jake + Pi
Last updated: 2026-05-10

## Purpose

This document defines the current three-phase plan for turning the Pi Mom / Slack / Pi agent work into clean GitHub truth, proving the existing execution path in Slack, and only then building the richer Slack cockpit UX.

The plan intentionally separates GitHub packaging, operational smoke testing, and product UX expansion. Do not merge these concerns into one large PR.

## First-principles model

Covent Agent OS wins when a trusted internal teammate can express intent in Slack and reliably get bounded agent work completed with visible audit evidence.

```text
Slack intent
  -> declared route/profile
  -> Agent Run Card
  -> bounded Pi execution
  -> source-linked Slack result
  -> durable artifact in Linear/Git/docs when needed
```

The system should optimize for speed because Covent is a small trusted internal team. Safety should come from profile boundaries, fixed command construction, source links, redaction, logs, rollback, and kill switches — not from default refusal or passive approval loops.

## Current source-of-truth state

As of this plan:

- `origin/main` includes the Agent Run Card POC and Linear duplicate guard via PR #12.
- Local speed-mode foundation work exists as commit `38adad3`.
- Local supervised-pi PR spec exists as commit `4ca5fd2`.
- Local supervised-pi implementation exists as commit `2703807` on `feat/supervised-pi-runner`.
- No production Slack smoke test has proven the full current path yet.
- Slack shortcut/modal cockpit work is designed conceptually but not implemented.

## Phase 1 — Clean PR packaging

### Goal

Create clean reviewable GitHub PRs without merging anything and without disturbing other parallel agent branches/worktrees.

### Branch strategy

Use fresh branches from current `origin/main` or clean stacked branches.

Recommended stack:

1. `feat/pi-mom-speed-mode-foundation-v2`
   - base: `origin/main`
   - includes trusted internal speed-mode foundation and this plan doc
2. `feat/supervised-pi-runner-v2`
   - base: `feat/pi-mom-speed-mode-foundation-v2`
   - includes supervised-pi runner spec and implementation

### Phase 1 deliverables

- Clean local branches.
- Checks pass locally.
- Branches pushed to GitHub.
- PRs opened with detailed descriptions.
- No merges.

### Phase 1 acceptance criteria

- `git diff --check` passes on each branch.
- `npm --prefix apps/pi-mom run check` passes on each branch.
- `npm run check` passes on each branch.
- PR descriptions explain scope, non-goals, validation, and safety posture.
- Existing unrelated untracked reports/artifacts are not accidentally included.

### Non-goals

- Do not merge PRs.
- Do not close other agents' PRs.
- Do not rewrite unrelated active branches.
- Do not add shortcut/modal cockpit code.
- Do not perform EC2 deployment wiring.

## Phase 2 — Production Slack smoke test

### Goal

Prove the current Agent Run Card path works in a real or production-equivalent Slack environment before adding more UX.

This phase should test the existing path, not build new product surface.

### Required path to prove

```text
Slack request
  -> Pi Mom receives request
  -> Agent Run Card appears
  -> Start button works
  -> configured runner executes or fails gracefully
  -> result returns to Slack thread
  -> logs include request/run identifiers
  -> secrets are not leaked
  -> Cancel path works or fails safely
```

### Preferred test configuration

```text
PI_MOM_MODE=pi
PI_MOM_AGENT_ROUTE_ENABLED=true
PI_MOM_AGENT_RUNNER=supervised-pi
PI_MOM_ALLOW_ANY_CHANNEL=true
PI_MOM_ALLOW_PI_TOOLS=true
PI_MOM_SUPERVISED_PI_COMMAND=pi
PI_MOM_SUPERVISED_PI_PROFILE=covent-speed-operator
PI_MOM_SUPERVISED_PI_WORKDIR=/home/jfloyd/covent-agent-os
```

If production credentials or app runtime are unavailable, the smoke-test agent must produce a blocker report with exact missing prerequisites and the next command/action needed. Do not fake a pass.

### Safe smoke-test prompts

Use harmless prompts first:

```text
agent: inspect the repo and summarize current branch and git status. Do not edit files.
```

or:

```text
agent: run repo health only and summarize results. Do not change files.
```

### Phase 2 acceptance criteria

- Slack card is visible in the target test channel/thread/DM.
- Start interaction updates the run state.
- Runner output or graceful failure is posted back to Slack.
- Cancel behavior is verified with a safe long-running case or documented as blocked.
- Logs capture request/run IDs.
- No secret-like values appear in Slack output or logs included in reports.
- Smoke-test report includes timestamps, channel/thread references or permalinks where safe, config summary, validation result, and blockers.

### Non-goals

- Do not deploy new EC2 process manager unless required to start the existing app.
- Do not create Linear issues unless intentionally testing Linear route idempotency.
- Do not use destructive prompts.
- Do not merge PRs as part of the smoke test.

## Phase 3 — Slack shortcut/modal cockpit

### Goal

After Phase 1 packaging and Phase 2 smoke test succeed, build the higher-leverage Slack cockpit UX.

The cockpit should make agent execution feel native in Slack instead of requiring users to remember text prefixes.

### Target user flow

```text
User right-clicks a Slack message/thread
  -> selects "Run Covent Pi Agent"
  -> modal opens
  -> user selects workflow/profile
  -> user reviews/edits prompt
  -> submit posts Agent Run Card in thread
  -> user clicks Start
  -> supervised-pi runs
  -> result returns to thread and optional Canvas
```

### Phase 3 likely deliverables

- Slack message shortcut handler.
- Modal builder.
- Modal submission handler.
- Profile/workflow selector.
- Prompt preview/edit input.
- Agent Run Card creation from modal submissions.
- Tests for payload parsing and modal construction.
- README/manifest docs for Slack interactivity setup.

### Phase 3 non-goals

- Do not build a full App Home dashboard in the first cockpit PR.
- Do not build a generic workflow builder.
- Do not allow arbitrary shell commands.
- Do not bypass the Agent Run Card audit object.

## Source-of-truth rules for parallel agents

1. `origin/main` is canonical merged truth.
2. Open PRs with green CI are candidate truth.
3. Local branches are proposals.
4. Dirty worktrees are WIP until committed.
5. Untracked markdown reports are evidence/artifacts, not implementation truth.
6. Do not merge or close another agent's work without explicit instruction.
7. Prefer fresh worktrees and fresh branches for new PR packaging.
8. Preserve reports before deleting worktrees.
9. Every implementation PR must include validation output in the PR body.
10. Every Slack/agent workflow must preserve source links, redaction, request/run IDs, and rollback/kill-switch posture.

## Current next actions

1. Package Phase 1 branches and open PRs without merging.
2. In parallel, run Phase 2 smoke-test reconnaissance/execution if credentials and runtime are available.
3. After both are done, review results and then spec Phase 3 shortcut/modal cockpit.
