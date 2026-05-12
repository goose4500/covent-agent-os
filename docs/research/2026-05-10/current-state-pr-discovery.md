# Current state / PR discovery (pass 1)

Timestamp: 2026-05-10. Read-only GitHub inspection; no GitHub mutations performed.

## Local repository state

- CWD checkout: `/home/jfloyd/covent-agent-os` on `feat/slack-data-skill` at `650bffd`.
- CWD status is **not clean**: only untracked report/planning files/directories are present (`plan.md`, `progress.md`, `pr-audit-*`, `research/`, etc.); no tracked modifications in the main checkout.
- Local `main` is stale: `main=606cef2`, `origin/main=14d9f33`; `main..origin/main` has 4 commits.
- Current branch diverges from `origin/main`: `git rev-list --left-right --count origin/main...HEAD` = `4 4`; merge-base is `606cef2`.
- Remote origin: `https://github.com/goose4500/covent-agent-os.git`.

### Worktrees / dirty state

Clean worktrees:
- `/home/jfloyd/covent-agent-os-bun` (`feat/bun-migration-spec`, tracks origin branch)
- `/home/jfloyd/worktrees/covent-agent-os-hardening-pi-mom` (`hardening/pi-mom-guardrails-v1`, tracks origin branch)
- `/home/jfloyd/worktrees/covent-agent-os-image-client` (`refactor/image-client-consolidation`)
- `/home/jfloyd/worktrees/covent-agent-os-refactor-integration` (`refactor/boring-leverage-integration`, tracks origin branch)
- `/home/jfloyd/worktrees/covent-agent-os-route-parser` (`refactor/pi-mom-route-parser`)
- `/home/jfloyd/worktrees/covent-agent-os-runtime-config` (`refactor/pi-mom-runtime-config`)

Dirty/untracked worktrees:
- Main checkout `feat/slack-data-skill`: untracked reports/plans/research files only.
- `feat/agent-control-plane-mvp`: tracked edits to README/package/docs plus untracked control-plane files.
- `speed-mode/agent-profiles`: tracked profile edits plus untracked README/new profile/`parallel-results/`.
- `speed-mode/archive-safe-mode`: tracked doc edits plus `parallel-results/`.
- `fix/pi-mom-linear-idempotency`: untracked `clean-pr-linear-idempotency.md`.
- `refactor/pi-mom-mjs-seams`: tracked `apps/pi-mom` edits plus many untracked lib/test/report files.
- `speed-mode/runtime-defaults`: tracked pi-mom env/doc/code edits plus `parallel-results/`.
- `speed-mode/speed-policy`: tracked boundary/system docs edits plus `parallel-results/`.
- `speed-mode/supervised-pi`: tracked runner/card test edits plus `parallel-results/`.
- `feat/supervised-pi-runner`: untracked `implementation-supervised-pi-runner.md`.

## `origin/main` / branch state

- GitHub `main` HEAD: `14d9f33adc25b6884cc1c3a854f2314ab3b21531` (`chore(ci)(deps): bump actions/setup-node from 4 to 6 (#8)`), commit date `2026-05-10T22:52:16Z`.
- Recent `origin/main` commits:
  1. `14d9f33` PR #8 setup-node v6
  2. `74c564f` PR #7 checkout v6
  3. `03f7a09` PR #3 CI hardening
  4. `9e4d479` PR #1 AWS/Bun/package integration
  5. `606cef2` previous local `main`
- GitHub branch protection for `main`: reported `protected=false` by `gh api repos/.../branches/main`.

## PR state (#2, #4, #5, #6, #9, #10, #11, #12)

| PR | State | Base <- Head | Merge | Checks | Notes |
|---:|---|---|---|---|---|
| #2 | OPEN | `main` <- `feat/bun-migration-spec` | CLEAN / MERGEABLE | 2/2 success (`ci/check`) | One commit `f112499` docs-only Bun migration spec. |
| #4 | OPEN | `main` <- `claude/research-insights-analyzer-He7m2` | CLEAN / MERGEABLE | 2/2 success (`ci/check`) | Three commits through `2e709f`; insights analyzer + prompt-fence + lifecycle skill doc. |
| #5 | OPEN | `main` <- `claude/slack-private-agent-messaging-EFV2x` | CLEAN / MERGEABLE | 2/2 success (`ci/check`) | One commit `20fe816`; private DM route. |
| #6 | OPEN | `main` <- `claude/refactor-app-modularity-FcmE5` | UNSTABLE / MERGEABLE | 0/2 success; both `ci/check` failed | Four commits through TS migration `94c71e4`; mergeable but failing CI. |
| #9 | OPEN | `main` <- `dependabot/npm_and_yarn/types/node-25.6.2` | CLEAN / MERGEABLE | 2/2 success (root check + Bun package test) | Dependabot @types/node bump `aa9573f`. |
| #10 | OPEN | `main` <- `dependabot/npm_and_yarn/typescript-6.0.3` | CLEAN / MERGEABLE | 2/2 success (root check + Bun package test) | Dependabot TypeScript bump `4855fe8`. |
| #11 | OPEN | `feat/pi-mom-agent-run-card-poc` <- `hardening/pi-mom-guardrails-v1` | CLEAN / MERGEABLE | 2/2 success (`ci/check`) | Stacked hardening PR, not against `main`; one commit `6c7b146`. |
| #12 | OPEN | `main` <- `fix/pi-mom-linear-idempotency` | CLEAN / MERGEABLE | 3/3 success (old `ci/check` plus new root check + Bun package test) | Contains run-card POC `cef9bbc` plus Linear idempotency fix `ebd37ec`; effectively supersedes/absorbs the run-card base for main. |

Other PR changes observed:
- #1 MERGED at `2026-05-10T21:40:57Z` (`9e4d479`).
- #3 MERGED at `2026-05-10T21:41:32Z` (`03f7a09`).
- #7 MERGED at `2026-05-10T22:52:14Z` (`74c564f`).
- #8 MERGED at `2026-05-10T22:52:17Z` (`14d9f33`).

## What changed since the prior strategic summary / merge report

- Prior merge report said #1 and #3 were merged and #2 remained untouched. Since then, `origin/main` advanced two more commits via Dependabot GitHub Actions PRs #7 and #8.
- The authoritative remote `main` is now `14d9f33`, while local `main` remains at `606cef2`; update local `main` before basing any new work.
- Additional open PRs now exist/are relevant: #9, #10, #11, #12. #12 is green and mergeable into `main`; #11 is green but stacked on `feat/pi-mom-agent-run-card-poc` rather than `main`.
- CI workflow shape changed after #3/#7/#8: Dependabot/npm PRs show split jobs (`Check...`, `Test packages/pi-ext-covent-aws (bun)`), while older Claude PRs still show duplicate `ci/check` entries.
- #6 remains the main unhealthy PR: mergeable but UNSTABLE with two failing `ci/check` runs.
- Multiple local worktrees contain uncommitted implementation artifacts; avoid cleanup/rebase/merge operations until each worktree owner confirms whether to preserve them.

## Recommended next action sequence

1. Do not merge from the dirty CWD. First preserve/commit/archive the untracked discovery files as intended, or switch to a clean worktree.
2. Fast-forward local `main` to `origin/main` (`14d9f33`) in a clean checkout before new integration work.
3. Merge low-risk green PRs first: #2 (docs-only), then #9/#10 if dependency policy accepts them; rerun CI after each or merge queue equivalent.
4. Treat #12 as the main candidate for run-card + Linear idempotency; review carefully because it includes both `cef9bbc` and `ebd37ec`, then merge if product scope is accepted.
5. After #12, re-evaluate #11: retarget/rebase it onto updated `main` or close/supersede if #12 already covers the required guardrail/idempotency scope.
6. Review product/security implications of #4 and #5 before merge despite green checks (Slack/Pi behavior changes).
7. Do not merge #6 until its CI failures are diagnosed/fixed; also compare it against local `refactor/pi-mom-mjs-seams` dirty worktree to avoid duplicating/conflicting refactor work.
