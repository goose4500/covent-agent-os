# ADR 0015: Retire GitHub MCP/native PR tools in favor of gh CLI

Date: 2026-05-17
Status: accepted
Supersedes: ADR 0006, ADR 0010 GitHub server posture, and the GitHub PR wrapper example in ADR 0011
Related: ADR 0013 (CLI-first EC2 agent workstation)

## Context

Covent Pi now runs in the EC2 agent workspace with authenticated `git` and `gh` CLI available. That makes the dedicated GitHub MCP server and the hand-written GitHub PR Pi tools redundant for day-to-day repository work.

Keeping all three paths active — shell `gh`, GitHub MCP through `mcp({ server: "github", ... })`, and native `github_*` Pi tools — increases tool-list noise, duplicates credentials, and creates ambiguity about which surface the agent should use for branches, PRs, comments, and merges.

## Decision

Retire GitHub-specific MCP functionality from pi-mom and use the local GitHub CLI for GitHub operations.

Concretely:

1. Remove the seeded `github` server from the sanitized MCP example config.
2. Stop registering the native `github_get_pr`, `github_pr_comment`, `github_create_pr`, and `github_merge_pr` Pi tools.
3. Delete the GitHub PR wrapper extension and its dedicated tests.
4. Keep `pi-mcp-adapter` itself: non-GitHub MCP servers such as Context7, Chrome DevTools, and Slack still use the MCP proxy.
5. Use `git` / `gh` shell commands for branch, commit, push, PR, PR comment, and merge workflows after explicit Slack intent or approval.

## Runtime cleanup

Persisted agent directories may still contain an older `${PI_AGENT_DIR}/mcp.json` with a `github` server entry because seeding only writes when the file is missing. Operators should remove that `github` entry from the persisted runtime file, or delete/reseed the file from the updated sanitized template. Do not print token values while inspecting or editing runtime config.

## Safety posture

- GitHub mutations remain human-intent gated: an agent may push/open/merge only when the user explicitly asks or approves in the current Slack thread.
- Secrets stay outside git. The repo documents CLI-first behavior but does not store or expose `gh` auth material.
- The active Pi tool list is smaller and less ambiguous; GitHub remains available through the reviewed shell workflow instead of an MCP/native tool path.

## Consequences

- `bun run check` no longer runs `test-github-pr-tools.mjs`.
- Loader smoke tests must not expect `github_*` Pi tools.
- ADR 0006 and ADR 0010 are historical records only; their GitHub MCP guidance is superseded by this ADR.
- ADR 0011 remains useful as native-wrapper criteria for future non-GitHub high-leverage workflows, but its GitHub PR wrapper spike is now retired.
