# Context7 for Pi Agent Harness — Research + Subagent Spec

Date: 2026-05-06

## Goal

Add Context7 to Pi so the main agent and subagents can fetch up-to-date, version-specific external library/framework documentation before writing code or giving SDK/API guidance.

## Research summary

Context7 is an AI documentation platform exposed as an MCP server. It addresses stale model training data by fetching current docs, API references, and examples from indexed source documentation.

Official integration facts:

- Remote MCP endpoint: `https://mcp.context7.com/mcp`
- OAuth remote endpoint: `https://mcp.context7.com/mcp/oauth`
- Local stdio package: `@upstash/context7-mcp`
- Local command: `npx -y @upstash/context7-mcp --api-key YOUR_API_KEY`
- API key: optional for basic public docs; recommended for higher limits/private sources. Do not store keys in repo/config unless explicitly approved.
- Core MCP tools:
  - `resolve-library-id` — search by package/product name and return Context7-compatible IDs like `/vercel/next.js`.
  - `query-docs` — fetch task-relevant docs/examples for a library ID.
- Workflow: resolve the library ID unless the user already supplied `/org/project` or `/org/project/version`, then query docs with a specific implementation question.

Sources:

- https://context7.com/docs/overview.md
- https://context7.com/docs/resources/all-clients.md
- https://context7.com/docs/resources/developer.md
- https://context7.com/docs/agentic-tools/ai-sdk/tools/resolve-library-id.md
- https://context7.com/docs/agentic-tools/ai-sdk/tools/query-docs.md
- https://context7.com/docs/clients/cli.md

## Chosen Pi architecture

Use the existing `pi-mcp-adapter` package already installed in Pi.

Why this is best:

1. Pi already has MCP adapter configured globally.
2. Remote HTTP Context7 is the official recommended setup and avoids local `npx` cold-start/install churn.
3. Context7 only has two tools, so direct tools are cheap enough to expose.
4. Subagents can opt into direct MCP tools using `mcp:context7` in agent frontmatter.
5. No API key was available in the environment, so the config uses unauthenticated public access. Upgrade path is adding a `CONTEXT7_API_KEY` header later.

## Config applied

Updated: `~/.pi/agent/mcp.json`

```json
"context7": {
  "url": "https://mcp.context7.com/mcp",
  "auth": false,
  "lifecycle": "lazy",
  "idleTimeout": 10,
  "directTools": ["resolve-library-id", "query-docs"],
  "debug": false
}
```

Also primed: `~/.pi/agent/mcp-cache.json` with Context7 metadata for the two tools so direct tools can appear after Pi reload/restart.

Backup created: `~/.pi/agent/mcp.json.bak-context7-20260506-122150`

## Pi skill applied

Created: `~/.pi/agent/skills/context7-docs/SKILL.md`

Purpose: teach Pi when and how to use Context7 for current external docs. Trigger when the user asks about library docs, SDK/API usage, framework setup/configuration, examples, migrations, version-specific behavior, or says `use context7`.

## Subagent applied

Created: `~/.pi/agent/agents/context7-docs-researcher.md`

Purpose: a fresh-context documentation researcher with:

```yaml
tools: read, write, web_search, fetch_content, get_search_content, mcp, mcp:context7
skills: context7-docs
defaultContext: fresh
```

Smoke test result: succeeded. The subagent used `context7_resolve-library-id` and `context7_query-docs`, resolved React to `/reactjs/react.dev`, and returned a correct `useEffect` cleanup summary.

## Subagent task pack for future work

Use this spec when a coding task depends on current external library docs.

### 1. Context7 docs pass

Agent: `context7-docs-researcher`

Task template:

```text
Use Context7 to gather current docs for this implementation task: <TASK>.
Libraries/packages likely involved: <LIBRARIES>.
Resolve library IDs unless explicit /org/project IDs are supplied. Query docs with task-specific questions. Return library IDs, relevant examples/API rules, version notes, pitfalls, and a compact implementation guidance section. Do not edit files.
```

Success criteria:

- Identifies the right Context7 library ID(s)
- Uses `query-docs` for implementation-specific docs
- Notes gaps if Context7 lacks coverage
- Produces guidance another agent can implement without re-researching

### 2. Local codebase pass

Agent: `scout` or `context-builder`

Task template:

```text
Map local codebase context for this implementation task: <TASK>.
Use the Context7 findings if provided: <CONTEXT7_SUMMARY_OR_PATH>.
Find relevant files, current patterns, likely change points, existing tests, and constraints. Do not edit files. Return a handoff summary with file paths and risks.
```

Success criteria:

- Lists exact files and patterns
- Separates local conventions from external docs
- Identifies tests/validation commands

### 3. Plan synthesis

Agent: `planner`

Task template:

```text
Synthesize an implementation plan from the Context7 docs pass and local codebase pass.
Output ordered steps, files to edit, validation plan, risks, and decisions needing user approval. Do not edit files.
```

Success criteria:

- Plan traces external API decisions back to Context7 docs
- Plan is small enough for a single worker
- Escalates secrets/auth/config choices

### 4. Implementation

Agent: `worker`

Task template:

```text
Implement the approved plan only. Use the Context7 docs summary as the external API contract and the local context summary as the repo contract. Keep changes minimal. Run targeted validation. Escalate if the docs and local patterns conflict.
```

Success criteria:

- Single writer thread
- Minimal diff
- Validation run or clear explanation if not possible

### 5. Review

Agent: `reviewer`

Task template:

```text
Review the implementation against the approved plan, local conventions, and Context7 docs summary. Check for stale API usage, wrong library/version assumptions, missing tests, and overengineering. Do not edit unless explicitly asked.
```

Success criteria:

- Evidence-backed findings only
- Separates must-fix from nice-to-have

## Runnable orchestration shape

```ts
subagent({
  chain: [
    { parallel: [
      {
        agent: "context7-docs-researcher",
        task: "Use Context7 to gather current docs for: <TASK>. Libraries: <LIBRARIES>. Do not edit files.",
        output: "handoff/context7-docs.md"
      },
      {
        agent: "context-builder",
        task: "Map local repo context for: <TASK>. Do not edit files.",
        output: "handoff/local-context.md"
      }
    ] },
    {
      agent: "planner",
      task: "Read {previous} and synthesize an implementation plan with validation and risks.",
      output: "handoff/plan.md"
    }
  ],
  context: "fresh"
})
```

Then launch `worker` only after the plan is approved.

## API key upgrade path

If a Context7 API key is available, prefer environment interpolation instead of hardcoding secrets:

```json
"headers": {
  "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
}
```

Then set the key outside Pi config, e.g. shell profile, direnv, or a private env loader. Never commit or print the key.

## Validation / operations

- Current session may not show `context7` in `mcp({})` until Pi is reloaded/restarted because MCP adapter config is loaded at extension startup.
- After reload/restart, expected status includes `context7 (2 tools, cached)`.
- Direct tool names with Pi's default `toolPrefix: server` are expected as:
  - `context7_resolve-library-id`
  - `context7_query-docs`
- Proxy usage remains available through `mcp({ search: "context7" })`, `mcp({ describe: "context7_query-docs" })`, and `mcp({ tool: "context7_query-docs", args: "..." })`.

## Rollback

1. Restore `~/.pi/agent/mcp.json.bak-context7-20260506-122150` over `~/.pi/agent/mcp.json`.
2. Remove `~/.pi/agent/skills/context7-docs/`.
3. Remove `~/.pi/agent/agents/context7-docs-researcher.md`.
4. Optionally remove the `context7` entry from `~/.pi/agent/mcp-cache.json`.
