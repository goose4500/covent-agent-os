> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# PR audit: AWS package, Bun spec, CI hardening

Scope: GitHub PRs #1, #2, #3 plus local repo files. No repo/GitHub mutation performed beyond reading/fetching refs and writing this report.

## Recommended path

1. **Merge #1 first** after the validation checklist below.
2. **Merge #3 second** (it is stacked on #1 and closes the CI loop for #1's Bun-tested AWS package).
3. **Rework #2 before merge** so the spec matches the post-#1/#3 repo instead of fossilizing stale docs.

## PR #1 — `feat(packages): integrate pi-ext-covent-aws + add aws-operator profile`

**Recommendation: merge first, with targeted validation.**

Why:
- High-leverage integration: moves the AWS extension into the workspace, makes AWS tools profile-declarable, and keeps the extension dormant unless `COVENT_LANE` is set.
- The core safety design is sensible: registration-time lane gating; SSM secret value goes to `process.env`, not the tool response; AWS auth uses the SDK default chain.
- Tests cover the important local invariants: operator vs bridge registration, secret response non-leak, S3 body mutual exclusion, CloudWatch token pass-through, audit entry omits args.

Risks / notes:
- `process.env` is not a complete secrecy boundary. It hides values from the LLM tool envelope, but any later process/tool with env access can read them. Keep `ssm_get_secret` out of Slack-originated routes and rely on IAM + lane separation.
- `sqs_send_event` accepts arbitrary queue URL/body; IAM must restrict allowed queues.
- Bridge mode still instantiates all four AWS clients, though only SSM/SQS tools register. Not a blocker; no network call happens at construction.
- Root `npm run check` intentionally excludes the package TS/tests; #3 closes this in CI. Until #3 lands, validate package checks manually.

Exact validation before merge:
```sh
npm ci
npm run check
cd packages/pi-ext-covent-aws
bun run typecheck
bun test
```
Smoke Pi registration from repo root:
```sh
pi install "$PWD"
pi                         # no COVENT_LANE: extension dormant, no crash
COVENT_LANE=bridge AWS_REGION=us-east-1 pi      # only ssm_get_secret + sqs_send_event visible
COVENT_LANE=operator AWS_REGION=us-east-1 pi    # all 4 AWS tools visible
```
Defer real AWS e2e until sandbox IAM/resources exist; then test SSM/SQS/S3/CWL against least-privilege roles, not personal credentials.

## PR #2 — `docs(bun): add bun runtime migration spec`

**Recommendation: rework, do not merge as-is.**

Why:
- Docs-only and directionally useful, but already stale/fragile relative to #1: after #1, `packages/pi-ext-covent-aws/src/index.ts` is a Pi-loaded Node-fenced extension and must be included in the fence/inventory.
- It references `docs/specs/boring-high-leverage-refactor-spec.md`, which does not exist on current `main`.
- The 465-line spec is more elaborate than needed for Jake's “simple/high leverage” goal. Keep the durable contract, but prune speculative/exhaustive inventory that will drift.

Minimum rework:
- Rebase/update after #1 (and preferably #3).
- Add the AWS extension to the Node-only fence and update counts like “10 files” / “5 registered”.
- Remove or create/fix the missing sibling-spec link.
- Keep the actionable parts: Pi runtime fence, phased migration gates, rollback, and CI tripwire.

Exact validation after rework:
```sh
test -f docs/specs/boring-high-leverage-refactor-spec.md || ! grep -q boring-high-leverage-refactor-spec docs/specs/bun-migration-spec.md
grep -q 'packages/pi-ext-covent-aws/src/index.ts' docs/specs/bun-migration-spec.md
npm run check
```
Also spot-check rendered Markdown links and verify the fence list matches actual `package.json` `pi.extensions` plus transitive imports.

## PR #3 — `chore(ci): harden gate — bun tests, gitleaks, dependabot`

**Recommendation: merge after #1.**

Why:
- Correctly stacked on #1; adds the missing AWS package `bun typecheck` + `bun test` CI job.
- Improves signal/cost: no push CI on every feature branch, stale PR runs cancel, explicit `contents: read`, full-history gitleaks, pi-mom lockfile drift gate.
- Dependabot config is reasonable and grouped enough to avoid dependency PR spam.

Risks / notes:
- Branch protection runbook requiring 1 approval + enforce admins can deadlock a solo-maintainer repo. Only apply exactly as written if Jake has another reviewer who can approve PRs.
- Full-history gitleaks is intentionally stricter. It passed on the PR, but any future historical false positive will block merges until allowlisted or history is remediated.
- The branch protection command is not applied by merging files; someone must run it after merge.

Exact validation before merge:
```sh
# on #3 after #1 is merged/retargeted
npm ci
npm ci --prefix apps/pi-mom
npm run check
cd packages/pi-ext-covent-aws && bun run typecheck && bun test
```
And require GitHub Actions green for both contexts:
- `Check (lint, validators, typecheck, secrets)`
- `Test packages/pi-ext-covent-aws (bun)`

After merge, apply/verify branch protection only after confirming reviewer availability:
```sh
gh api repos/goose4500/covent-agent-os/branches/main/protection | jq
```
