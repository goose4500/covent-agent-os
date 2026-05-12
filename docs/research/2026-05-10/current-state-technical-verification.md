# Current-state technical verification — PR #12/#11/#6 vs mjs-seams

## Recommendation

**Make PR #12 the canonical base before continuing modular seams.** It is the safest next integration point: it merges cleanly into current `origin/main`, its pi-mom checks pass on the simulated main+#12 tree, and it contains the agent-run-card POC plus the stronger Linear duplicate/idempotency guard.

Parent agent should do next, in order:

1. **Land/update PR #12 first** (`fix/pi-mom-linear-idempotency` into `main`).
   - Before merge, refresh/rebase #12 onto current `main` if desired for clean history; technical merge simulation had no conflicts.
   - Gate: run full repo `npm run check` plus `npm --prefix apps/pi-mom run check` on main+#12.
2. **Treat local `/home/jfloyd/worktrees/covent-agent-os-mjs-seams` as the modular-seams continuation, but rebase/replay it onto main+#12.**
   - It currently passes its own pi-mom seam check, but it was built on `origin/main` and does not include #12’s `agent-run-*`, `slack-canvas`, or `linear-idempotency` modules.
   - Expect manual integration in `apps/pi-mom/index.mjs` and `apps/pi-mom/package.json`.
3. **Do not merge PR #11 as-is after #12.**
   - #11 conflicts with #12 in `apps/pi-mom/index.mjs` and `apps/pi-mom/package.json`.
   - Cherry-pick/port selected ideas only: testable `readConfig(env)`, route parser tests, production guard for `PI_MOM_ALLOW_ANY_CHANNEL`, and guardrail spec docs.
   - Prefer #12’s duplicate guard semantics over #11’s `linear-guard.mjs` unless deliberately rewritten.
4. **Do not use PR #6 as the base for this path.**
   - #6 is an older TypeScript/strip-types rewrite and conflicts with #12/#11 by deleting/replacing `index.mjs` with `index.ts`.
   - Its domain decomposition is conceptually similar to local mjs-seams, but local mjs-seams is the better fit if the chosen direction is to stay `.mjs`.
5. **After #12 + mjs-seams are reconciled, add/retain tests from both lines.**
   - Keep #12 `test-agent-run-card.mjs` and `test-linear-idempotency.mjs`.
   - Keep mjs-seams `test-domain.mjs` or split into route/config/domain tests.
   - Port #11 config/route/guardrail cases where they improve coverage.

## Verification evidence

- PR metadata observed:
  - #12: `fix(pi-mom): avoid duplicate Linear issues from Slack threads`, base `main`, open, mergeable.
  - #11: `Harden pi-mom route/config seams and Linear duplicate guard`, base `feat/pi-mom-agent-run-card-poc`, open, mergeable relative to its base.
  - #6: `refactor(pi-mom): split config and pure domain modules out of index.mjs`, base `main`, open, mergeable but old TypeScript direction.
- All three PRs share old merge-base `606cef2`; current main has later merged #1/#3/#7/#8. Diff views show apparent deletions of newer main files, but merge simulation for #12 retains main changes and has no conflicts.
- Simulated merge `origin/main + origin/pr/12` produced no conflicts and `apps/pi-mom` check passed:
  - `agent run card tests passed`
  - `linear idempotency tests passed`
- Direct PR checks passed for #12, #11, and #6 pi-mom scripts.
- Local mjs-seams worktree status: uncommitted changes on `refactor/pi-mom-mjs-seams` at `origin/main`; its `npm --prefix apps/pi-mom run check` passed (`domain seam tests passed`).

## Conflict/overlap map

- **#12 vs #11:** content conflicts in:
  - `apps/pi-mom/index.mjs`
  - `apps/pi-mom/package.json`
  - Both include agent-run-card POC base, but #11 replaces #12’s `lib/linear-idempotency.mjs` with `lib/linear-guard.mjs` and also extracts `lib/config.mjs` / `lib/routes.mjs`.
- **#12 vs #6:** conflicts in:
  - `apps/pi-mom/index.mjs` modify/delete (`#6` deletes it for `index.ts`)
  - `apps/pi-mom/package.json`
- **#11 vs #6:** same TypeScript-vs-MJS conflict pattern.
- **#12 vs local mjs-seams:** expected manual conflicts/overlap in:
  - `apps/pi-mom/index.mjs`
  - `apps/pi-mom/package.json`
  - Semantic overlap: mjs-seams extracts config/domain/routes/interactions; #12 adds agent-run modules and Linear idempotency still wired through monolithic `index.mjs`.
- **#11 vs local mjs-seams:** direct path/name overlap in `apps/pi-mom/lib/config.mjs` plus route/config extraction, but #11 config is more testable and includes stronger environment safety checks.

## Key risks/blockers

- **Branch base staleness:** #11/#12/#6 are based before recent main merges. #12 is merge-clean, but rebase/merge should be verified with full checks.
- **Duplicate Linear guard divergence:** #12’s guard scans newest-first and filters more non-success/draft/failure cases. #11’s simpler guard is useful but should not overwrite #12 without review.
- **Config safety regression risk in local mjs-seams:** local `config.mjs` exits at import time and lacks #11’s production rejection for `PI_MOM_ALLOW_ANY_CHANNEL=true`; port #11’s testable config pattern after #12.
- **Architecture fork risk:** choosing #6 TypeScript now would invalidate the MJS seam path and collide with #12’s POC files. Pick one path; current evidence favors #12 then MJS seams.
