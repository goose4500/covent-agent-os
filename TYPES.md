# Type Reference: covent-agent-os

Comprehensive catalogue of every type alias, interface, dataclass, enum, and type-level construct defined in the source tree.

## Summary

- **Total type definitions:** 17
- **Languages with declared types:** TypeScript (12), Python (1)
  - The repository is mostly markdown skills, YAML profiles, JSON configs, and `.mjs` JavaScript without JSDoc — no JSDoc `@typedef`s, no `.d.ts` files, no `.proto`, `.graphql`, or `.pyi` files exist.
- **Breakdown by kind:**
  - TypeScript `interface`: 5 (`GateSlackActionOptions`, `LinearToolsOptions`, `AwsClients`, `ExtensionOptions`, plus 2 test-only mock interfaces — `RegisteredTool`, `MockPi`, `SendCall`)
  - TypeScript `type` alias: 4 (`AnyResult`, `Lane`, `PiRegisterToolArg`, plus inline TypeBox `Static<typeof ...>` schemas)
  - TypeBox runtime schemas (treated as compile-time `Static<>` types): 4 (`SsmGetSecretInput`, `SqsSendEventInput`, `S3PutArtifactInput`, `CloudWatchLogAuditInput`)
  - Python `@dataclass`: 1 (`SessionMeta`)
- **Breakdown by module:**
  - `extensions/` — 3 types (in `slack-mcp-guard.ts`, `linear-tools.ts`)
  - `packages/pi-ext-covent-aws/` — 11 types (4 TypeBox schemas + 1 type alias + 1 interface in `src/index.ts`; 3 test interfaces in `test/index.test.ts`; plus the `PiRegisterToolArg` type)
  - `packages/pi-chrome-access/` — 0 declared types (uses imported types only)
  - `apps/pi-mom/.slack/` — 0 (Python script, no class/type definitions)
  - `skills/yesterdays-pi-context-prime/scripts/` — 1 (`SessionMeta` dataclass)

No type-level constructs were undocumentable. All types listed below resolve fully in their files. Imported external types (`ExtensionAPI`, `ExtensionContext` from `@earendil-works/pi-coding-agent`, AWS SDK client types, TypeBox `Static`) are referenced but not redefined locally and are therefore not enumerated as project-owned types.

---

## extensions/

### `slack-mcp-guard.ts`

#### `GateSlackActionOptions`
- **Kind:** interface
- **Location:** `/home/user/covent-agent-os/extensions/slack-mcp-guard.ts:115`
- **Purpose:** Options bag passed into the internal `gateSlackAction()` helper that prompts the user before allowing a Slack MCP write/unknown call.
- **Fields:**
  ```ts
  interface GateSlackActionOptions {
    toolName: string;
    input: Record<string, unknown>;
    ctx: {
      hasUI: boolean;
      ui?: {
        confirm: (title: string, message: string) => Promise<boolean> | boolean;
      };
    };
    category: string;
    prompt: string;
    nonInteractiveReason: string;
    declinedReason: string;
  }
  ```

### `linear-tools.ts`

#### `LinearToolsOptions`
- **Kind:** interface (exported)
- **Location:** `/home/user/covent-agent-os/extensions/linear-tools.ts:84`
- **Purpose:** Constructor options for the Linear tools factory; lets callers inject a fake `fetch` and an env map for testing.
- **Fields:**
  ```ts
  export interface LinearToolsOptions {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
  }
  ```

#### `AnyResult`
- **Kind:** type alias (private, file-local)
- **Location:** `/home/user/covent-agent-os/extensions/linear-tools.ts:89`
- **Purpose:** Shape returned by Linear tool `execute()` callbacks — mirrors Pi's `AgentToolResult` envelope with an optional error flag.
- **Definition:**
  ```ts
  type AnyResult = {
    content: Array<{ type: "text"; text: string }>;
    details: any;
    isError?: boolean;
  };
  ```

---

## packages/pi-ext-covent-aws/

### `src/index.ts`

#### `Lane`
- **Kind:** type alias (exported)
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/src/index.ts:36`
- **Purpose:** Identifies which Covent privilege lane a Pi instance is running in. Drives lane-gated tool registration.
- **Definition:**
  ```ts
  export type Lane = "bridge" | "operator";
  ```

#### `AwsClients`
- **Kind:** interface (exported)
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/src/index.ts:56`
- **Purpose:** Bundle of AWS SDK clients used by the extension; uses `Pick<...,"send">` so tests can substitute lightweight fakes.
- **Fields:**
  ```ts
  export interface AwsClients {
    ssm: Pick<SSMClient, "send">;
    sqs: Pick<SQSClient, "send">;
    s3:  Pick<S3Client, "send">;
    cwl: Pick<CloudWatchLogsClient, "send">;
  }
  ```

#### `SsmGetSecretInput`
- **Kind:** TypeBox schema → static type `Static<typeof SsmGetSecretInput>`
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/src/index.ts:85`
- **Purpose:** Parameters for the `ssm_get_secret` tool. Secret value is exfiltrated to `process.env`, never returned to the LLM.
- **Fields:**
  - `name: string` — SSM parameter name (e.g. `/covent/pi/slack/bot_token`).
  - `export_as: string` — env var name to receive the secret (validated against `/^[A-Z][A-Z0-9_]{0,127}$/`).
  - `with_decryption?: boolean`

#### `SqsSendEventInput`
- **Kind:** TypeBox schema → `Static<typeof SqsSendEventInput>`
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/src/index.ts:94`
- **Purpose:** Parameters for the `sqs_send_event` tool used to hand off work between Pi lanes.
- **Fields:**
  - `queue_url: string`
  - `body: string` — JSON-serialized event payload.
  - `message_group_id?: string` — required for FIFO queues.

#### `S3PutArtifactInput`
- **Kind:** TypeBox schema → `Static<typeof S3PutArtifactInput>`
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/src/index.ts:104`
- **Purpose:** Parameters for the `s3_put_artifact` tool. Caller must pass exactly one of `body` (text) or `body_base64` (binary).
- **Fields:**
  - `bucket: string`
  - `key: string`
  - `body?: string`
  - `body_base64?: string`
  - `content_type?: string`

#### `CloudWatchLogAuditInput`
- **Kind:** TypeBox schema → `Static<typeof CloudWatchLogAuditInput>`
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/src/index.ts:114`
- **Purpose:** Parameters for the `cloudwatch_log_audit` tool used to record privileged operator actions.
- **Fields:**
  - `log_group: string`
  - `log_stream: string`
  - `message: string` — JSON-serialized audit event.
  - `sequence_token?: string`

#### `ExtensionOptions`
- **Kind:** interface (exported)
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/src/index.ts:205`
- **Purpose:** Build-time options for `buildExtension()`; lets tests override lane resolution, region, and client factory.
- **Fields:**
  ```ts
  export interface ExtensionOptions {
    lane?: Lane;
    region?: string;
    clientsFactory?: (region: string) => AwsClients;
  }
  ```

#### `PiRegisterToolArg`
- **Kind:** type alias (private)
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/src/index.ts:220`
- **Purpose:** Captures the parameter type Pi expects for `pi.registerTool(...)` so the TypeBox-shim cast can be contained at one boundary.
- **Definition:**
  ```ts
  type PiRegisterToolArg = Parameters<ExtensionAPI["registerTool"]>[0];
  ```

### `test/index.test.ts`

#### `RegisteredTool`
- **Kind:** interface (test-only)
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/test/index.test.ts:13`
- **Purpose:** Minimal shape recorded by the test mock when the extension calls `pi.registerTool`.
- **Fields:**
  ```ts
  interface RegisteredTool {
    name: string;
    description: string;
    execute: (id: string, params: unknown) => Promise<unknown>;
  }
  ```

#### `MockPi`
- **Kind:** interface (test-only)
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/test/index.test.ts:19`
- **Purpose:** Test double for the Pi extension API surface — captures registered tools, event handlers, and audit entries.
- **Fields:**
  ```ts
  interface MockPi {
    tools: Map<string, RegisteredTool>;
    eventHandlers: Map<string, (event: unknown) => Promise<unknown>>;
    audits: Array<{ type: string; data: unknown }>;
    api: {
      registerTool: (t: RegisteredTool) => void;
      on: (e: string, h: (event: unknown) => Promise<unknown>) => void;
      appendEntry: (type: string, data: unknown) => void;
    };
  }
  ```

#### `SendCall`
- **Kind:** interface (test-only)
- **Location:** `/home/user/covent-agent-os/packages/pi-ext-covent-aws/test/index.test.ts:48`
- **Purpose:** Records each AWS SDK `send()` invocation made through `mockClients` so assertions can inspect command name and input.
- **Fields:**
  ```ts
  interface SendCall {
    commandName: string;
    input: Record<string, unknown>;
  }
  ```

---

## skills/yesterdays-pi-context-prime/scripts/

### `build_pi_session_audit.py`

#### `SessionMeta`
- **Kind:** Python `@dataclass`
- **Location:** `/home/user/covent-agent-os/skills/yesterdays-pi-context-prime/scripts/build_pi_session_audit.py:155`
- **Purpose:** Aggregated metadata + sampled excerpts collected per Pi session JSONL log file. Serialized to JSON via `dataclasses.asdict()` for the audit index.
- **Fields:**
  ```python
  @dataclass
  class SessionMeta:
      path: str
      rel_path: str
      size_bytes: int
      group_key: str
      kind: str
      session_id: str | None = None
      header_timestamp: str | None = None
      cwd: str | None = None
      parent_session: str | None = None
      session_name: str | None = None
      first_timestamp: str | None = None
      last_timestamp: str | None = None
      entries: int = 0
      messages: int = 0
      user_messages: int = 0
      assistant_messages: int = 0
      tool_results: int = 0
      bash_executions: int = 0
      compactions: int = 0
      branch_summaries: int = 0
      tool_calls: int = 0
      models: list[str] = field(default_factory=list)
      thinking_levels: list[str] = field(default_factory=list)
      user_prompt_excerpts: list[str] = field(default_factory=list)
      assistant_response_excerpts: list[str] = field(default_factory=list)
      transcript_path: str | None = None
  ```

---

## Files audited but containing no type definitions

These files were read in full and contain no `interface`, `type`, `enum`, `class`, `dataclass`, `TypedDict`, `Protocol`, etc. — they consume types but do not declare any:

- `/home/user/covent-agent-os/extensions/permission-gate.ts` — only a default-exported registration function.
- `/home/user/covent-agent-os/extensions/env-guard.ts` — module-level `RegExp[]` constants and helper functions only.
- `/home/user/covent-agent-os/extensions/git-checkpoint.ts` — uses `Map<string, string>` inline; no own types.
- `/home/user/covent-agent-os/extensions/browser-use-tools.ts` — only TypeBox `Type.Object(...)` registered inline as tool parameters, not extracted to a named symbol.
- `/home/user/covent-agent-os/packages/pi-chrome-access/extensions/chrome-access.ts` — registration logic only.
- `/home/user/covent-agent-os/apps/pi-mom/.slack/get-manifest.py` — small CLI shim, no class.

## Notes / gaps

- The repo is intentionally light on TypeScript: most logic lives in `.mjs` files (Pi-mom adapter, scripts) without JSDoc, so there are no static type artifacts to document there.
- TypeBox schemas above (`SsmGetSecretInput`, etc.) are *runtime* values; their compile-time types only exist via `Static<typeof X>`. They are listed because they function as the canonical type description for those tool inputs.
- Inline TypeBox schemas inside `pi.registerTool({ parameters: Type.Object({...}) })` calls (in `browser-use-tools.ts`, `chrome-access.ts`, and `linear-tools.ts`) are not separately named and are documented in prose at their tool registration sites rather than as standalone type entries.
- No external `.d.ts` ambient declarations, no Pydantic models, no Go/Rust/Java/Kotlin/Swift/Proto/GraphQL files exist in the repo.
