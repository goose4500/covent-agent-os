# Linear Integration — Agent Plan

Status: execution plan for the agent lifecycle implementing the Linear PRD
Owner: orchestrator session
PRD: `docs/source-of-truth/LINEAR_INTEGRATION_PRD.md`
Branch: `claude/find-linear-integration-aKrUS`

## Lifecycle

Five roles, five waves. Roles describe responsibility; waves describe ordering.

### Roles

- **Scouts** — read-only reconnaissance. Map call sites, env, docs, history. Output: a punch-list and a baseline snapshot. No code changes.
- **R&D** — small targeted spikes that verify the PRD's assumptions before we build. Output: confirmation or PRD revisions. Spikes happen in throwaway worktrees; nothing lands on the working branch.
- **Workers** — implementation. Land code on the working branch. Conventional Commits, one logical change per commit.
- **QA** — exercises the integration. Unit + integration tests + `npm run check`. Output: pass/fail with evidence.
- **Verifiers** — independent review against the PRD, commit hygiene, PR description, doc coverage. Output: punch-list of drift.

### Wave ordering

```
Wave 1 — Scouts (parallel, read-only)
  S1: codebase scout   — every file touching Linear, every env var, every test
  S2: docs scout       — every doc that names Linear; lists required updates
  S3: history scout    — prior Linear commits, prior ADR context, prior PRs

       ↓ orchestrator converges, may revise PRD ↓

Wave 2 — R&D (parallel, throwaway worktrees)
  R1: SDK shape spike       — @linear/sdk install probe, minimal call shapes
  R2: idempotency spike     — confirm attachmentCreate(url=...) upsert semantics
  R3: webhook signature spike — verify HMAC-SHA256 scheme against a synthetic payload

       ↓ orchestrator converges, may revise PRD ↓

Wave 3 — Workers
  W0 (blocking): scaffold packages/linear-client (package.json, tsconfig, types)

       ↓ then parallel ↓
  W-A: client modules (issues, comments, states, attachments, webhooks,
                       rate-limit, pagination, identifiers, errors, trace)
  W-B: /webhooks/linear receiver inside apps/pi-mom (separate HTTP port)
  W-C: refactor apps/pi-mom call sites to use the client; remove inline GraphQL
       (depends on W-A's issues/states APIs being merged-or-in-tree)
  W-D: docs (spec, runbook, ADRs, SYSTEM_INDEX/AGENT_CONTEXT/BOUNDARY/SECURITY/
            SKILL/README updates)

       ↓ converge ↓

Wave 4 — QA (parallel)
  Q1: npm run check green
  Q2: idempotency replay (same Slack permalink → same Linear issue, 3 attempts)
  Q3: webhook fixtures (valid / tampered / replay >60s)
  Q4: rate-limit middleware (mocked headers at boundary)

       ↓ converge ↓

Wave 5 — Verifiers (parallel, read-only)
  V1: code review against PRD principles 1–12
  V2: doc coverage review
  V3: commit message + PR description audit
```

Parallelism summary:
- Wave 1: 3 in parallel.
- Wave 2: 3 in parallel.
- Wave 3: W0 first, then W-A / W-B / W-D in parallel, W-C joins as soon as W-A's issues/states modules are landed.
- Wave 4: 4 in parallel.
- Wave 5: 3 in parallel.

Sequential dependencies that cannot collapse:
- Scouts → R&D (R&D needs the baseline).
- R&D → Workers (Workers need the verified design).
- W0 → W-A → W-C (call sites need the client API stable).
- Workers → QA (QA tests the built artifact).
- QA → Verifiers (Verifiers review the QA-passing state).

## Per-agent specifications

Each spec defines: charter, allowed actions, inputs, outputs, success criteria. The orchestrator instantiates one agent per spec, parameterized with the relevant scope.

### S1 — Codebase Scout
- Charter: produce a punch-list of every file in the repo that touches Linear, with line refs and a one-line role description per file.
- Allowed: read, grep, find. No edits.
- Inputs: repo root.
- Outputs: a single Markdown report with file:line refs, env var inventory, current default IDs, and a list of every call site that imports or `fetch`es Linear.
- Success: report covers `apps/`, `packages/`, `lib/`, `extensions/`, `skills/`, `agents/`, `prompts/`, `scripts/`, `docs/`, root files. Nothing missed.

### S2 — Docs Scout
- Charter: list every doc, skill, agent, and config file that mentions Linear and specify the precise update required to align with the new PRD.
- Allowed: read only.
- Inputs: PRD path + repo root.
- Outputs: a table of {file, current statement, required update, urgency}.
- Success: each row links to a PRD principle.

### S3 — History Scout
- Charter: surface prior Linear-related commits, ADRs, and any historical context that constrains the design.
- Allowed: `git log`, `git show`, read.
- Inputs: repo root.
- Outputs: chronological list of Linear-related commits with one-line takeaways, plus any ADR/doc context that pre-decides something.
- Success: includes `113c563`, `c5fd843`, ADR 0002, and anything else found.

### R1 — SDK Shape Spike
- Charter: confirm `@linear/sdk` installs cleanly, types resolve under our `tsconfig.json`, and the minimum call shape compiles. Verify Node 22 compatibility.
- Allowed: throwaway worktree, install packages, write tiny probe files. Discard worktree at end.
- Inputs: nothing.
- Outputs: a 1-page report — install command, version, types-OK flag, minimal `viewer.id` call snippet, and any landmines.
- Success: zero changes leak to the working branch.

### R2 — Idempotency Spike
- Charter: verify Linear's `attachmentCreate` semantics — confirm that re-posting the same `url` for the same `issueId` upserts rather than duplicates. If real API access not available, validate by re-reading docs and producing a deterministic test plan we can run later.
- Allowed: read docs, optional real API call if `LINEAR_API_KEY` is in env. No code commits.
- Inputs: PRD principle 4.
- Outputs: confirmed-or-revised idempotency strategy; if attachment upsert is unreliable, propose the fallback (search by Slack-permalink-in-description before create).
- Success: PRD principle 4 either confirmed or revised with concrete evidence.

### R3 — Webhook Signature Spike
- Charter: confirm Linear's HMAC-SHA256 signature scheme against a synthetic payload + secret. Produce the exact constants and the timing-safe comparison the implementation will use.
- Allowed: read docs, write a throwaway script that computes a signature for a known payload.
- Inputs: PRD principle 9.
- Outputs: a code snippet for `verifyWebhook(rawBody, signature, secret, timestamp)` and fixture data for tests.
- Success: a 5-line snippet that we can drop into `packages/linear-client/src/webhooks.ts`.

### W0 — Package Scaffold
- Charter: scaffold `packages/linear-client` (package.json with `@linear/sdk` dep, tsconfig extending root, empty modules with stubbed exports). Wire into root workspaces.
- Allowed: write code, install dep, run `tsc --noEmit`.
- Inputs: PRD + agent plan.
- Outputs: a single commit `feat(linear-client): scaffold packages/linear-client` that passes `npm run check`.
- Success: `tsc --noEmit` green; root `package.json` `workspaces` updated; no behavior changes elsewhere.

### W-A — Client Modules
- Charter: implement the public surface described in the PRD ("What we build" → `packages/linear-client`).
- Allowed: write code in `packages/linear-client/**` and `packages/linear-client/tests/**`. No edits to `apps/`.
- Inputs: PRD; R1/R2/R3 outputs.
- Outputs: a small number of well-named commits per module. Each commit independently passes `tsc --noEmit`.
- Success: every public function in the PRD's illustrative surface is implemented, typed, and unit-tested.

### W-B — Webhook Receiver
- Charter: add a separate HTTP listener on `LINEAR_WEBHOOK_PORT` (default `3001`) at `/webhooks/linear` inside `apps/pi-mom`. Verify signature via the client; trace via existing `trace()`; dispatch by `type+action`; respond 2xx fast.
- Allowed: edits in `apps/pi-mom/index.mjs` and `apps/pi-mom/README.md`. Add an env var doc to `.env.example` / `.env.railway.example`.
- Inputs: PRD principles 9, 10; W-A's `webhooks.verify`.
- Outputs: `feat(pi-mom): add /webhooks/linear receiver`. Bolt's Socket Mode untouched.
- Success: receiver returns 401 for invalid signature, 400 for replay >60s, 200 for valid; structured trace emitted.

### W-C — Pi-mom Refactor
- Charter: replace inline `fetch`/`issueCreate` block (`apps/pi-mom/index.mjs:329-393`) with `linear.issues.upsertFromSlack`. Remove `LINEAR_API_URL`, `LINEAR_STATE_ID`. Resolve state by name (`LINEAR_DEFAULT_STATE_NAME`, default `Backlog`).
- Allowed: edits in `apps/pi-mom/index.mjs`, `apps/pi-mom/doctor.mjs`, `.env.example`, `.env.railway.example`. No edits to `packages/linear-client`.
- Inputs: PRD; W-A's `issues` + `workflow-states` modules.
- Outputs: `refactor(pi-mom): use @covent/linear-client for issue creation`.
- Success: zero behavior regression in the Slack → Linear path; idempotency now works (re-run produces no duplicates).

### W-D — Docs
- Charter: write `docs/specs/linear-client-spec.md`, `docs/runbooks/linear-webhook-setup.md`, `docs/adr/0005-linear-client-library.md`, `docs/adr/0006-linear-webhooks-colocated-with-pi-mom.md`. Update `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `BOUNDARY.md`, `SECURITY.md`, `skills/linear-covent/SKILL.md`, `apps/pi-mom/README.md` to reference the PRD and new client.
- Allowed: edits only in `docs/`, `skills/`, `apps/pi-mom/README.md`, root `BOUNDARY.md` and `SECURITY.md`. No code edits.
- Inputs: PRD; W-A surface; W-B endpoint contract.
- Outputs: `docs(linear): add client spec, webhook runbook, ADRs, and cross-references`.
- Success: every Linear-touching doc references the PRD by path.

### Q1 — Repo Check
- Charter: run `npm run check` and report.
- Allowed: bash.
- Inputs: branch HEAD.
- Outputs: pass/fail with the failing step quoted verbatim.

### Q2 — Idempotency Test
- Charter: write/execute a test that runs `linear.issues.upsertFromSlack` three times with the same Slack permalink and asserts a single issue exists. May mock Linear if real API isn't available.
- Allowed: write tests in `packages/linear-client/tests/**`.
- Outputs: a test file + a `test(linear-client): idempotency replay` commit.

### Q3 — Webhook Fixture Test
- Charter: tests for `verifyWebhook` covering valid signature, tampered body, tampered signature, replay >60s, missing header.
- Allowed: write tests in `packages/linear-client/tests/**`; reuse R3 fixtures.
- Outputs: `test(linear-client): webhook signature fixtures`.

### Q4 — Rate-Limit Middleware Test
- Charter: test `withRateLimitGuard` against mocked responses with `X-RateLimit-*` headers; assert throttling fires under threshold and emits a trace.
- Allowed: write tests in `packages/linear-client/tests/**`.
- Outputs: `test(linear-client): rate-limit guard`.

### V1 — Code Review
- Charter: independent review of every diff on the branch against PRD principles 1–12. Read-only.
- Allowed: read, grep, git diff.
- Outputs: a punch-list per principle (pass / drift / risk) with file:line evidence.

### V2 — Doc Coverage Review
- Charter: verify every doc deliverable in the PRD exists and references the PRD. Verify no stale Linear claims remain elsewhere.
- Allowed: read.
- Outputs: a coverage table.

### V3 — Commit & PR Audit
- Charter: verify Conventional Commits, one logical change per commit, no secrets in commit messages, PR description matches the template in the PRD.
- Allowed: `git log`, read.
- Outputs: per-commit pass/fail; PR description gap list.

## Wave 2 outcomes (verified facts)

Output of R1/R2/R3, locked in for Wave 3 implementation. Anything below contradicting prior notes is the latest truth.

**R1 — SDK shape (PASS):**
- Pin `@linear/sdk@84.0.0`. Tiny dep footprint (only `@graphql-typed-document-node/core`). Dual ESM/CJS with `"type": "module"`.
- Compiles green under Node 22 + TS 5.9 + `module: NodeNext` + `strict: true`.
- Corrections to the original research:
  - The thrown class is `UserLinearError`, not `UserError`. `UserError` is a GraphQL payload type (mutation `userErrors[]`). All thrown subclasses extend `LinearError`: `AuthenticationLinearError`, `InvalidInputLinearError`, `FeatureNotAccessibleLinearError`, `RatelimitedLinearError`, `NetworkLinearError`, `ForbiddenLinearError`, `BootstrapLinearError`, `GraphqlLinearError`, `InternalLinearError`, `LockTimeoutLinearError`, `OtherLinearError`, `UnknownLinearError`, `UsageLimitExceededLinearError`, `UserLinearError`.
  - `client.viewer` is a property accessor, not a method (no parens).
  - `client.issue("FE-123")` accepts both UUID and human identifier with one `string` overload — no separate `issueByIdentifier` path.

**R2 — Idempotency (Strategy B):**
- Linear's docs explicitly state `attachment.url` is the per-issue idempotency key. Quote: *"Attachment URL is used as an idempotent value if used in conjunction with the same issue id."*
- Workspace-global lookup: `client.attachmentsForURL(slackPermalink)` returns `{ nodes: { id, issue: { id, identifier, ... } } }`.
- Canonical create path:
  1. `attachmentsForURL(slackPermalink)` → if any non-archived hit, return its issue.
  2. Else `createIssue(...)` → then `createAttachment({ issueId, url: slackPermalink, title: "Slack thread", subtitle: "Covent Pi request <id>" })`.
- Resolved open questions for W-A:
  - Yes, also append the Slack permalink to the issue description (belt-and-braces, cheap, helps humans).
  - If `attachmentsForURL` does not surface `archivedAt`, accept one extra `client.issue(id)` round-trip on cold hit.
  - v1 policy: archived hit → ignore and re-create.
- Known v1 limitation: two concurrent pi-mom replicas with the same permalink can race. pi-mom is a single Railway service today; mitigation deferred. Trace `linear.dedupe.multiple_matches` if `attachmentsForURL` returns >1 node.

**R3 — Webhook signature (verified):**
- Header: `Linear-Signature` (lowercase hex HMAC-SHA256).
- Body bytes signed: raw, unparsed.
- Timestamp: JSON body field `webhookTimestamp`, UNIX **milliseconds**, no header counterpart.
- Replay window: 60s.
- No documented `Linear-Signature-Previous` header — rotation done via two env vars tried in turn at the verifier boundary.
- `WebhookVerificationError` codes: `missing_signature` | `invalid_signature` | `replay_expired` | `malformed_payload`.
- Critical W-B requirement: capture raw body via `bodyParser.raw({ type: "application/json" })` (or `express.json({ verify })`) BEFORE any JSON middleware. Express's `express.json()` consumes the stream.
- Node `IncomingMessage.headers` lowercases keys → read `req.headers["linear-signature"]`.
- Test fixtures with HMAC computed via both Node and openssl (matching) are in R3's report and will be reproduced in `packages/linear-client/tests/fixtures/`.

**Orchestration note:** even though W-A / W-B / W-D have disjoint file scopes, the single working tree means a single git writer at a time. Workers run **serially** (not parallel) in the live execution. The wave structure remains the unit of progress; within Wave 3, dispatch order is W0 → W-A → W-D → W-B → W-C. QA and Verifiers stay parallel within their waves.

## Orchestrator (this session) duties

- Launch each wave; wait for completion (no polling).
- Synthesize outputs into PRD revisions when warranted.
- Decide when to commit. Default cadence: one commit at the end of each Worker subtask; one summary push after Wave 5 passes.
- Surface blockers to the user (5-person team owner) before destructive or hard-to-reverse actions.
- Never bypass `npm run check`.
