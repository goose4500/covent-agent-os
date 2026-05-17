# ADR 0013: CLI-first EC2 agent workstation for GitHub and Railway work

Date: 2026-05-16
Status: accepted
Related: ADR 0007, ADR 0010, ADR 0011, ADR 0012, ADR 0015

## Context

Covent's Slack/Pi agent system now has three overlapping ways to touch GitHub, Git, and Railway:

1. **Shell/CLI through Pi bash** — `git`, `gh`, `railway`, `bun`, `pi`, and normal Unix tools in the agent workspace.
2. **MCP proxy tools** — non-GitHub servers reached through `mcp({ server: "…", tool: "…" })`.
3. **Native Pi tools** — hand-written wrappers such as Linear tools and Slack UI tools.

The EC2 workspace became much less valuable than Jake's personal CLI because it was missing the everyday operator layer: Git identity, GitHub CLI auth, Railway CLI auth/linking, and normal PATH access to the project runtimes. Without that layer, agents could reason about work but could not reliably perform basic engineering operations in the shared environment.

At the same time, blindly replacing every CLI operation with MCP or native Pi tools creates tool sprawl. `gh` and `railway` already provide stable, documented, scriptable interfaces. Wrapping all of that surface area inside Pi tools would add maintenance cost, schema drift, and duplicate auth paths without giving much extra safety.

## Decision

Use the EC2 Ubuntu machine as a **CLI-first agent workstation** for GitHub, Git, Railway, and repo operations.

The primary execution path for repo/platform work is:

```text
Slack / human request
  → Pi reasoning + skill/runbook instructions
  → bash executes git / gh / railway / bun / pi commands on EC2
  → agent summarizes evidence and asks for approval before dangerous steps
```

The EC2 operator environment should provide, at minimum:

```text
git
GitHub CLI (`gh`) authenticated for the Covent repo scope
Railway CLI authenticated and linked to covent-pi-mom / production / covent-pi-mom
bun
node/npm
pi CLI
jq / rg / curl / ssh basics
```

`/home/ubuntu` is the workspace root for Slack-originated Pi turns, so Railway project linking and Git/GitHub auth must work from both:

```text
/home/ubuntu
/home/ubuntu/covent-agent-os
```

### Skills are the policy layer

For GitHub/Railway workflows, prefer **SKILL.md runbooks and agent instructions** over new native tools by default. Skills should encode:

- required preflight commands (`pwd`, `git status --short --branch`, `railway status`)
- safe read-only inspection commands
- approval boundaries before writes, restarts, deploys, merges, token changes, or destructive Git operations
- redaction rules for logs/env/variables
- expected evidence to report back

This keeps the capability surface close to how engineers operate the system manually while still giving agents reusable discipline.

### MCP/native tools remain selective

Do **not** remove MCP or native tools categorically. Keep them where they add leverage that raw CLI does not:

- **Slack UI tools** for approval cards, choice cards, input requests, and canvases.
- **Linear tools** for structured issue search/create/comment behavior with predictable output shapes.
- **MCP proxy** for broad structured API access, one-off discovery, or surfaces where the CLI is weaker.

But do not wrap `gh` or `railway` commands merely because they exist. A native wrapper should clear the ADR 0011 bar: frequent, safety-critical, schema-stable enough to own, and materially improved by Pi-native UI/telemetry.

### GitHub posture on EC2

ADR 0015 supersedes the earlier GitHub MCP posture: do not keep a GitHub MCP server or native `github_*` tools in the active pi-mom surface. Use the authenticated local `gh` CLI for GitHub operations after explicit Slack intent/approval. Keep `pi-mcp-adapter` for non-GitHub servers.

## Credential posture

The POC may bootstrap EC2 from an operator's existing GitHub/Railway config to prove the lane, but that is not the durable target.

Target posture:

- Use fine-grained GitHub credentials scoped to `goose4500/covent-agent-os` and required org/repo operations only.
- Use a Railway credential with the narrowest available workspace/project access for `covent-pi-mom` operations.
- Do not copy wholesale local configs such as `~/.secrets`, `.claude.json`, Codex configs, browser profiles, raw MCP OAuth caches, or private Slack data to EC2.
- Do not print token values, Railway variable values, env files, OAuth material, cookies, or auth JSON in Slack, Linear, docs, GitHub, or shell transcripts.
- Verify config by presence/status and non-secret resource names only.

## Validation evidence

Non-secret EC2 smoke checks on 2026-05-16 confirmed the CLI-first lane works from a service-like environment rooted at `/home/ubuntu`:

```text
git version 2.43.0
gh version 2.45.0
railway 4.58.0
bun 1.3.14
pi 0.74.0
```

Validated operations:

```text
gh auth status                         → logged in as goose4500
gh repo view goose4500/covent-agent-os → returns repo metadata
railway whoami                         → logged in
railway status                         → resolves covent-pi-mom / production / covent-pi-mom
git ls-remote origin main              → returns refs/heads/main
pi --version                           → 0.74.0
```

ADR 0015 later retired the GitHub MCP config entirely in favor of the authenticated `gh` CLI. Operators should remove any persisted legacy `github` server entry from the active agent `mcp.json` without printing token values.

## Consequences

Positive:

- Agents can use the same operational primitives humans use: `git`, `gh`, `railway`, `bun`, and `pi`.
- GitHub/Railway capability no longer depends on a large set of custom wrappers before agents become useful.
- Skills become the durable, reviewable policy surface for CLI workflows.
- MCP/native tools can stay focused on places where they create real safety or UX leverage.

Trade-offs:

- CLI access is powerful and less schema-constrained than narrow tools. Skill/runbook discipline and approval prompts become more important.
- Shell output can contain sensitive data. Agents must prefer key-only/status-only commands for env and variable inspection.
- Broad operator credentials are convenient but not acceptable as the final security posture.
- CLI behavior can change across versions; pinning or documenting tested versions matters for repeatability.
- A CLI-first lane does not by itself solve split runtime ownership between EC2 and Railway workers.

## Non-goals

- Do not delete non-GitHub MCP/native integrations only because a CLI exists.
- Do not expose every MCP tool as direct top-level Pi tools by default.
- Do not make EC2 secret storage canonical. Durable secret truth belongs in the approved secret manager / Railway variables / future AWS secret store, not checked-in files or docs.
- Do not treat a successful CLI setup as permission to deploy, restart, merge, or rotate secrets without current explicit approval.

## Follow-ups

1. Create or update repo skills for CLI-first workflows:
   - GitHub PR / issue workflow via `gh`
   - Railway status/logs/variables workflow via `railway`
   - EC2 repo-sync and validation workflow
2. Rotate the temporary operator-bootstrap GitHub/Railway credentials to least-privilege machine/service credentials.
3. Reconcile EC2 repo drift before relying on it for implementation work.
4. Decide and document the production worker owner: EC2 or Railway, but not both live for the same Socket Mode app.
5. Add retention/backup rules for `/home/ubuntu/.pi/agent`, generated artifacts, and EC2 journald logs.
