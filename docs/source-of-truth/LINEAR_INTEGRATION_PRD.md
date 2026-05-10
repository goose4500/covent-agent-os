# Linear Integration — Source of Truth

Status: canonical for Linear integration scope, boundaries, and execution rules
Owner: Covent Agent OS
Last updated: 2026-05-10
Branch of record: `claude/find-linear-integration-aKrUS`

## Why this exists

Linear is becoming a primary node in our agent workflows and a primary tool for PI agents the team launches. Today, Linear logic is scattered:

- ~70 lines of inline `fetch` / GraphQL inside `apps/pi-mom/index.mjs:329-393` that can only `issueCreate` against a hardcoded team/project/state.
- A policy guard at `extensions/linear-mcp-guard.ts` that gates an externally-provided Linear MCP server.
- Prompt-only guidance in `skills/linear-covent/`, `skills/linear-auditor/`, `skills/linear-subissue-audit/`.
- Config placeholder at `examples/mcp.example.json`.

There is no shared client, no idempotency, no webhook ingest, no typed surface for agents. This document is the canonical spec for fixing that. Anything that contradicts this document is wrong; update this document first, then the code.

## Scope

In scope:
- One typed Linear client library at `packages/linear-client`, used by `apps/pi-mom`, future workflow nodes, and PI agents the team launches.
- Idempotent issue creation from Slack threads.
- Webhook receiver at `/webhooks/linear` inside `apps/pi-mom`.
- Documentation: PRD, client spec, runbook, ADRs, plus updates to `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `BOUNDARY.md`, `SECURITY.md`, `skills/linear-covent/SKILL.md`, `apps/pi-mom/README.md`.
- Git/GitHub commit and PR conventions for Linear work.

Out of scope (deliberately deferred):
- OAuth and `actor=app` agent identities. Internal team of five; a single shared `LINEAR_API_KEY` is sufficient. Revisit when (a) external collaborators join, (b) we want agents to appear as distinct workspace members, or (c) we want to subscribe to `AgentSessionEvent`.
- Linear's Agents API (AgentSession / AgentActivity / 10s SLA). Blocked on OAuth.
- GraphQL subscriptions (Linear does not expose them).
- Polling reconciliation. Webhooks only.
- Anything requiring the `admin` scope.

## First principles

1. **One typed entrypoint.** All Linear calls go through `packages/linear-client`. No caller re-implements auth, retries, identifier resolution, or error handling.
2. **Use `@linear/sdk`.** The official SDK is the substrate. Our package is a thin facade adding only what the SDK lacks. Hand-rolled GraphQL POSTs are removed.
3. **API key auth, single key.** `LINEAR_API_KEY` is the only auth. Header is bare `Authorization: <key>` (no `Bearer`). OAuth is deferred (see Scope).
4. **Idempotency by default for Slack-triggered writes.** Issue creation from a Slack thread uses the Slack permalink as a deterministic external key. Re-running the same route must never create a duplicate issue. Mechanism: attach the Slack permalink as a Linear `Attachment` (Linear treats `attachment.url` as a per-issue idempotency key) and check for an existing attachment with that URL before creating a new issue.
5. **Identifier-aware.** Helpers accept both UUIDs and `FE-123`-style human identifiers. Agents will paste either.
6. **State transitions resolved by name+team, not by hardcoded ID.** The current code hardcodes a state UUID. The client caches `workflowStates` per team and resolves by `(team, name | type)`.
7. **Rate-limit aware.** A middleware reads `X-RateLimit-Requests-Remaining` and `X-RateLimit-Complexity-Remaining` on every response. When remaining drops below threshold, it queues until reset. `RATELIMITED` GraphQL errors become a typed retry-after error.
8. **HTTP 200 + `errors[]` always throws.** GraphQL partial-success is treated as failure.
9. **Webhook integrity is non-negotiable.** `Linear-Signature` header verified via timing-safe HMAC-SHA256 of the raw body using the shared signing secret, plus `|now - webhookTimestamp| < 60s` replay window. Unverified payloads are dropped before any handler runs.
10. **Webhook receiver is colocated with `pi-mom`.** Same Railway service, same env, same logs, same deployment unit. Bolt remains Socket Mode for Slack; the webhook receiver is a separate HTTP listener on the same process.
11. **Observability matches pi-mom's `trace()` pattern.** Every Linear request emits a structured trace event (operation, request id, duration, rate-limit headers, error class). Secrets redacted at boundary.
12. **No caller imports `@linear/sdk` directly.** Outside `packages/linear-client`, the SDK is invisible. The `extensions/linear-mcp-guard.ts` keeps gating the externally-provided Linear MCP server; it is unrelated to our client.

## What we build

### `packages/linear-client`

```
packages/linear-client/
  package.json
  tsconfig.json
  src/
    index.ts
    client.ts             createLinearClient({ apiKey, baseUrl? })
    issues.ts             find, create, upsertFromSlack, transition
    comments.ts           post
    attachments.ts        upsert  (url-as-idempotency-key)
    workflow-states.ts    resolve({ teamId, name|type }) + per-team cache
    webhooks.ts           verify(rawBody, headers, secret) -> typed event
    pagination.ts         paginate<T>(connFn, { pageSize, max })
    rate-limit.ts         withRateLimitGuard(fn)
    identifiers.ts        parseLinearUrl, isIdentifier
    errors.ts             re-exports + typed wrappers (RateLimitedError, NotFoundError, …)
    trace.ts              pi-mom-compatible trace hook (no hard dep)
  tests/
    fixtures/             webhook payloads + signatures
    *.test.ts
```

Public surface (illustrative; the spec doc has the binding shape):

```ts
import { createLinearClient } from "@covent/linear-client";

const linear = createLinearClient({ apiKey: process.env.LINEAR_API_KEY! });

const issue = await linear.issues.upsertFromSlack({
  teamId, projectId, stateName: "Backlog",
  title, description,
  slackPermalink,           // idempotency key
  slackRequestId,
});

const found = await linear.issues.find("FE-123");           // identifier or UUID
await linear.issues.transition(found.id, { state: "In Progress" });
await linear.comments.post(found.id, "Agent update: …");

const event = linear.webhooks.verify(rawBody, headers, process.env.LINEAR_WEBHOOK_SIGNING_SECRET!);
```

### `apps/pi-mom` changes

- Replace the inline `fetch` and `issueCreate` mutation with `linear.issues.upsertFromSlack`.
- Delete `LINEAR_API_URL` constant. Delete hardcoded `LINEAR_STATE_ID` (replaced by `LINEAR_DEFAULT_STATE_NAME`, default `"Backlog"`).
- Add an HTTP listener on a separate port for `/webhooks/linear`. Bolt's Socket Mode for Slack is untouched.
- Webhook handler verifies signature, parses to a typed event, dispatches by `type + action`, traces via the existing `trace()`.

### Environment

Added:
- `LINEAR_WEBHOOK_SIGNING_SECRET` — required when webhook receiver is enabled.
- `LINEAR_WEBHOOK_PORT` — optional, default `3001`.
- `LINEAR_DEFAULT_STATE_NAME` — optional, default `Backlog`.

Removed from code (override env still tolerated for transition):
- `LINEAR_API_URL` — SDK owns endpoint.
- `LINEAR_STATE_ID` — resolved by name now.

Unchanged:
- `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_PROJECT_ID`.

### Documentation deliverables

- `docs/source-of-truth/LINEAR_INTEGRATION_PRD.md` — this file.
- `docs/specs/linear-client-spec.md` — binding API surface and behavior.
- `docs/specs/linear-integration-agent-plan.md` — agent lifecycle for this build.
- `docs/runbooks/linear-webhook-setup.md` — workspace webhook configuration, signing-secret rotation.
- `docs/adr/0005-linear-client-library.md` — consolidation decision.
- `docs/adr/0006-linear-webhooks-colocated-with-pi-mom.md` — deployment choice.
- Updates to `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `BOUNDARY.md`, `SECURITY.md`, `skills/linear-covent/SKILL.md`, `apps/pi-mom/README.md`.

### Git/GitHub conventions

Branch: `claude/find-linear-integration-aKrUS`.

Conventional Commits. One logical change per commit. Required prefixes:
- `feat(linear-client): …`
- `feat(pi-mom): …`
- `refactor(pi-mom): …`
- `docs(linear): …`
- `test(linear-client): …`
- `chore(linear): …`

Each commit body answers WHY in 1–3 sentences. No commit lands without a passing `npm run check`.

PR description template (mandatory; Verifiers enforce):

```
## Summary
One line.

## Scope
- Added: …
- Changed: …
- Removed: …

## How it satisfies the PRD
Bullet-by-bullet alignment with docs/source-of-truth/LINEAR_INTEGRATION_PRD.md
principles 1–12.

## Test plan
- [ ] npm run check
- [ ] Idempotency: same Slack thread → same Linear issue.
- [ ] Identifier lookup: UUID and `FE-123` both resolve.
- [ ] State transition: by name and by type.
- [ ] Webhook: valid signature accepted; invalid rejected; replay >60s rejected.
- [ ] Rate-limit middleware: throttles when remaining <10%.

## Out of scope
- OAuth `actor=app` agent identities.
- Subscriptions / polling reconciliation.

## Linked
- PRD: docs/source-of-truth/LINEAR_INTEGRATION_PRD.md
- ADRs: 0005, 0006
- Linear: <issue identifier>
```

## Success criteria

- Zero direct `fetch(...graphql...)` to Linear outside `packages/linear-client`.
- Re-running `@Covent Pi create Linear issue` on the same Slack thread produces zero duplicate Linear issues across at least three attempts.
- `/webhooks/linear` verifies signatures correctly against fixture payloads (valid accepted, tampered rejected, >60s replay rejected).
- `npm run check` passes on the branch.
- Every Linear-touching doc references this PRD.
- The PR description matches the template above.

## Risks and mitigations

- **Pi-mom is Socket Mode today; adding HTTP changes runtime shape.** Mitigation: webhook receiver on a separate port, isolated from Bolt's lifecycle; health check independent.
- **Identifier vs. UUID confusion bleeds into prompts.** Mitigation: `linear.issues.find(idOrIdentifier)` is the only documented lookup. Skills updated.
- **Rate-limit middleware can mask retry storms.** Mitigation: every throttle traces; `RateLimitedError` surfaces `retryAfterMs` to caller.
- **Webhook signing secret rotation.** Mitigation: support two secrets simultaneously (`LINEAR_WEBHOOK_SIGNING_SECRET` + `LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS`) so rotation is zero-downtime. Runbook documents the procedure.
- **Agents pasting Linear URLs vs. identifiers.** Mitigation: `parseLinearUrl` + `isIdentifier` normalize both.

## Non-negotiables

- No commits that print or log Linear secrets, signing secrets, or raw webhook bodies containing user content.
- No `--no-verify` commits.
- No bypassing the client by reaching into `@linear/sdk` directly in callers.
- No introducing OAuth without first updating this PRD.
