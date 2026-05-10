# pi-mom Guardrails v1 Spec

Status: Draft
Branch: `hardening/pi-mom-guardrails-v1`
Worktree: `/home/jfloyd/worktrees/covent-agent-os-hardening-pi-mom`
Base commit: `cef9bbc feat(pi-mom): add agent run card POC`

## Goal

Make the Slack/Pi/Linear bridge easier to trust and change by adding testable seams, focused offline tests, config validation, and a first duplicate Linear-write guard without changing the product UX.

## Why this matters

The repo already provides value, but experienced engineers will look for evidence that core behavior is regression-tested, external writes are guarded, and production behavior is controlled by explicit config rather than scattered env reads.

## Scope

1. Extract pure route/parsing helpers from `apps/pi-mom/index.mjs` into testable modules.
2. Add offline `node:test` coverage for route parsing, Slack thread URL parsing, Linear title extraction, and redaction.
3. Centralize pi-mom config/env validation into a shared module used by runtime and doctor.
4. Add a first duplicate Linear issue guard that skips creation when the Slack thread already contains a clear prior Linear creation confirmation.
5. Keep root `npm run check` as the canonical validation gate.

## Non-goals

- No Railway deploy.
- No Slack scope or manifest redesign.
- No full TypeScript migration.
- No database or queue.
- No Slack modal approval flow yet.
- No new agent permissions.
- No enabling Pi tools from Slack-originated routes.

## Acceptance criteria

- `npm run secret-scan` passes.
- `npm run check` passes.
- New tests run offline without Slack, Linear, OpenAI, or Railway credentials.
- Existing route examples still parse as documented in `apps/pi-mom/README.md`.
- Duplicate Linear guard has tests proving obvious prior success skips issue creation and drafts/failures do not.
- No secrets, raw Slack exports, raw Linear dumps, logs, or generated files are committed.

## Implementation slices

### Slice 1 — testable route helpers

Create `apps/pi-mom/lib/routes.mjs` and tests for command parsing. Keep extraction mechanical.

### Slice 2 — config validation

Create `apps/pi-mom/lib/config.mjs` and tests for safe/failing env combinations. Runtime and doctor should consume the same rules.

### Slice 3 — Linear duplicate guard

Create `apps/pi-mom/lib/linear-guard.mjs` and tests. Wire it before Linear issue creation.

### Slice 4 — docs/check wiring

Update `apps/pi-mom/package.json` check script and link this spec from relevant docs if needed.

## Review checklist

- Diff is mostly extraction/tests/guardrails, not feature expansion.
- `apps/pi-mom/index.mjs` shrinks or becomes easier to reason about.
- Tests prove behavior rather than only syntax.
- Any changed runtime behavior is called out explicitly.
