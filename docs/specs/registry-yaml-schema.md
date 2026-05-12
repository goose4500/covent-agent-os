# `control-plane/registry.yaml` — schema and conventions

> Source of truth for the bounded vocabulary `apps/pi-mom` exposes to Slack. Read this before adding a route or a custom tool.

The bridge's dispatcher (`apps/pi-mom/lib/dispatch.mjs`) and SDK runner (`apps/pi-mom/lib/pi-sdk-runner.mjs`) both read this same file. There is no other place where route names, tool allowlists, system prompt suffixes, or approval posture live.

## File location

```
apps/pi-mom/control-plane/registry.yaml
```

Loaded by `apps/pi-mom/control-plane/registry-loader.mjs`.

## Top-level shape

```yaml
version: 1

actions:
  - key: <kebab-case>
    name: <human-readable>
    description: <one line>
    status: planned | active
    riskLevel: read-only | bounded | …
    approvalMode: <freeform>
    artifacts: [<freeform list>]
    sourceLinks: [<freeform list>]
    runtime:
      type: control-plane | pi-mom-agent-runner | …
      entrypoint: <name>
      notes: <freeform>

routes:
  <route_key>:
    tools: [<tool_name>, ...]
    systemPromptSuffix: <multi-line string>
    approvals: none | tool | modal

legacyRoutes:
  - name: <slack-route-or-handler-name>
    triggers:
      - <human-readable description>
    status: legacy-active | retired
    notes: <freeform>
```

## `actions:` — agent-readable Action catalog

A list of bounded things the agent can do. Each `action` entry is:

| Field | Type | Required | Purpose |
|---|---|---|---|
| `key` | string (kebab-case) | yes | Stable identifier. Used by `loadActionMetadata(key)`. |
| `name` | string | yes | Human-readable label (Slack/UI display). |
| `description` | string | yes | One-line summary. |
| `status` | `"planned"` \| `"active"` | yes | `planned` until runtime wiring + tests exist; `active` when wired. |
| `riskLevel` | string | recommended | Free-form risk hint (`read-only`, `bounded`, etc.). |
| `approvalMode` | string | recommended | Free-form approval description. |
| `artifacts` | array of strings | recommended | Where outputs land (`Slack thread updates`, `Slack canvas`, etc.). |
| `sourceLinks` | array of strings | recommended | Where source evidence is (`Slack source thread`, etc.). |
| `runtime` | object | yes for `status: active` | `{ type, entrypoint, notes }` — how the action is executed. |

Validation rules enforced by `validateRegistry()`:

- `actions[i].key` must be unique across the file.
- `artifacts` / `sourceLinks` must be arrays when present.
- `riskLevel` must be a non-empty string when present.
- Duplicate keys throw with `duplicate action key '<key>'`.

## `routes:` — per-Action runtime gating

This is the production-load-bearing section. Each `route_key` is matched against the leading `<prefix>:` of the Slack message (or `plain` for unprefixed mentions).

| Field | Type | Required | Purpose |
|---|---|---|---|
| `tools` | array of strings | yes | Allowlist passed to SDK's `setActiveToolsByName(tools)`. Empty array → `noTools: "all"` (default-deny posture). |
| `systemPromptSuffix` | string (multi-line OK) | yes | Appended to the base system prompt for this route. Empty string = no nudge. |
| `approvals` | `"none"` \| `"tool"` \| `"modal"` | yes | Advisory until enforced by middleware. `tool` = `permission-gate` may intercept tool calls. |

### Tool names

The `tools` array contains tool *names*, not function references. The SDK looks them up against:

1. **Built-in Pi tools:** `bash`, `read`, `grep`, `find`, `edit`, `write`, plus any others the SDK ships.
2. **Custom tools registered via `pi.registerTool`:** the 3 Linear tools (`linear_search_issues`, `linear_create_issue`, `linear_add_comment`) registered by `extensions/linear-tools.ts`.

Order doesn't matter; `setActiveToolsByName` resolves the set.

### `systemPromptSuffix` patterns

Two patterns that work well in production:

1. **Workflow nudge** — describe the desired output shape. Example (summarize):
   ```yaml
   systemPromptSuffix: "Summarize the current Slack thread into decisions, open questions, owners, risks/blockers, and next actions. Prefer compact bullets and cite Slack timestamps/permalinks if present in context."
   ```

2. **Tool-orchestration nudge** — for routes with multiple tools, tell the model how to chain. Example (linear):
   ```yaml
   systemPromptSuffix: "The user wants to track something in Linear. ALWAYS call linear_search_issues first … If a clear match comes back, call linear_add_comment … instead of creating a duplicate. … Never call linear_create_issue twice for the same thread."
   ```

The second pattern is how the rebuild replaced post-stream idempotency guards — see [`pattern-modular-pi-custom-tools`](../../README.md) in the vault for the full pattern.

### Approvals semantics

| Value | What it means |
|---|---|
| `none` | No approval gates. Used by read-only routes (`help`, `status`, `summarize`, etc.). |
| `tool` | `permission-gate` extension may intercept individual tool calls via `ctx.ui.select` → Slack modal. Used by `plain`, `bash`, and `linear` routes. |
| `modal` | Reserved for future per-route confirmation cards before the run starts (not currently active). |

## `legacyRoutes:` — Slack handler inventory

Documents what's currently wired in `apps/pi-mom/index.mjs` even when it doesn't fit the modern `routes:` shape (slash commands, action handlers, etc.). Each entry:

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Slack route/handler/event name. |
| `triggers` | array of strings | Human-readable trigger conditions. |
| `status` | `"legacy-active"` \| `"retired"` | Whether the handler currently runs. |
| `notes` | non-empty string | Implementation notes (must be non-empty). |

Validation: each entry must have a name, ≥1 trigger, a status, and non-empty notes.

## Adding a route

1. Pick a stable `route_key` (lowercase, no `:` suffix — the dispatcher strips it).
2. Add a `routes.<route_key>` entry with `tools`, `systemPromptSuffix`, `approvals`.
3. If the route depends on custom Pi tools, register them in `extensions/<tool-family>.ts` via `pi.registerTool` and ensure they're loaded by `pi-sdk-runner.mjs` (the factory pattern — see `extensions/linear-tools.ts` for the canonical example).
4. Add a row to the route table in `apps/pi-mom/README.md` and `docs/architecture.md`.
5. Update `docs/SYSTEM_INDEX.md` and `docs/AGENT_CONTEXT.md` if the route is non-obvious.
6. Add tests:
   - Update `apps/pi-mom/test-action-resolver.mjs` to assert the route resolves.
   - Update `apps/pi-mom/test-control-plane-registry.mjs` if registry schema changed.
   - Add tool tests in `apps/pi-mom/test-<tool-family>.mjs` if you registered tools.
7. Run `bun run check`. Confirm green before commit.

## Adding a custom Pi tool

Pattern: factory exports a function `(pi: ExtensionAPI) => void` that calls `pi.registerTool(...)`. The factory takes optional `{ fetchImpl, env }` for test injection.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function createMyToolsFactory({ fetchImpl = fetch, env = process.env } = {}) {
  return function myTools(pi: ExtensionAPI) {
    pi.registerTool({
      name: "my_tool",
      label: "Human-readable label",
      description: "What this tool does AND when the model should call it (this drives selection).",
      promptSnippet: "my_tool: short one-liner",
      promptGuidelines: [
        "Call my_tool when ...",
        "Prefer X over Y when ...",
      ],
      parameters: Type.Object({
        foo: Type.String({ minLength: 1, description: "..." }),
        bar: Type.Optional(Type.Number({ description: "..." })),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        // ...
        return {
          content: [{ type: "text", text: "result shown to model" }],
          details: { /* structured details for logs/UI */ },
        };
      },
    });
  };
}

export default createMyToolsFactory();
```

### Critical: `AgentToolResult.details` is required

The SDK's `AgentToolResult<T>` requires `details: T`. A common gotcha: error returns that omit `details` will fail `tsc --noEmit`. Use a helper:

```typescript
function errorResult(text: string): AgentToolResult<any> {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: true,
  };
}
```

(See `extensions/linear-tools.ts` for the canonical pattern.)

## Current `routes:` snapshot

For the live route list, read [`apps/pi-mom/control-plane/registry.yaml`](../../apps/pi-mom/control-plane/registry.yaml) directly. The table in [`docs/architecture.md`](../architecture.md) mirrors it but the YAML is canonical.

## Related

- [`apps/pi-mom/control-plane/registry.yaml`](../../apps/pi-mom/control-plane/registry.yaml) — the file this spec describes.
- [`apps/pi-mom/control-plane/registry-loader.mjs`](../../apps/pi-mom/control-plane/registry-loader.mjs) — the loader + validator.
- [`apps/pi-mom/lib/action-resolver.mjs`](../../apps/pi-mom/lib/action-resolver.mjs) — parses Slack text + registry → resolved Action.
- [`apps/pi-mom/test-control-plane-registry.mjs`](../../apps/pi-mom/test-control-plane-registry.mjs) — schema + legacyRoutes invariants.
- [`docs/architecture.md`](../architecture.md) — where this spec fits in the bigger architecture.
