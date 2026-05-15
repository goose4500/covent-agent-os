# Branch protection — `main`

CI checks are only protective if they are *required*. Without a branch protection
rule, anyone with push access to `goose4500/covent-agent-os` can push directly
to `main` and bypass `bun run check` entirely.

This runbook documents the protection ruleset that should be applied to `main`
and how to (re)apply it.

## Required configuration

| Setting | Value | Why |
|---|---|---|
| Require a PR before merging | yes | All changes go through a reviewable diff |
| Required approving reviews | 1 | At a 5-10 person team, anything more is friction without payoff |
| Dismiss stale approvals on new commits | yes | A force-push/amend invalidates prior review |
| Require status checks to pass before merging | yes | The whole point |
| Required status check contexts | `Check (lint, validators, typecheck, secrets)` | The single current CI job from `.github/workflows/ci.yml`; despite the historical name, it runs Gitleaks plus `bun run check` |
| Require branches to be up to date before merging | yes | Prevents merging stale PRs that pass against an older `main` |
| Require conversation resolution before merging | yes | Forces explicit closure on review feedback |
| Block force pushes | yes | History integrity |
| Block branch deletion | yes | `main` is sacred |
| Apply to admins | yes | "Apply to admins" is what makes the rule actually unbypassable |

## Apply via `gh` CLI

The fastest path. Run from the repo root after authenticating with `gh auth login`.

```sh
gh api -X PUT repos/goose4500/covent-agent-os/branches/main/protection \
  -F required_status_checks[strict]=true \
  -F 'required_status_checks[contexts][]=Check (lint, validators, typecheck, secrets)' \
  -F enforce_admins=true \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F required_pull_request_reviews[dismiss_stale_reviews]=true \
  -F required_pull_request_reviews[require_last_push_approval]=true \
  -F required_conversation_resolution=true \
  -F restrictions=null \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

Verify with:

```sh
gh api repos/goose4500/covent-agent-os/branches/main/protection | jq
```

## Apply via GitHub UI

If the CLI is unavailable:

1. https://github.com/goose4500/covent-agent-os/settings/branches
2. Add rule, branch name pattern `main`
3. Toggle each row in the table above
4. Under "Status checks that are required" search for and add the current CI job name: `Check (lint, validators, typecheck, secrets)`
5. Save changes

## When required check names change

If you add or rename a CI job, the required-check list above goes stale and
PRs will be blocked waiting for a check that never runs. To update, run the
`gh api` command again with the corrected `contexts` list, OR edit the rule
in the GitHub UI.

## Disabling temporarily (emergency hotfix)

Don't. Use a normal PR with `gh pr create --label hotfix` and the same review
gate — the gate exists exactly for the moments when you're tempted to skip it.
If the gate itself is broken, fix the gate via PR (the fix gets the same
review). Branch protection bypasses are the canonical entry point for a
production incident.
