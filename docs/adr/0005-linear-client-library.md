# ADR 0005: Consolidate Linear access behind `@covent/linear-client`

Date: 2026-05-10
Status: accepted
Related: PRD `docs/source-of-truth/LINEAR_INTEGRATION_PRD.md`, ADR 0002, agent plan `docs/specs/linear-integration-agent-plan.md`, spec `docs/specs/linear-client-spec.md`, ADR 0006

## Context

Linear integration in this repo grew ad-hoc:

- ~70 lines of inline `fetch` / GraphQL inside `apps/pi-mom/index.mjs:329-393` issuing a hand-rolled `issueCreate` mutation against a hardcoded team / project / state UUID.
- A policy guard at `extensions/linear-mcp-guard.ts` that gates an externally-provided Linear MCP server (interactive use only — unrelated to our automation).
- Prompt-only guidance scattered across `skills/linear-covent/`, `skills/linear-auditor/`, and `skills/linear-subissue-audit/`.
- A placeholder at `examples/mcp.example.json`.

There was no shared client, no idempotency for Slack-triggered writes, no webhook ingest, and no typed surface for agents. Each new caller would re-implement auth, retries, identifier resolution, and error handling — exactly the trap the PRD's principle 1 forbids.

Linear is becoming a primary node in our agent workflows and a primary tool for PI agents the team launches. We need one place to make the integration correct, and one place to evolve it.

## Decision

All Linear access from inside the Covent Agent OS goes through `@covent/linear-client`, a typed facade over `@linear/sdk` living at `packages/linear-client/`. Outside this package, the SDK is invisible (PRD principle 12). The package surface, behavior contracts, and trace events are binding in `docs/specs/linear-client-spec.md`.

Concrete sub-decisions, each cited from the PRD:

- **Pin `@linear/sdk@84.0.0`.** Wave 2 R1 verified this version compiles green under Node 22 + TS 5.9 + `module: NodeNext` + `strict: true`, and has a tiny dep footprint (only `@graphql-typed-document-node/core`). Pinning prevents silent breakage from minor SDK churn and gives us a stable surface to test against.
- **API key auth only, single key.** `LINEAR_API_KEY` is the only auth. The SDK's `apiKey` option produces exactly the bare `Authorization: <key>` header Linear expects — no `Bearer` prefix (PRD principle 3).
- **No OAuth in v1.** OAuth and `actor=app` agent identities are deferred. We are a five-person internal team; a single shared key is sufficient. The PRD's Scope section enumerates the three triggers that would force us to revisit: external collaborators, agents needing to appear as distinct workspace members, or wanting to subscribe to `AgentSessionEvent`. Linear's Agents API (AgentSession / AgentActivity / 10s SLA) is blocked on OAuth and is also out of scope.
- **No direct `@linear/sdk` imports in callers.** `apps/pi-mom`, future workflow nodes, and PI agent skills consume the facade. The `extensions/linear-mcp-guard.ts` continues to gate the externally-provided MCP server for interactive workflows; that is an unrelated surface.
- **GraphQL partial-success is failure.** Any mutation returning `success: false` is surfaced as `LinearWriteError` rather than silently proceeding (PRD principle 8).
- **Webhook integrity is non-negotiable.** The package owns `verifyWebhook` — timing-safe HMAC-SHA256 of the raw body, 60s replay window, two-secret rotation pattern. See ADR 0006 for the colocation choice.

## Consequences

Positive:

- One place to fix bugs, evolve types, and improve observability.
- `upsertFromSlack` makes Slack→Linear idempotent — re-running the same route on the same thread will not duplicate issues (PRD principle 4 / Wave 2 R2 Strategy B).
- Identifier confusion disappears: `client.issues.find("FE-123")` and `client.issues.find("<uuid>")` both work via the SDK's single string overload.
- Rate-limit handling is uniform: SDK throws → `withRateLimitGuard` catches → typed `RateLimitedError` with `retryAfterMs`.
- Webhook signing-secret rotation is zero-downtime via `additionalSecrets` (the runbook documents the procedure).
- Observability is uniform: every operation emits a structured `linear.*` trace event (spec lists them).

Negative / accepted tradeoffs:

- We carry a new workspace package and its TypeScript build. `npm run check` now runs an additional `typecheck:linear-client`.
- Rate-limit awareness is reactive in v1 (the SDK does not surface `X-RateLimit-*` headers). The PRD principle 7 vision is deferred; `thresholdPct` is accepted-and-ignored for forward compatibility.
- Two concurrent pi-mom replicas with the same Slack permalink can still race on `upsertFromSlack`. pi-mom is a single Railway service today; the mitigation is deferred to v2.
- Anyone wanting to use Linear from a new lane has to go through this package. That is the point, but it adds one indirection vs. a quick `fetch`. The trade is worth it — see PRD principle 1.

## References

- PRD: `docs/source-of-truth/LINEAR_INTEGRATION_PRD.md` (principles 1–12, scope, success criteria, risks).
- Spec: `docs/specs/linear-client-spec.md` (binding API surface and behavior).
- Agent plan: `docs/specs/linear-integration-agent-plan.md` (Wave 2 outcomes are the verified-facts cite).
- ADR 0002: Linear is execution truth — this ADR is the implementation consolidation that lets 0002 actually be reliable.
- ADR 0006: Linear webhooks colocated with pi-mom — paired deployment decision.
