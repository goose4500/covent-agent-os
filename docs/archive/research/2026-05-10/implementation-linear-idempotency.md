> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Implementation: Slack thread → Linear idempotency

## Summary of files changed

- `apps/pi-mom/lib/linear-idempotency.mjs`
  - Added pure helpers to detect prior successful `Created Linear issue` confirmations in a Slack thread.
  - Extracts Slack-formatted Linear links, bare Linear URLs, or Linear keys.
  - Ignores failure/no-key notices, draft-like notices, and unrelated Linear mentions.
  - Added `createLinearIssueUnlessDuplicate()` helper so duplicate behavior can be tested offline without calling Linear.
- `apps/pi-mom/index.mjs`
  - Imports the idempotency helpers.
  - For the Linear route, scans thread messages before invoking Pi; if a prior successful Linear confirmation exists, replies with that existing reference and returns.
  - Scans thread messages again immediately before `createLinearIssueFromPiOutput()` to reduce duplicate risk from a concurrent/recent confirmation.
  - On duplicate, posts: `↩️ Linear issue already exists for this thread: ... I won’t create a duplicate.`
- `apps/pi-mom/test-linear-idempotency.mjs`
  - Added offline unit coverage for Linear reference parsing and duplicate detection.
  - Added offline assertion that the Linear create callback is not called when a duplicate confirmation exists.
- `apps/pi-mom/package.json`
  - Added the new idempotency module/test to `npm --prefix apps/pi-mom run check`.

## Behavior preserved / not changed

- Did not migrate to TypeScript.
- Did not change Slack manifest/scopes.
- Did not add modals or shortcuts.
- Did not enable Pi tools or wire `supervised-pi`.
- Left help/status/plain Pi/image/`/thread-spec`/DM/`agent:` route behavior unchanged except for the new duplicate guard on the Linear route.

## Tests/checks run

- `npm --prefix apps/pi-mom run check` — passed.
  - `node --check` for pi-mom files and new idempotency files passed.
  - Existing agent-run-card tests passed.
  - New linear idempotency tests passed.
- `npm run check` — passed.
  - `secret-scan: ok`
  - `validate:skills ok` with existing warnings about missing descriptions/legacy frontmatter.
  - `validate:agents ok` with existing warnings about missing `defaultContext` and duplicate `linear-auditor` name.
  - pi-mom check passed.
  - `tsc --noEmit` passed.
- `npm run secret-scan` — passed (`secret-scan: ok`).

## Remaining risks / follow-up recommendations

- The detector intentionally keys off successful confirmation-style text beginning with `Created Linear issue` plus a Linear URL or key. If the production confirmation wording changes, update `linear-idempotency.mjs` and tests at the same time.
- This is in-memory/thread-history idempotency, not a transactional lock. The second scan immediately before creation lowers race risk, but two workers processing the same new request at the exact same time could still race before either posts a confirmation.
- The repo already had many unrelated modified/untracked files before/around this work; this implementation only intentionally changed the files listed above plus this report.
