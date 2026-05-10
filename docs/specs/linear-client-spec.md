# `@covent/linear-client` — Binding API Spec

Status: binding for the package surface and behavior
Owner: Covent Agent OS
Last updated: 2026-05-10
PRD: [`docs/source-of-truth/LINEAR_INTEGRATION_PRD.md`](../source-of-truth/LINEAR_INTEGRATION_PRD.md)
Source: `packages/linear-client/src/**`

## Purpose

`@covent/linear-client` is the single typed entrypoint for every Linear call originating inside the Covent Agent OS — `apps/pi-mom`, future workflow nodes, and PI agents the team launches. It is a thin facade over `@linear/sdk@84.0.0` that adds the four things the SDK does not give us: Slack-permalink idempotency, per-team workflow-state resolution, Linear webhook signature verification, and a typed error taxonomy. See PRD principles 1, 2, and 12: outside this package the SDK is invisible, and no caller re-implements auth, retries, identifier resolution, or error handling.

## Public surface

All exports flow through `packages/linear-client/src/index.ts`. Signatures below are derived from the implementation; the source is authoritative.

### Facade

```ts
import { createLinearClient, type LinearClientFacade } from "@covent/linear-client";

export interface CreateLinearClientOptions {
  apiKey: string;
  /** Override the Linear GraphQL endpoint. SDK default is production. */
  baseUrl?: string;
}

export function createLinearClient(opts: CreateLinearClientOptions): LinearClientFacade;

export interface LinearClientFacade {
  readonly sdk: import("@linear/sdk").LinearClient;
  readonly issues: IssuesApi;
  readonly comments: CommentsApi;
  readonly attachments: AttachmentsApi;
  readonly workflowStates: WorkflowStatesApi;
  readonly webhooks: WebhooksApi;
  withRateLimitGuard<T>(fn: () => Promise<T>, opts?: RateLimitGuardOptions): Promise<T>;
  setTrace(fn: TraceFn | null): TraceFn;
}
```

The `apiKey` becomes a bare `Authorization: <key>` header (PRD principle 3 — no `Bearer`). Pass `null` to `setTrace` to reset to no-op; the previous adapter is returned.

### Issues — `packages/linear-client/src/issues.ts`

```ts
export interface IssueRef {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface IssueCreateInput {
  teamId: string;
  projectId?: string;
  stateId?: string;
  stateName?: string;
  title: string;
  description?: string;
  labelIds?: string[];
  assigneeId?: string;
  priority?: number;
}

export interface IssueTransitionInput {
  stateName?: string;
  stateType?: string;
  teamId?: string;
}

export interface IssueUpsertFromSlackInput {
  teamId: string;
  projectId?: string;
  stateName?: string;
  stateId?: string;
  title: string;
  description?: string;
  slackPermalink: string;
  slackRequestId: string;
  labelIds?: string[];
  assigneeId?: string;
  priority?: number;
}

export interface IssueUpsertFromSlackResult {
  issue: IssueRef;
  created: boolean;
}

export interface IssuesApi {
  find(idOrIdentifier: string): Promise<IssueRef | null>;
  create(input: IssueCreateInput): Promise<IssueRef>;
  upsertFromSlack(input: IssueUpsertFromSlackInput): Promise<IssueUpsertFromSlackResult>;
  transition(issueId: string, input: IssueTransitionInput): Promise<IssueRef>;
}
```

`find` accepts UUIDs and human identifiers (e.g. `FE-123`) via one `string` overload (Wave 2 R1 correction). It swallows SDK errors and returns `null` for "not found" cases. `create` and `transition` throw `LinearWriteError` on `success: false`. `upsertFromSlack` implements Strategy B (see below).

### Comments — `packages/linear-client/src/comments.ts`

```ts
export interface CommentRef {
  id: string;
  body: string;
  issueId: string;
  url?: string;
}

export interface CommentsApi {
  post(issueId: string, body: string): Promise<CommentRef>;
}
```

Throws `LinearWriteError` on `success: false`.

### Attachments — `packages/linear-client/src/attachments.ts`

```ts
export interface AttachmentRef {
  id: string;
  url: string;
  title: string;
  issueId: string;
}

export interface AttachmentUpsertInput {
  issueId: string;
  url: string;
  title: string;
  subtitle?: string;
  iconUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface AttachmentsApi {
  upsert(input: AttachmentUpsertInput): Promise<AttachmentRef>;
}
```

Linear treats `(issueId, url)` as the attachment idempotency key — re-posting the same pair upserts rather than duplicates.

### Workflow states — `packages/linear-client/src/workflow-states.ts`

```ts
export type WorkflowStateType =
  | "triage" | "backlog" | "unstarted" | "started"
  | "completed" | "canceled" | "duplicate" | string;

export interface ResolveWorkflowStateInput {
  teamId: string;
  name?: string;
  type?: WorkflowStateType;
}

export interface WorkflowStatesApi {
  resolve(input: ResolveWorkflowStateInput): Promise<string>;
  invalidate(teamId?: string): void;
}

export class WorkflowStateCache {
  resolve(client: WorkflowStatesSdkLike, input: ResolveWorkflowStateInput): Promise<string>;
  invalidate(teamId?: string): void;
}
```

### Webhooks — `packages/linear-client/src/webhooks.ts`

```ts
export interface VerifiedWebhookEvent {
  action: string;
  type: string;
  createdAt?: string;
  updatedAt?: string;
  webhookTimestamp: number;
  webhookId?: string;
  organizationId?: string;
  url?: string;
  data: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface VerifyWebhookOptions {
  rawBody: Buffer | string;
  headers: LinearWebhookHeaders;
  secret: string;
  additionalSecrets?: string[];
  replayWindowMs?: number;
  now?: () => number;
}

export function verifyWebhook(opts: VerifyWebhookOptions): VerifiedWebhookEvent;

export interface WebhooksApi {
  verify(opts: Omit<VerifyWebhookOptions, "secret"> & { secret?: string }): VerifiedWebhookEvent;
}
```

### Pagination — `packages/linear-client/src/pagination.ts`

```ts
export interface PageInfoLike { hasNextPage: boolean; endCursor: string | null }
export interface ConnectionLike<T> { nodes: T[]; pageInfo: PageInfoLike }
export type ConnectionFn<T> = (after?: string) => Promise<ConnectionLike<T>>;
export interface PaginateOptions { max?: number }

export function paginate<T>(
  connectionFn: ConnectionFn<T>,
  opts?: PaginateOptions,
): AsyncIterable<T>;
```

### Rate-limit — `packages/linear-client/src/rate-limit.ts`

```ts
export interface RateLimitGuardOptions {
  /** Reserved for v2 proactive throttling; ignored in v1. Default 0.1. */
  thresholdPct?: number;
  now?: () => number;
  /** Fallback retry-after when the SDK error doesn't carry one. Default 1000ms. */
  defaultRetryAfterMs?: number;
}

export function withRateLimitGuard<T>(
  fn: () => Promise<T>,
  opts?: RateLimitGuardOptions,
): Promise<T>;
```

### Identifiers — `packages/linear-client/src/identifiers.ts`

```ts
export interface ParsedLinearUrl {
  identifier: string;
  teamPrefix: string;
  teamKey: string;
  number: number;
  slug?: string;
}

export function isIdentifier(value: string): boolean;
export function parseLinearUrl(url: string): ParsedLinearUrl | null;
```

### Errors — `packages/linear-client/src/errors.ts`

Re-exports the SDK's thrown subclasses (all extend `LinearError`):

```ts
export {
  LinearError,
  AuthenticationLinearError,
  InvalidInputLinearError,
  FeatureNotAccessibleLinearError,
  RatelimitedLinearError,
  NetworkLinearError,
  ForbiddenLinearError,
  BootstrapLinearError,
  GraphqlLinearError,
  InternalLinearError,
  LockTimeoutLinearError,
  OtherLinearError,
  UnknownLinearError,
  UsageLimitExceededLinearError,
  UserLinearError,
} from "@linear/sdk";
```

Plus our typed wrappers:

```ts
export class RateLimitedError extends Error {
  readonly retryAfterMs: number;
  readonly cause?: unknown;
  constructor(message: string, retryAfterMs: number, cause?: unknown);
}

export type WebhookVerificationErrorCode =
  | "missing_signature"
  | "invalid_signature"
  | "replay_expired"
  | "malformed_payload";

export class WebhookVerificationError extends Error {
  readonly code: WebhookVerificationErrorCode;
  constructor(message: string, code: WebhookVerificationErrorCode);
}

export class LinearWriteError extends Error {
  readonly operation: string;
  readonly payload?: unknown;
  constructor(message: string, operation: string, payload?: unknown);
}
```

`UserLinearError` (not `UserError`) is the thrown class; `UserError` is a GraphQL payload type and is not re-exported (Wave 2 R1 correction).

### Trace — `packages/linear-client/src/trace.ts`

```ts
export type TraceFn = (eventName: string, data?: Record<string, unknown>) => void;

export function setTraceFn(fn: TraceFn | null): TraceFn;
export function trace(eventName: string, data?: Record<string, unknown>): void;
```

`trace()` swallows adapter errors so a misbehaving logger cannot break a Linear call.

## Behavior contracts

### Idempotency — `upsertFromSlack` (Strategy B)

Implements Wave 2 R2 exactly:

1. Call `client.attachmentsForURL(slackPermalink)`.
2. For each returned node: skip if `archivedAt` is set on the attachment; resolve the linked issue lazily or via one extra `client.issue(id)` round-trip; skip if `issue.archivedAt` is set.
3. **One live hit** → return `{ issue, created: false }` and trace `linear.issue.upsert.dedupe_hit`.
4. **More than one live hit** → trace `linear.issue.upsert.multiple_matches` with all candidate IDs; return the oldest hit by `createdAt`.
5. **Cold miss** → append `Source Slack thread: <permalink>` and `Covent Pi request: <slackRequestId>` to the description (belt-and-braces; helps humans), call `createIssue`, then `upsertAttachment({ issueId, url: slackPermalink, title: "Slack thread", subtitle: "Covent Pi request <id>" })`. Trace `linear.issue.upsert.created`. Return `{ issue, created: true }`.

If `createIssue` succeeds but `upsertAttachment` throws (network blip, transient Linear failure, permission edge), the error is re-thrown after a `linear.issue.upsert.attachment_failed` trace. Returning a half-formed `{ issue, created: true }` would orphan the issue — the next retry of the same Slack thread would not find the attachment and would create a duplicate, violating PRD principle 4. Callers must surface the failure (pi-mom's existing `try { … } catch { … }` around `createLinearIssueFromPiOutput` covers this).

Quote from Linear docs cited in Wave 2 R2: *"Attachment URL is used as an idempotent value if used in conjunction with the same issue id."*

### Webhook verification — `verifyWebhook`

Per PRD principle 9 and Wave 2 R3:

- Header is `Linear-Signature` (lowercase hex HMAC-SHA256 of the raw body). Node lowercases header keys, so callers read `req.headers["linear-signature"]`.
- Body bytes signed are the raw, unparsed request body. The receiver must capture the raw body before any JSON middleware (`bodyParser.raw({ type: "application/json" })` or `express.json({ verify })`).
- Timestamp is the JSON body field `webhookTimestamp` in UNIX **milliseconds** (there is no `Linear-Signature-Timestamp` header).
- Replay window: `|now - webhookTimestamp| < 60_000 ms`, overridable via `replayWindowMs`.
- Rotation: pass the previous secret in `additionalSecrets`. The verifier tries `secret` then each `additionalSecrets[]` in order, using `timingSafeEqual`.
- Verification happens **before** JSON parse; the body is only parsed once a signature has matched. A malformed-but-signed payload still throws a typed `WebhookVerificationError` with code `malformed_payload`.

### Workflow-state resolution — `WorkflowStateCache`

- Per-team in-memory cache keyed by `teamId`.
- On cold miss, fetches up to 100 workflow states for the team (`workflowStates({ filter: { team: { id: { eq: teamId } } }, first: 100 })`).
- Indexes each state under both `name.toLowerCase()` and `type.toLowerCase()`.
- Lookup precedence: `name` first, then `type`. Matching is case-insensitive on both sides.
- When two states share a type, the first one wins for that type slot — name-based lookup is the recommended path.
- `invalidate(teamId)` drops a single team; `invalidate()` clears all teams.

### Error taxonomy

| Error | Where it originates | Caller signal |
|---|---|---|
| `LinearError` (re-exported) | SDK base class — all of Linear's typed throws extend this | Catch-all for Linear-side failures |
| `AuthenticationLinearError`, `ForbiddenLinearError`, `InvalidInputLinearError`, `FeatureNotAccessibleLinearError`, `NetworkLinearError`, `BootstrapLinearError`, `GraphqlLinearError`, `InternalLinearError`, `LockTimeoutLinearError`, `OtherLinearError`, `UnknownLinearError`, `UsageLimitExceededLinearError`, `UserLinearError` | SDK throws on specific GraphQL/transport failures | Map to caller-side classifications (401, 403, validation, network) |
| `RatelimitedLinearError` (re-exported) | SDK throws when Linear returns `RATELIMITED` | Caught by `withRateLimitGuard` and rethrown as `RateLimitedError` |
| `RateLimitedError` (ours) | `rate-limit.ts` | Carries `retryAfterMs`; callers should back off |
| `WebhookVerificationError` (ours) | `webhooks.ts` | `.code` is `missing_signature`/`invalid_signature`/`replay_expired`/`malformed_payload`; HTTP receiver maps to 401/401/400/400 |
| `LinearWriteError` (ours) | `issues.ts`, `comments.ts`, `attachments.ts` when a mutation payload returns `success: false` (PRD principle 8) | Surfaces `.operation` and the offending payload for triage |

## Trace event taxonomy

Every event the package emits (derived from `grep -n 'trace("linear\.' packages/linear-client/src`):

| Event | Where | Fires when | `data` carries |
|---|---|---|---|
| `linear.attachment.upsert.requested` | `attachments.ts:53` | About to call `createAttachment` | `{ issueId, url }` |
| `linear.comment.post.requested` | `comments.ts:31` | About to call `createComment` | `{ issueId }` |
| `linear.issue.create.requested` | `issues.ts:175` | About to call `createIssue` | `{ teamId, projectId, stateId }` |
| `linear.issue.create.succeeded` | `issues.ts:208` | `createIssue` returned a non-empty issue | `{ id, identifier }` |
| `linear.issue.transition.requested` | `issues.ts:242` | About to call `updateIssue` to change state | `{ issueId, teamId, stateId }` |
| `linear.issue.upsert.dedupe_hit` | `issues.ts:299` | `attachmentsForURL` found exactly one live attachment | `{ issueId, identifier, slackPermalink }` |
| `linear.issue.upsert.multiple_matches` | `issues.ts:310` | `attachmentsForURL` returned more than one live attachment; oldest wins | `{ slackPermalink, chosen, candidates[] }` |
| `linear.issue.upsert.created` | `issues.ts:343` | Cold miss path created a new issue and attached the Slack permalink | `{ issueId, identifier, slackPermalink }` |
| `linear.issue.upsert.attachment_failed` | `issues.ts` | Cold-miss `createIssue` succeeded but `upsertAttachment` threw; the error is re-thrown so the caller surfaces it rather than leaving an issue without its idempotency anchor | `{ issueId, url, error }` |
| `linear.issue.upsert.attachment_resolve_failed` | `issues.ts` | `resolveAttachmentIssue` saw a non-archived attachment with only `issueId`, called `client.issue(id)`, and the SDK threw; the node is treated as a miss | `{ issueId, url, error }` |
| `linear.issue.find.failed` | `issues.ts` | `findIssue` swallowed an SDK error and returned `null`; emitted before the null so the cause is observable | `{ input, error }` |
| `linear.workflow_state.resolve.cache_hit` | `workflow-states.ts:117` | `WorkflowStateCache.loadTeam` served from cache | `{ teamId }` |
| `linear.workflow_state.resolve.cache_miss` | `workflow-states.ts:121` | `WorkflowStateCache.loadTeam` fetched from the SDK | `{ teamId }` |
| `linear.rate_limit.throttle` | `rate-limit.ts:49` | `withRateLimitGuard` caught a `RatelimitedLinearError` | `{ retryAfterMs, requestsRemaining, complexityRemaining }` |
| `linear.webhook.verify.missing_signature` | `webhooks.ts:71` | `Linear-Signature` header absent or empty | (none) |
| `linear.webhook.verify.invalid_signature` | `webhooks.ts:99` | Computed HMAC did not match any configured secret | (none) |
| `linear.webhook.verify.malformed_payload` | `webhooks.ts:118, 127, 148` | Body is not a JSON object, `webhookTimestamp` is missing/non-numeric, or `action`/`type` are missing/non-string | (none) |
| `linear.webhook.verify.replay_expired` | `webhooks.ts:135` | `|now - webhookTimestamp| > replayWindowMs` | `{ webhookTimestamp, replayWindowMs }` |
| `linear.webhook.verify.succeeded` | `webhooks.ts:159` | Signature, timestamp, and payload all validated | `{ type, action }` |

Secret values, raw bodies, and any field that might carry user content are never traced.

## Known limitations

- **Rate-limit middleware is reactive only in v1.** `@linear/sdk` does not surface `X-RateLimit-Requests-Remaining` / `X-RateLimit-Complexity-Remaining` response headers, so the proactive "throttle when remaining < `thresholdPct`" pre-emption the PRD principle 7 imagines is deferred to v2. V1 reacts to the SDK's `RatelimitedLinearError`, translates it to `RateLimitedError` carrying `retryAfterMs`, and emits `linear.rate_limit.throttle`. The `thresholdPct` option is accepted-and-ignored for forward compatibility so call sites do not need to change in v2.
- **Concurrent-replica race on `upsertFromSlack`.** Two pi-mom replicas with the same Slack permalink can race between `attachmentsForURL` and `createIssue` and produce duplicates. pi-mom is a single Railway service today (PRD risks section); the mitigation is deferred to v2. We trace `linear.issue.upsert.multiple_matches` when a post-race dedup pass detects it.
- **Archived attachment policy.** A hit whose attachment or linked issue is archived is treated as a cold miss — we re-create. This is the v1 policy locked in by Wave 2 R2.

## Cross-references

- PRD: [`docs/source-of-truth/LINEAR_INTEGRATION_PRD.md`](../source-of-truth/LINEAR_INTEGRATION_PRD.md). Anything that contradicts the PRD is wrong; update the PRD first, then code, then this spec.
- Agent plan: [`docs/specs/linear-integration-agent-plan.md`](./linear-integration-agent-plan.md). Wave 2 outcomes section is the binding fact set this spec reflects.
- Runbook: [`docs/runbooks/linear-webhook-setup.md`](../runbooks/linear-webhook-setup.md) — workspace webhook configuration and signing-secret rotation.
- ADRs: [`docs/adr/0005-linear-client-library.md`](../adr/0005-linear-client-library.md), [`docs/adr/0006-linear-webhooks-colocated-with-pi-mom.md`](../adr/0006-linear-webhooks-colocated-with-pi-mom.md).
