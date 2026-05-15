> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Decision: shared Pi execution host (EC2) vs `covent-aws-operator` as a bounded tool

**Type**: `decision`
**Source**: 2026-05-12 strategy conversation following the first-principles audits; PR #24 known-follow-up ("Wire covent-aws-operator so the plain-route bash lands on the EC2 instance instead of the Railway container's /root").
**Surface**: today — `apps/pi-mom/lib/pi-sdk-runner.mjs` (`PI_WORKDIR` resolution, `bash` tool target); `packages/pi-ext-covent-aws/` (currently scaffolded, not wired); `apps/pi-mom/control-plane/registry.yaml` (route → tools allowlist); Railway services `covent-pi-mom` + `covent-pi-mom-v2`. Future — possibly a long-lived EC2 instance under Covent's AWS account.
**Risk**: High decision (blast radius + ops surface), low cost of deciding. **Discussion-first. No code lands until each sub-decision is made and Issue #31 (plain-route blast radius) is resolved.**
**Dependency**: This decision **must not** ship before [Issue #31](https://github.com/goose4500/covent-agent-os/issues/31) resolves. Widening the execution host's blast radius before tightening the plain-route gate amplifies risk in the wrong direction.

## Context

The 24h audit and the first-principles audits established that today every Pi run executes inside the bot's Railway container:

- `cwd` defaults to `process.env.PI_WORKDIR || process.env.HOME || process.cwd()` (`apps/pi-mom/lib/pi-sdk-runner.mjs:96`) — on Railway that's `/root` inside the disposable container.
- The `plain` and `bash` routes activate the SDK's `bash` tool (`apps/pi-mom/control-plane/registry.yaml:62-65,101-104`), which executes on the container.
- The container has no AWS credentials, no SSH keys to other hosts, no source code beyond the bot itself, and is rebuilt on every deploy.

A natural next thought — and one PR #24's follow-up section explicitly flagged — is to point Pi at Covent's shared EC2 instance instead, so that every Pi agent across the organization works off the same machine: shared checkouts, shared state, shared AWS credentials, one place to look at logs. The intuition is "more leverage from one canonical host."

This issue exists because that intuition is **not obviously correct**, and the decision is one-way enough (security boundary changes, IAM provisioning, operational ownership of a new long-lived host) to deserve a deliberate framework rather than a drive-by config change.

## Why this is a decision, not an obvious win

Three first-principles concerns argue against a naïve "put all Pi agents on shared EC2":

### 1. Trades isolation for contention

Today each Pi run is isolated by container boundary: independent `cwd`, independent process tree, independent `npm/bun install` state, independent secrets fileystem. Concurrency is bounded by Railway replicas; one runaway `bash` cannot starve another user's run.

On a single shared EC2 box:
- Concurrent `git checkout` / `bun install` / file-write operations race on the same working directory unless we add a per-run worktree layer.
- A runaway tool call (Pi compiles a large project, runs `find /`, etc.) saturates CPU/RAM for every concurrent user.
- Approval modals on dangerous commands serialize the queue.
- One agent's mistake (`mv` over a sibling's worktree) is now an organizational incident.

The fix patterns — per-run worktrees with lockfiles, fair-share scheduling, isolated tmp dirs, audit trails — end up reconstructing the isolation the platform was giving us for free, minus the platform's enforcement.

### 2. Blast radius gets meaningfully worse

[Issue #31](https://github.com/goose4500/covent-agent-os/issues/31)'s plain-route audit established that today's `plain` route already activates `[bash, read, grep, find, edit, write]` on bare `@Covent-Agent` mentions, gated only by:

- `SLACK_ALLOWED_CHANNEL_ID` (channel allowlist)
- `permission-gate`'s 3 regex patterns (`rm -rf` / `sudo` / `chmod|chown 777`)

On Railway today, the host is disposable: ephemeral filesystem, no AWS credentials, no source code worth stealing, no SSH keys to lateral into anything. A compromise is recoverable by `railway redeploy`.

On a long-lived shared EC2 box with:
- Persistent filesystem holding work-in-progress from every agent
- `~/.aws/credentials` or an instance IAM role (otherwise why is it on EC2?)
- Source checkouts of multiple repos
- SSH keys to other infrastructure
- Production database access (or paths to it)

…the same compromise path becomes a real incident with real recovery cost. Widening the execution host's blast radius **before** the plain-route gate decision lands is the wrong sequencing.

### 3. "Shared host" may be solving the wrong problem

Several distinct underlying needs converge on "put Pi on EC2", but they each have different optimal solutions. Pre-selecting "shared EC2 as the host" forecloses better answers.

## Underlying needs (the actual question to answer first)

Before picking an option below, the team needs to enumerate **what problem(s) "Pi on shared EC2" is solving**. Best-guess candidates:

- **N1. Agents need to share state / artifacts / checkouts across runs.** ("Pi should see the same `~/code/covent-billing` worktree no matter which user mentioned it.")
- **N2. Agents need scoped AWS access.** ("Pi should be able to query CloudWatch, restart an ECS service, read a Parameter Store secret.")
- **N3. Agents need to operate *on* the EC2 instance itself.** ("Pi should be able to SSH-ish-but-via-itself into the box and run `systemctl status` / `journalctl -u foo`.")
- **N4. Agents are slow because they cold-start.** ("Every run reclones / re-installs / re-warms; we want a long-lived workspace.")
- **N5. Operational visibility.** ("One place to look at logs, one process tree to inspect, one filesystem to grep.")
- **N6. Cost.** ("Running N Railway replicas with bash + ripgrep + etc. is wasteful; one EC2 box is cheaper.")

Each of these has a different best-fit answer — see the options table.

## Options

### A. Status quo — Pi runs on Railway, no shared host

Bot executes `bash` on the Railway container's `/root`. No persistent state. No AWS access. Disposable.

- **Solves**: nothing of N1–N6.
- **Costs**: nothing new.
- **Best for**: continuing to use Pi as a draft / advisory / pure-text agent. The plain route's `bash` is "Pi can run commands on its own host" — useful for self-introspection, useless for company infra.

### B. Shared EC2 as the Pi execution host (the proposal)

`PI_WORKDIR` points at a path on a long-lived EC2 box. All Pi runs across the org execute there. Bot still on Railway; runs forwarded via SSH-exec or a thin runner agent on EC2.

- **Solves**: N1 (sort of — needs per-run worktree discipline), N3, N5.
- **Doesn't solve well**: N2 (you get *one* IAM role for all agents; can't per-user scope), N4 (depending on how worktrees are managed, can still cold-start), N6 (probably more expensive than Railway at low load, cheaper at high load).
- **Costs**: new long-lived host to maintain; new SSH/IAM boundary; new failure mode (EC2 down → all agents down); blast radius widens dramatically (see concern #2 above); concurrency contention (see concern #1 above).
- **Best for**: organizations with **few** agents (so contention isn't real) running **trusted** prompts (so blast radius isn't real). Covent today may qualify on both — but the gate decision in #31 has to land first.

### C. `covent-aws-operator` as a bounded Pi custom tool (host stays Railway)

Extend `packages/pi-ext-covent-aws/` to register Pi custom tools (`aws_describe`, `aws_logs_tail`, `ec2_run_shell`, `ssm_send_command`, etc.) that **call AWS APIs from the Railway container** using a scoped IAM role. The execution still happens on the Railway container; the tool *targets* AWS resources by API, not by SSH.

- **Solves**: N2 (scoped IAM, per-tool capability gates, audit trail via CloudTrail), N3 (via SSM `send-command` to an EC2 instance — Pi never logs in interactively, just sends bounded commands), N5 (CloudWatch logs are the natural visibility surface).
- **Doesn't solve**: N1 (no shared workspace — each run still has Railway-disposable `cwd`), N4 (no warm host).
- **Costs**: needs IAM role design (OIDC or static), needs tool surface design (which AWS verbs are exposed?), needs registry.yaml route entries for AWS-touching routes (`aws:`, `ops:`).
- **Best for**: making Pi useful **on** company infra without making Pi the bouncer in front of company infra. This is the audit's recommendation if N2/N3/N5 are the dominant needs.

### D. Hybrid — Pi on Railway for drafting; bounded EC2 dispatch for execution

`plain`, `spec`, `linear`, `summarize` stay on Railway exactly as today. A new explicit `ec2:` or `mutate:` route dispatches a single command through SSM `send-command` (option C's primitive) to the shared EC2 box. Slack approval modal gates every dispatch.

- **Solves**: all of N2, N3, N5 with strong audit + gating. Partially N1 if the EC2 box keeps a shared worktree the dispatch can target.
- **Doesn't solve**: N4 in the general case.
- **Costs**: same as C, plus one new route + a small amount of dispatch wiring. Slightly more cognitive overhead for users ("when do I use `ec2:`?").
- **Best for**: most likely the right answer if the team wants both Pi-as-draft-agent (Railway, ephemeral, cheap) and Pi-as-ops-agent (EC2-targeted, audited, gated).

### E. Per-team / per-user isolated EC2 worktrees with a queue

A pool of EC2 instances (or per-user EC2 spot/Fargate tasks) each provisioned with that user's IAM scope and worktree. Pi runs are routed to the appropriate instance based on Slack user identity.

- **Solves**: all of N1–N6 with strong isolation.
- **Costs**: significant. Per-user provisioning, identity mapping, idle-cleanup, billing.
- **Best for**: a Covent of 20+ engineers using Pi heavily on isolated company workloads. Premature today.

## Decision criteria

When picking an option, weigh in this order:

1. **Underlying need**: which of N1–N6 are dominant *today*? If primarily N2/N3/N5, the answer is C or D. If primarily N1/N4, B is plausible but only after #31. If unclear, more discovery before deciding.
2. **Blast radius vs Issue #31**: do not widen execution surface before tightening the plain-route gate. C and D are compatible with #31 either way; B requires #31 = option C (modal-gate every `bash`) or stricter.
3. **Concurrency reality**: how many concurrent Pi runs do we expect at peak? Under ~5 concurrent, contention is theoretical. Above ~20 concurrent, B becomes operationally hard without queueing.
4. **Operational ownership**: who maintains the shared host? B/D/E all add an EC2 box (or pool) to the on-call rotation. Today nobody owns a long-lived agent host because there isn't one.
5. **Recoverability**: how do we recover from "the agent host is in a weird state" or "an agent corrupted a shared worktree"? Railway's answer is `railway redeploy`. EC2's answer is more deliberate.
6. **Auditability**: every action through C/D produces CloudTrail entries; B's `bash` output is a Slack message and that's the audit surface. CloudTrail wins.

## Recommended path (mine, defensible — not a unilateral pick)

1. **Block on Issue #31 first.** Until plain-route blast radius is decided, this issue is undecidable on its merits.
2. **Have a 30-minute meeting (or async write-up) to identify which of N1–N6 are real.** Write down the top two with concrete examples (e.g. "Pi should answer 'why did the prod billing job fail this morning' by reading CloudWatch logs" — that's N2/N5).
3. **Default to option C (operator-as-tool)** for any N2/N3/N5 need, *because* it stays compatible with #31's gate decision, it produces CloudTrail audit trails for free, and it does not introduce a new long-lived host.
4. **Add option D (`ec2:` route)** if/when N3 becomes a recurring pattern (more than ~2 distinct "I need to operate on the box" stories per week).
5. **Treat option B (shared host) as a YAGNI** until the contention math from criterion #3 actually pencils out. Most teams discover that what they thought they wanted from "shared host" was actually 2-3 specific N2/N3 capabilities that C handles cleanly.

## Sub-deliverables (the decision pipeline)

### Phase 1 — Discovery (~1 day, no code)
- [ ] Enumerate the **top 3 real-world Pi use cases** that "shared EC2" would unlock that today's setup can't. Write them as Slack-message examples ("user types: `…`; today: fails; with EC2: succeeds because: `…`").
- [ ] Map each use case to one of N1–N6.
- [ ] Confirm Issue #31's plain-route blast radius decision has shipped (or block until it does).

### Phase 2 — Option selection (~30 min meeting + write-up)
- [ ] Pick **A / B / C / D / E** (or define F) with explicit rationale tied to the use cases from Phase 1.
- [ ] Document the choice in `docs/specs/pi-execution-host-policy.md`. Include: what we picked, what we did *not* pick, why, what would change our mind.

### Phase 3 — Implementation (only after Phase 2)

**If C (operator-as-tool):**
- [ ] Design IAM role for the Pi runner: minimal verbs needed for the Phase-1 use cases. Prefer OIDC role assumption (Railway → AWS) over static keys.
- [ ] Extend `packages/pi-ext-covent-aws/src/index.ts` to register the AWS custom tools as `ToolDefinition`s (depends on Issue #27's `customTools` conversion landing first — same pattern as `linear-tools.ts`).
- [ ] Add an `aws:` route to `apps/pi-mom/control-plane/registry.yaml` with `tools: [aws_describe, aws_logs_tail, ssm_send_command, ...]` and `approvals: tool` if any tool can mutate state.
- [ ] Wire the IAM creds into Railway env (`AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE` for OIDC, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` as fallback).
- [ ] Update `apps/pi-mom/doctor.mjs` to verify AWS auth at boot when any AWS-touching route is enabled.

**If D (hybrid with `ec2:` route):**
- [ ] All of C, plus:
- [ ] Provision a long-lived EC2 instance with the SSM agent installed; tag it `covent-pi-ops-target` or similar.
- [ ] Add `ec2:` route with `tools: [ssm_send_command]` and `approvals: tool` (every dispatch hits the Slack approval modal).
- [ ] Set up CloudWatch log group for SSM command output; pipe back into the Slack thread via the existing slack-sink pattern.
- [ ] Document the threat model: which IAM role can do what; what happens if the SSM agent is compromised; what's the recovery plan.

**If B (shared host):**
- [ ] **Confirm Issue #31 resolved as option C or stricter** (modal-gate every `bash`).
- [ ] Provision the EC2 box; document base AMI + bootstrap.
- [ ] Add a per-run worktree layer (`/data/pi-workspaces/<requestId>/`) so concurrent runs don't race.
- [ ] Add SSH or SSM exec path from Railway → EC2; gate every exec through `permission-gate` on the dispatch side, not just the AWK side.
- [ ] Decide the IAM/secrets boundary: does the box hold company AWS creds? SSH keys? Database access? Write each one down explicitly in `BOUNDARY.md`.
- [ ] On-call ownership: who pages when the box is down? What's the SLA?
- [ ] Set up audit logging that's better than "Slack thread history" — at minimum a per-run command log on the host.

**If E (per-user pools):**
- [ ] Out of scope for this issue. Open a separate issue if Phase 1 surfaces evidence this is needed at our scale.

## Acceptance criteria

- [ ] Phase 1 discovery write-up exists; top 3 use cases enumerated; each mapped to N1–N6.
- [ ] Issue #31 closed before this issue moves past Phase 1.
- [ ] Phase 2 decision documented in `docs/specs/pi-execution-host-policy.md`, referenced from `BOUNDARY.md`.
- [ ] If Phase 3 ships: `bun run check` green; live canary on `covent-pi-mom-v2`; runbook entry in `docs/runbooks/` capturing the new threat model + recovery procedure.
- [ ] This issue references whichever Phase-3 implementation issue(s) get spawned, and is closed when the policy doc + (if applicable) Phase 3 land.

## Out of scope

- Implementation of any option without Phase 1 + Phase 2 done first. This is a decisions issue.
- Per-user pools (option E) at this stage — premature for current team size.
- Replacing Railway as the bot host. Even under B/D, Bolt's Socket Mode bot stays on Railway; only `bash`-class tool execution shifts.
- Wider AWS observability story (Datadog, CloudWatch Insights dashboards, etc.). Adjacent but separate.

## Dependencies

- **Hard**: [Issue #31](https://github.com/goose4500/covent-agent-os/issues/31) — plain-route blast radius. Must resolve first.
- **Soft**: [Issue #27](https://github.com/goose4500/covent-agent-os/issues/27) — `customTools` array conversion. Makes option C cleaner because `pi-ext-covent-aws` would follow the same shape as `linear-tools.ts` (post-#27).
- **Soft**: [Issue #29](https://github.com/goose4500/covent-agent-os/issues/29) — Block Kit actions row. Option D's `ec2:` route benefits from a "Re-run on EC2" button on the final-message actions row.

## References

- 24h audit: `docs/research/2026-05-12/audit-24h.md` (concrete follow-ups section: "Wire covent-aws-operator so the plain-route bash lands on the EC2 instance instead of the Railway container's /root").
- PR #24 body: known-follow-ups section.
- `apps/pi-mom/lib/pi-sdk-runner.mjs:96` — `PI_WORKDIR` resolution.
- `apps/pi-mom/control-plane/registry.yaml:62-65,101-104` — `plain` + `bash` route tool wiring.
- `packages/pi-ext-covent-aws/` — scaffolded but not wired into the runner today.
- `BOUNDARY.md` — threat-model document where this decision's policy belongs.
- AWS SSM `send-command`: https://docs.aws.amazon.com/systems-manager/latest/userguide/execute-remote-commands.html (for option C/D's primitive).
- AWS IAM OIDC for Railway: standard pattern; Railway → AWS via `sts:AssumeRoleWithWebIdentity`.

## Cohort

This is the 6th issue in the 2026-05-12 audit cohort. See also:
- [#27](https://github.com/goose4500/covent-agent-os/issues/27) Pi harness cleanup (`cleanup`)
- [#28](https://github.com/goose4500/covent-agent-os/issues/28) Slack surface cleanup (`cleanup`)
- [#29](https://github.com/goose4500/covent-agent-os/issues/29) Block Kit UX (`ux`)
- [#30](https://github.com/goose4500/covent-agent-os/issues/30) Operational hygiene (`operational`)
- [#31](https://github.com/goose4500/covent-agent-os/issues/31) Decisions: plain-route blast radius, retire /thread-spec, dependabot triage (`decision`) — **prerequisite for this issue**
