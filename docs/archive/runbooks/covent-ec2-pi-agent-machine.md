> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Covent EC2 Pi Agent Machine

Status: POC source-of-truth runbook  
Related Linear parent: FE-460 — Slack App  
Related child issue: FE-532 — Stand up company EC2 Pi Agent machine for guarded POC execution  
Last updated: 2026-05-08

## Purpose

This document defines the fundamentals-first POC for using company AWS EC2 as the Covent Pi Agent OS execution surface.

The goal is not “move a Slack bot to a server.” The goal is to create a shared, controllable Linux execution layer where Covent Pi agents can safely use shell, filesystem, repo context, and future tools while Slack, Linear, GitHub, and repo docs remain the durable sources of truth.

## Core thesis

```text
Slack = cockpit / trigger / progress surface
Pi = reasoning + execution harness
EC2 = shared agent machine / runtime workbench
Linear = execution truth
GitHub = implementation truth
Repo docs = canonical system truth
AWS secret/artifact services = runtime durability layer
```

EC2 is leverage because Pi agents need a real operating environment: bash, filesystem, packages, repo checkouts, generated artifacts, logs, and eventually browser/runtime services. Railway is still useful as a managed app host, but EC2 is the better substrate for a shared company agent machine.

## Current known EC2 baseline

Non-secret inspection from 2026-05-08:

```text
Host: ec2-3-91-93-235.compute-1.amazonaws.com
Public IP: 3.91.93.235
OS: Ubuntu 24.04.4 LTS
Instance type: t3.small
Region/AZ: us-east-1d
CPU: 2 vCPU
RAM: ~1.9 GiB
Disk: ~6.8 GB root, ~4.9 GB free at inspection
SSH user: ubuntu
sudo: passwordless sudo available
Outbound internet: available
IAM instance role: none detected at inspection
```

Current limitations:

- `node`, `npm`, `pi`, `docker`, `pm2`, and `nginx` were not installed at inspection.
- Disk is small for long-term agent artifacts.
- No AWS IAM role was visible from instance metadata.
- No AWS-native secret/artifact/logging integration is configured yet.

## Source-of-truth rules

- Slack captures intent and approvals; it is not durable system memory.
- Pi drafts, reasons, and executes inside approved lanes; it is not authority.
- Linear owns executable work, status, owners, acceptance criteria, and follow-up.
- GitHub owns code and implementation history.
- Repo docs own canonical operating knowledge and runbooks.
- EC2 owns runtime execution state only; it must be rebuildable.
- Secrets Manager / SSM / approved secret store owns secret values; docs and Linear only name variables.
- S3 or approved artifact storage should own long-term artifacts once the POC hardens.

## Runtime lanes

### Lane A — Slack bridge lane

Purpose: run `apps/pi-mom` from EC2 for approved Slack routes.

Default posture:

```text
Slack app mention/slash command
  → pi-mom route parser
  → current thread context
  → Pi subprocess with --no-session --no-tools --no-extensions
  → Slack threaded reply
  → optional bridge-owned Linear issue creation for explicit linear route
```

Rules:

- Slack-originated routes stay no-tools/no-extensions by default.
- No arbitrary Slack-to-bash route in this POC.
- Slack/Linear env vars must remain stripped from child Pi subprocesses.
- `@Covent Pi create Linear issue` remains explicit write approval for the current MVP Linear route.
- Exactly one Socket Mode worker may be active during live tests; coordinate Railway/local/EC2 workers.

### Lane B — Supervised EC2 Pi operator lane

Purpose: allow a human-supervised operator to run Pi on EC2 with bash/filesystem access for bounded POC tasks.

Default posture:

```text
Human SSH/SSM session
  → cd approved repo/workspace
  → run Pi/tool-enabled workflow intentionally
  → produce checks/docs/diffs/artifacts
  → promote durable outputs to Git/Linear/repo docs
```

Rules:

- Human starts the session intentionally.
- Work occurs only in approved paths.
- No secret-bearing paths, `.env` files, raw Slack exports, browser profiles, cookies, or API keys are inspected/exported.
- External mutations require explicit current approval.
- Outputs become repo docs, Git diffs, Linear comments/issues, or approved artifacts — not hidden machine state.

## Proposed filesystem layout

```text
/srv/covent-agent-os/
  Canonical repo checkout for Covent Agent OS.

/srv/covent-agents/workspaces/
  Temporary per-task workspaces. Non-secret by default.

/srv/covent-agents/artifacts/
  Generated reports/specs/screenshots/images before promotion to durable storage.

/srv/covent-agents/logs/
  Runtime logs if not using journald/CloudWatch directly.
```

Do not commit runtime state, generated private artifacts, real `.env` files, logs, caches, or credentials.

## Secret model

Required secret names for pi-mom may include:

```text
SLACK_BOT_TOKEN
SLACK_APP_TOKEN
SLACK_ALLOWED_CHANNEL_ID
LINEAR_API_KEY
OPENAI_API_KEY or provider-specific key
```

Rules:

- Secret values must never be printed, pasted, committed, put in Linear, or stored in Slack messages.
- Verify secrets by presence/status only.
- Preferred production direction: AWS Secrets Manager or SSM Parameter Store + least-privilege EC2 IAM role.
- POC fallback may use locked-down env injection, but this must be documented and treated as temporary.

## Route and use-case registry

| Use case | Input | Tools | Approval | Output | Durable destination |
|---|---|---|---|---|---|
| Status/help | `@Covent Pi status:` / `help:` | Bridge only | Slack mention | Slack thread response | None unless follow-up needed |
| Spec draft | `@Covent Pi draft spec` / `spec:` | Pi no-tools | Slack mention | Slack draft | Promote decisions to Linear/docs |
| Digest/agenda/escalation | `digest:` / `agenda:` / `escalation:` | Pi no-tools | Slack mention | Slack draft | Promote actions to Linear/docs |
| Linear issue creation | `@Covent Pi create Linear issue` / `linear:` | Pi no-tools + bridge-owned Linear GraphQL | Explicit create phrase | Linear issue + Slack confirmation | Linear |
| Supervised repo diagnostics | Human EC2 Pi session | bash/read/write in approved workdir | Human current-task approval | checks, diffs, reports | Git/Linear/docs |
| Source-of-truth promotion | Human EC2 Pi session or Slack draft | read/write docs in repo | Human current-task approval | docs/ADRs/runbooks | Git/repo docs |
| Image route POC | `image:` | Bridge-owned OpenAI image client | Slack mention + route policy | Slack uploaded image | Approved artifact store if retained |
| Linear audit | Human/subagent task | Linear read tools; write only if approved | Human task approval | summary/report | Linear comment/docs |
| File/document analysis | Approved file in workspace | bash/read/write in approved workdir | Human task approval | sanitized report | docs/Linear/artifacts |

## Specialized Pi agent use cases to document, not blindly expose

These should exist as explicit bundles or documented playbooks before becoming Slack-callable workflows:

1. **Source-of-truth agent** — converts messy Slack/Linear/doc context into canonical docs, ADRs, and issue specs.
2. **Repo diagnostics agent** — runs checks/tests, inspects failures, drafts fixes, and records evidence.
3. **Linear auditor agent** — reads parent/child issue trees, summarizes status, blockers, and next actions.
4. **Spec/PRD agent** — turns Slack threads and rough ideas into implementation-ready specs.
5. **Image/artifact agent** — generates Covent visuals or assets with safe file handling and no base64/path leakage.
6. **Browser operator agent** — future high-risk lane; requires separate policy, evals, and approval gates before real profile or mutation use.
7. **Workflow orchestrator agent** — routes tasks to subagents/tools, asks for approval, returns evidence to Slack/Linear.
8. **Runbook/ops agent** — manages non-secret health checks, service status, logs, drift reports, and rollback instructions.

## AWS admin asks

Ask Ali/Usman/AWS admin for:

- Confirm EC2 owner, lifecycle owner, and intended account/project context.
- Increase disk to at least 30–50 GB if this becomes the agent machine.
- Confirm whether the public IP is Elastic/static.
- Keep inbound ports minimal; for Socket Mode only SSH is needed for operators.
- Prefer SSM Session Manager or controlled SSH for access.
- Attach a least-privilege IAM role for required secret retrieval, S3 artifact access, and CloudWatch logging.
- Create/approve AWS Secrets Manager or SSM Parameter Store path for Slack/Linear/OpenAI/provider secrets.
- Create/approve S3 bucket for durable agent artifacts.
- Configure EBS snapshots/backups and patching expectations.
- Define log retention/redaction policy.

## POC acceptance criteria

- [ ] EC2 target and ownership documented without secrets.
- [ ] Runtime basics installed and verified: Git, Node/npm, Pi CLI, repo dependencies.
- [ ] Repo checkout exists at approved path and local state is excluded from Git.
- [ ] `npm run secret-scan`, `npm run check`, and `npm run doctor:pi-mom` pass where configured.
- [ ] Secret injection is approved and verified by presence only.
- [ ] `pi-mom` runs from EC2 in echo mode, then controlled pi mode.
- [ ] One-worker policy is verified before live Slack tests.
- [ ] Slack smoke passes for `status:`, one draft route, and optional explicit Linear issue creation.
- [ ] Supervised EC2 Pi operator session demonstrates safe bash/filesystem access in an approved non-secret workspace.
- [ ] POC use cases are documented with input, tools, approval, output, and source-of-truth destination.
- [ ] Rollback path is documented and tested enough to stop EC2 worker and return to Railway/local known-good path.

## Rollback

1. Stop EC2 `pi-mom` service or session.
2. Confirm no duplicate Socket Mode worker remains.
3. Disable/revoke EC2 env injection if compromised.
4. Return Slack bridge operation to known-good Railway/local path.
5. Document incident/follow-up in Linear without secrets.

## Open decisions

- Should EC2 replace Railway for `pi-mom`, or run beside it during controlled tests only?
- Which Slack channels are approved for EC2-hosted tests?
- Which POC use cases require tool-enabled Pi versus no-tool Slack synthesis?
- Which AWS secret store and artifact store are approved?
- What is the first specialized agent bundle to prove after the Slack bridge migration?
