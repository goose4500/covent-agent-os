---
name: api-to-mcp
description: Research any third-party API and ship a working FastMCP server for it in one pass. Use whenever the user says "/api-to-mcp", "build an MCP for [X]", "turn [API] into an MCP server", "wrap [service] as MCP", "make an MCP from [docs URL or OpenAPI spec]", or mentions wanting to integrate a new SaaS/API into Claude Code as tools. This skill fetches the OpenAPI spec (or reconstructs one), writes an Obsidian artifact documenting the API, generates a single-file uv FastMCP server using FastMCP 3.2+ `from_openapi`, and installs it into Claude Code. Default to this skill for any request that ends with "…and hook it into Claude" or "…and give me MCP tools for it.
---


# api-to-mcp

Ship a working Claude Code MCP server for any third-party API in one session — researched, documented, generated, installed.

Pipeline (5 phases, ~5 minutes wall clock):

1. **Locate** the OpenAPI spec, or confirm we have to reconstruct one.
2. **Research** the API in a single subagent that fires WebFetch calls in parallel — produces an Obsidian artifact.
3. **Materialize** `openapi.yaml` alongside the research notes.
4. **Generate** a PEP 723 uv script that calls `FastMCP.from_openapi()` at startup.
5. **Install** via `fastmcp install claude-code` (user scope) and verify.

Fail early at any phase and tell the user what's missing — do not fabricate endpoints.

---

## Phase 1 — Locate the spec (sequential, fast)

Before spawning any research, probe for an authoritative spec. Most modern APIs publish one; pulling it directly is vastly better than reconstructing from prose.

Use `scripts/find_openapi_spec.py <api-name-or-base-url>` — it probes the common paths in parallel:

```
/openapi.json  /openapi.yaml  /openapi/v1  /v1/openapi.json
/swagger.json  /swagger/v1/swagger.json  /api-docs  /docs/openapi.json
```

It also checks GitHub for `{org}/{name}-openapi` and `{org}/openapi-specifications`-style repos via the GitHub search API (no auth needed for public repos).

**Inputs it accepts:**
- Bare name (`stripe`, `resend`, `hunter`) — script resolves to likely base URL.
- Full base URL (`https://api.example.com`).
- Direct spec URL (skips probing, validates and moves on).
- Local file path (skips probing).

**If a spec is found**, save to `~/.claude/skills/api-to-mcp/workspace/[api]/openapi.yaml` and skip reconstruction in Phase 3. If not, flag it — the research agent will need to build one.

## Phase 2 — Single parallel research agent

Spawn exactly one subagent. Do not fan out to 5 agents — research is I/O-bound on WebFetch, and a single agent making parallel tool calls is faster and cheaper than coordinating a fleet. If the API is genuinely massive (Stripe, Shopify, Salesforce — 500+ endpoints), split into two agents along spec-vs-context lines per `references/research-agent-prompts.md`. Otherwise: one.

Use the prompt template in `references/research-agent-prompts.md` → "Single-agent default". Customize the `{api_name}` and `{docs_url}` fields. The agent's contract:

- Fires WebFetch calls **in parallel** (the skill prompt explicitly instructs this — do not let the agent serialize).
- Writes to the Obsidian vault at `/home/jfloyd/obsidian-vault/07_Solutions/pipelines/[api]-mcp/`:
  - `index.md` — frontmatter + one-page summary with wikilinks
  - `auth.md` — auth type, token acquisition, scopes, env var name
  - `endpoints.md` — grouped resource catalog with pagination style noted
  - `quirks.md` — rate limits, errors, idempotency, SDK caveats, webhook signatures
  - `openapi.yaml` — ONLY if no upstream spec was found (reconstructed)
- Returns a short structured report: `{base_url, auth_env_var, auth_header_format, exclude_patterns[], server_name}`. We need these to template the server.

The agent MUST NOT install anything or run `fastmcp` commands — that's Phase 5.

## Phase 3 — Materialize the spec

If Phase 1 found a published spec, copy it into the vault directory next to `index.md` (so the artifact is self-contained for reuse).

If Phase 2 reconstructed one, validate it with:

```bash
uvx openapi-spec-validator workspace/[api]/openapi.yaml
```

If validation fails, fix the 1-2 common issues (missing `info.version`, nullability, `operationId` collisions) and re-run. Do not ship an invalid spec — `from_openapi` will silently drop malformed paths.

## Phase 4 — Generate the server

Run `scripts/generate_server.py` with the structured report from Phase 2:

```bash
python scripts/generate_server.py \
  --api-name stripe \
  --base-url https://api.stripe.com \
  --auth-env STRIPE_API_KEY \
  --auth-header "Bearer {token}" \
  --spec workspace/stripe/openapi.yaml \
  --out ~/mcp/tools/stripe_mcp.py
```

The script fills `assets/server_template.py` — a PEP 723 uv script that loads the spec at runtime and calls `FastMCP.from_openapi()` with sensible `RouteMap` defaults (GET-with-path-param → `RESOURCE_TEMPLATE`, health/admin paths → `EXCLUDE`). Read `references/fastmcp-3.2-reference.md` before editing the template — the API changed between 2.x and 3.x.

The generated server is self-contained: the spec is copied next to it so the script runs from anywhere with only `uv` installed.

## Phase 5 — Install and verify

```bash
fastmcp install claude-code ~/mcp/tools/[api]_mcp.py \
  --name [api] \
  --with httpx --with pyyaml \
  --env [AUTH_ENV_VAR]="$([api_key_from_secrets])"
```

The flag is `--name` / `-n`, not `--server-name`. The positional argument is a SERVER-SPEC (Python file path, optionally `file.py:object_name`).

If `~/.secrets` doesn't have the key, do NOT prompt interactively — instead, print the exact `claude mcp add` command the user should run after setting their env var, and stop. Non-interactive is load-bearing: the skill must be re-runnable in CI and subagents.

Verify:

```bash
claude mcp list | grep [api]
```

Append an install record to `[api]-mcp/index.md`:

```markdown
## Install record
- Installed: 2026-04-13
- Scope: user
- Server path: ~/mcp/tools/[api]_mcp.py
- Env var: [AUTH_ENV_VAR]
- Tool count: [N]  (from `fastmcp inspect ~/mcp/tools/[api]_mcp.py`)
```

Then tell the user: the server is live, restart Claude Code to pick it up, and point them at the vault artifact for reference.

---

## Design rationale (read this before modifying)

- **Why one research agent, not five.** Fan-out helps when tasks need isolated context or produce independent deep artifacts (see `api-recon` for the exception). For API research, the bottleneck is WebFetch latency, and a single agent instructed to make parallel tool calls gets the same speedup without coordination overhead. Five agents of 1k-token summaries cost more than one agent of 5k tokens.
- **Why the spec lives in Obsidian.** Future work (re-generating the server after an API update, writing a client SDK, auditing surface area) needs one canonical home. The vault is already the second brain.
- **Why PEP 723 uv scripts.** Zero install friction, reproducible, versionable. `fastmcp install claude-code` natively understands them.
- **Why `from_openapi` at runtime, not codegen.** Spec updates mean just replacing `openapi.yaml` next to the script — no re-running a generator. The server is ~30 lines regardless of API size.
- **Why stub auth instead of prompting.** See `feedback_*` pattern — interactive prompts break subagent and CI re-runs. Print the exact command, let the user execute it.

## Files in this skill

- `scripts/find_openapi_spec.py` — parallel spec probe, returns path or "not found"
- `scripts/generate_server.py` — templates the uv script from Phase 2 report
- `assets/server_template.py` — PEP 723 FastMCP.from_openapi boilerplate
- `references/fastmcp-3.2-reference.md` — canonical FastMCP 3.2+ API (supersedes the stale vault note)
- `references/research-agent-prompts.md` — the single-agent and split-agent prompt templates
- `references/route-mapping-recipes.md` — common `RouteMap` patterns (exclude admin, GET-with-param → resource, etc.)
