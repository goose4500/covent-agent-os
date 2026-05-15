> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Implementation Plan

## Goal
Create a first, fast hardening branch that makes the Slack/Pi/Linear bridge safer to change by adding worktree isolation, focused tests, shared config validation, and duplicate-write guardrails without slowing the current POC loop.

## Tasks
1. **Create an isolated hardening worktree**: Start the branch outside the active checkout so ongoing POC work stays unblocked.
   - File: repository/worktree only
   - Changes: run `git status --short`, then `git worktree add ../covent-agent-os-hardening-pi-mom -b hardening/pi-mom-guardrails-v1`; perform all implementation in that worktree.
   - Acceptance: `git worktree list` shows `../covent-agent-os-hardening-pi-mom` on `hardening/pi-mom-guardrails-v1`, and the original checkout remains unchanged except this `plan.md`.

2. **Extract testable pi-mom route helpers**: Move pure parsing/redaction/thread-reference helpers out of the monolithic bridge while keeping runtime behavior unchanged.
   - File: `apps/pi-mom/index.mjs`
   - File: `apps/pi-mom/lib/routes.mjs`
   - Changes: export `ROUTES`, `stripBotMentions`, `parseCommand`, `parseThreadSpecIntent`, `parseLinearCreateIntent`, `parseSlackRequestCommand`, `normalizeSlackTs`, `parseSlackThreadReference`, `redactSensitiveText` or import redaction from a shared helper; update `index.mjs` imports.
   - Acceptance: `npm --prefix apps/pi-mom run check` passes and existing Slack command examples still parse to the same route keys in tests.

3. **Add low-friction unit tests for route parsing and redaction**: Cover the paths most likely to break product value.
   - File: `apps/pi-mom/test-routes.mjs`
   - File: `apps/pi-mom/package.json`
   - Changes: add `node:test` assertions for app mentions (`draft spec`, `create Linear issue`), explicit prefixes (`linear:`, `image:`, `agent:`), help/status, Slack thread URL parsing, bot mention stripping, unknown route fallback, and token redaction for Slack/Linear/OpenAI/GitHub/AWS-like tokens. Add the test to `check`.
   - Acceptance: `npm --prefix apps/pi-mom run check` executes `test-routes.mjs`; at least 20 assertions pass; no network or real Slack/Linear credentials are required.

4. **Centralize environment/config validation for pi-mom**: Reduce drift between startup and doctor diagnostics.
   - File: `apps/pi-mom/lib/config.mjs`
   - File: `apps/pi-mom/index.mjs`
   - File: `apps/pi-mom/doctor.mjs`
   - File: `apps/pi-mom/test-config.mjs`
   - Changes: add a pure `readConfig(env)`/`validateConfig(env)` module for required Slack vars, `PI_MOM_MODE`, streaming booleans, allowed-channel fail-closed behavior in `pi` mode, bounded integer envs, runner modes, and Linear target defaults. Use it from `index.mjs`; let `doctor.mjs` report from the same rules without printing secret values.
   - Acceptance: tests cover valid echo mode, valid pi mode with `SLACK_ALLOWED_CHANNEL_ID`, invalid mode, invalid streaming flag, missing Slack tokens, and `PI_MOM_ALLOW_ANY_CHANNEL=true` override; `npm run check` passes.

5. **Add a first duplicate-write guard for Linear creation**: Prevent accidental repeat Linear issues from the same Slack thread when a previous success is already visible.
   - File: `apps/pi-mom/index.mjs`
   - File: `apps/pi-mom/lib/linear-guard.mjs`
   - File: `apps/pi-mom/test-linear-guard.mjs`
   - Changes: before calling `createLinearIssueFromPiOutput()`, inspect fetched thread messages for an existing bot confirmation matching `Created Linear issue` and a Linear URL/key; if found, reply with the existing issue link and skip creation. Keep the explicit `linear:` / `create Linear issue` approval semantics unchanged.
   - Acceptance: unit tests prove duplicate detection skips creation when a prior confirmation exists and allows creation when only drafts/errors/no-key notices exist; manual code review confirms no Linear API call occurs on duplicate.

6. **Tighten CI/check coverage for app code**: Make the root validation catch the new tests and pure modules.
   - File: `apps/pi-mom/package.json`
   - File: `package.json`
   - File: `.github/workflows/ci.yml` if needed
   - Changes: ensure `npm run check` runs all new pi-mom tests and `node --check` over new `.mjs` files. Prefer keeping the existing single root `npm run check` entrypoint.
   - Acceptance: from the worktree root, `npm run secret-scan`, `npm run check`, and `npm run doctor:pi-mom` run as expected; `doctor` may fail only when real local Slack/Pi env is intentionally absent, but must not print secret values.

7. **Document the hardening branch scope and rollback**: Make the branch easy for future agents/humans to understand.
   - File: `docs/runbooks/pi-mom-hardening-v1.md`
   - File: `docs/SYSTEM_INDEX.md`
   - Changes: add a short runbook with worktree path, branch name, validation commands, non-goals, and rollback (`git worktree remove ../covent-agent-os-hardening-pi-mom`; revert branch if needed). Link it from `docs/SYSTEM_INDEX.md` under Slack/Pi runtime or runbooks.
   - Acceptance: a new contributor can find the branch purpose, run the checks, and understand that this branch is test/guardrail hardening rather than feature expansion.

8. **Open review with explicit non-goals**: Keep the PR small and value-preserving.
   - File: PR description only
   - Changes: summarize behavior-preserving refactors, added tests, config validation, duplicate Linear guard, and validation output. Note no Slack scope changes, no production deploy, no Pi tools enablement, and no broad route redesign.
   - Acceptance: PR/review checklist includes `npm run secret-scan`, `npm run check`, duplicate Linear guard test evidence, and a statement that no secrets/log exports were committed.

## Files to Modify
- `apps/pi-mom/index.mjs` - import extracted helpers/config and add pre-create Linear duplicate guard without changing route semantics.
- `apps/pi-mom/doctor.mjs` - use shared config validation and continue hiding secret values.
- `apps/pi-mom/package.json` - include new syntax checks and `node:test` files in `check`.
- `package.json` - keep root `npm run check` as the canonical validation entrypoint; adjust only if needed for new app checks.
- `docs/SYSTEM_INDEX.md` - link the new hardening runbook.

## New Files
- `apps/pi-mom/lib/routes.mjs` - pure Slack command/intent/thread parsing helpers.
- `apps/pi-mom/lib/config.mjs` - pure env/config validation shared by runtime and doctor.
- `apps/pi-mom/lib/linear-guard.mjs` - pure detector for existing Linear creation confirmations in a Slack thread.
- `apps/pi-mom/test-routes.mjs` - unit tests for route parsing, thread URL parsing, mention stripping, and redaction.
- `apps/pi-mom/test-config.mjs` - unit tests for config validation and fail-closed startup rules.
- `apps/pi-mom/test-linear-guard.mjs` - unit tests for duplicate Linear issue detection.
- `docs/runbooks/pi-mom-hardening-v1.md` - branch/runbook/rollback notes for the first hardening pass.

## Dependencies
- Task 1 must happen before any implementation work.
- Task 2 enables Task 3 by making route logic importable without starting Slack Bolt.
- Task 4 should land before Task 6 so `check` can include config tests.
- Task 5 depends on understanding the current Linear creation path in `apps/pi-mom/index.mjs` and should be implemented after route extraction to minimize merge risk.
- Task 7 should be updated after Tasks 2-6 so docs match the actual branch contents.

## Risks
- `/home/jfloyd/covent-agent-os/context.md` was not present when this plan was written; if it exists elsewhere, re-check it before implementation.
- Refactoring `index.mjs` can accidentally change Slack route behavior; keep extraction mechanical and back it with tests before adding new guardrails.
- Duplicate Linear detection based on Slack text is heuristic; it should only skip on clear prior success confirmations with a Linear link/key, not on drafts or failures.
- `doctor:pi-mom` contacts Slack and checks local Pi availability; CI should not require real credentials unless explicitly configured.
- Keep all tests offline and fixture-based; do not export raw Slack/Linear data or logs into the repo.
- Do not broaden Slack write authority, enable Pi tools for Slack-originated routes, change Railway deployment behavior, or revise Slack scopes in this first branch.

## Non-Goals
- No production Railway deploy as part of this branch.
- No Slack manifest/scope redesign beyond documenting current scope risk.
- No modal approval workflow or full Linear idempotency store.
- No pagination/media support for non-image thread context.
- No conversion of the whole app to TypeScript or a new framework.
- No new external services, databases, queues, or observability vendors.
