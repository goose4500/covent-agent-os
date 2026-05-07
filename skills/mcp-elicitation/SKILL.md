---
name: mcp-elicitation
description: Build MCP tools that ask the user for structured input during a tool call, including forms and auth flows.
---


# MCP Elicitation — Master Skill

> **FastMCP v3.1+** (March 2026). Install: `pip install fastmcp`
> Import: `from fastmcp import FastMCP, Context`

MCP elicitation lets servers request structured input from users mid-task. Instead of failing when
they need a credential, a preference, or a decision, servers send an interactive dialog and wait.
This skill covers **building servers** (FastMCP v3), **combining elicitation with other Context
capabilities**, and **configuring Claude Code hooks** to handle requests.

## Decision Router

| Goal | Go to |
|------|-------|
| Build a FastMCP tool that asks the user for input | [Server-Side: FastMCP Elicitation](#server-side-fastmcp-elicitation) |
| Choose between form mode and URL mode | [Mode Selection](#mode-selection) |
| Design the schema for form fields | `references/schema-reference.md` |
| Combine elicitation with progress, state, sampling, tasks | `references/power-combinations.md` |
| Wrap an AI agent with human-in-the-loop elicitation | `references/power-combinations.md` → Agent Handoff |
| Write hooks to auto-respond or validate elicitation | [Client-Side: Claude Code Hooks](#client-side-claude-code-hooks) |
| Debug elicitation not working | [Troubleshooting](#troubleshooting) |
| Understand the protocol details | `references/server-patterns.md` |

---

## Core Concepts

Elicitation has **two modes**:

- **Form mode** — server sends a JSON Schema, Claude Code renders form fields, user fills them in.
  Use for: preferences, configuration, non-sensitive structured data.
- **URL mode** — server sends a URL, Claude Code opens it in the browser.
  Use for: OAuth flows, payment pages, credential entry — anything sensitive that must NOT pass through the MCP client.

Elicitation has **three response actions**:

| Action | Meaning | Has content? |
|--------|---------|-------------|
| `accept` | User submitted data (form) or consented to navigate (URL) | Form: yes, URL: no |
| `decline` | User explicitly refused | No |
| `cancel` | User dismissed without choosing | No |

---

## Server-Side: FastMCP Elicitation

### Form Mode — `ctx.elicit()`

```python
from fastmcp import FastMCP, Context
from pydantic import BaseModel, Field
from mcp.server.elicitation import (
    AcceptedElicitation,
    DeclinedElicitation,
    CancelledElicitation,
)

mcp = FastMCP("my-server")

class DeployConfig(BaseModel):
    environment: str = Field(description="Target environment")
    dry_run: bool = Field(default=True, description="Preview without applying?")
    replicas: int = Field(default=1, description="Number of replicas")

@mcp.tool()
async def deploy(ctx: Context) -> str:
    result = await ctx.elicit(
        message="Configure deployment settings",
        response_type=DeployConfig,
    )

    match result:
        case AcceptedElicitation(data=config):
            return f"Deploying to {config.environment} with {config.replicas} replicas"
        case DeclinedElicitation():
            return "Deployment cancelled by user"
        case CancelledElicitation():
            return "Deployment dismissed"
```

**Schema rules:**
- Primitive fields only: `str`, `int`, `float`, `bool`, `list[str]`
- No nested models — flat objects only (MCP spec restriction)
- `Field(description=...)` for field labels, `Field(default=...)` to pre-populate
- `Literal["a", "b", "c"]` or `Enum` for dropdowns; `list[TagEnum]` for multi-select (v2.14+)
- Confirmation dialogs: `response_type=None` (no fields, just a yes/no)
- FastMCP validates automatically — `data` is a typed instance

### URL Mode — `ctx.elicit_url()`

For sensitive interactions that must happen out-of-band (OAuth, credential entry, payment).

```python
import uuid
from mcp.server.elicitation import AcceptedUrlElicitation

@mcp.tool()
async def connect_github(ctx: Context) -> str:
    elicitation_id = str(uuid.uuid4())

    result = await ctx.elicit_url(
        message="Please authorize GitHub access to continue",
        url=f"https://my-server.com/oauth/github?eid={elicitation_id}",
        elicitation_id=elicitation_id,
    )

    match result:
        case AcceptedUrlElicitation():
            # User consented to open URL — does NOT mean auth is complete
            return "Authorization started — waiting for callback..."
        case DeclinedElicitation():
            return "Authorization declined"
        case CancelledElicitation():
            return "Authorization cancelled"
```

After the out-of-band flow completes, send a completion notification:

```python
await ctx.session.send_elicit_complete(elicitation_id)
```

### Mode Selection

| Collecting | Mode | Why |
|-----------|------|-----|
| User preferences, config options | Form | Structured, validated, stays in MCP |
| API keys, passwords, tokens | URL | MUST NOT pass through MCP client (spec requirement) |
| OAuth authorization | URL | Browser-based flow, server handles callback |
| Payment / billing | URL | PCI compliance requires out-of-band |
| Simple confirmations ("proceed?") | Form | `response_type=None` or single boolean |
| Multi-field structured data | Form | Pydantic model maps directly |

### Advanced Server Patterns

Read `references/server-patterns.md` for: chaining multiple elicitations, conditional elicitation,
`URLElicitationRequiredError` (code `-32042`) for lazy auth, URL mode OAuth flows, low-level
`ServerSession` API, and capability negotiation.

---

## Power Combinations

Elicitation becomes transformative when combined with other `Context` capabilities. These are
the patterns that make MCP elicitation more than just "ask a question":

| Pattern | What it does | Key `ctx` methods |
|---------|-------------|-------------------|
| **+ Session State** | Ask once, remember all session | `elicit()` + `set_state()` / `get_state()` |
| **+ Progress** | Supervised batch processing with human checkpoints | `elicit()` + `report_progress()` |
| **+ Structured Content** | Elicit, then return typed JSON for tool chaining | `elicit()` + `output_schema` |
| **+ Dynamic Visibility** | Elicit user role, then show/hide tools | `elicit()` + `enable_components()` |
| **+ Background Tasks** | Durable approval gates that survive disconnects | `elicit()` + `@mcp.tool(task=True)` |
| **+ Sampling** | Elicit prefs → LLM generates → elicit approval | `elicit()` + `sample()` |
| **Agent Handoff** | Any AI agent asks humans via elicitation | `elicit()` as `human_callback` |

Read `references/power-combinations.md` for full code examples of each pattern.

**Claude Code gap**: Claude Code does **not** support MCP sampling (`ctx.sample()`). Use FastMCP's
`AnthropicSamplingHandler` or `OpenAISamplingHandler` with your own API key as a fallback.

---

## Client-Side: Claude Code Hooks

Claude Code v2.1.76+ supports two hooks for intercepting elicitation:

### `Elicitation` Hook

Fires when an MCP server requests input. Auto-respond programmatically to skip the dialog.

```json
{
  "hooks": {
    "Elicitation": [
      {
        "matcher": "my-mcp-server",
        "hooks": [
          { "type": "command", "command": "python3 /path/to/handle_elicitation.py" }
        ]
      }
    ]
  }
}
```

The `matcher` matches against the **MCP server name**.

**Hook receives on stdin:**

```json
{
  "session_id": "abc123",
  "hook_event_name": "Elicitation",
  "mcp_server_name": "my-mcp-server",
  "message": "Please provide your API key",
  "mode": "form",
  "elicitation_id": "elicit-123",
  "requested_schema": {
    "type": "object",
    "properties": {
      "api_key": { "type": "string", "description": "Your API key" }
    }
  }
}
```

**Hook outputs on stdout to auto-respond:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Elicitation",
    "action": "accept",
    "content": { "api_key": "sk-..." }
  }
}
```

**Exit code 2** = deny the elicitation (stderr shown to user).

**Example — auto-fill from env vars:**

```python
#!/usr/bin/env python3
"""Auto-respond to elicitation requests using environment variables."""
import json, os, sys

request = json.load(sys.stdin)
server = request.get("mcp_server_name", "")
properties = request.get("requested_schema", {}).get("properties", {})

# MY_SERVER_FIELD_NAME -> field value
prefix = server.upper().replace("-", "_") + "_"
content = {}
for field_name in properties:
    value = os.environ.get(prefix + field_name.upper())
    if value is not None:
        content[field_name] = value

if content:
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "Elicitation",
            "action": "accept",
            "content": content,
        }
    }, sys.stdout)
# No output = fall through to interactive dialog
```

### `ElicitationResult` Hook

Fires **after** the user responds, **before** the response goes to the server. Validate, sanitize, audit, or block.

```json
{
  "hooks": {
    "ElicitationResult": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "python3 /path/to/validate_elicitation.py" }
        ]
      }
    ]
  }
}
```

**Example — audit logger + validator:**

```python
#!/usr/bin/env python3
"""Log all elicitation responses and validate email fields."""
import json, re, sys
from datetime import datetime
from pathlib import Path

request = json.load(sys.stdin)
content = request.get("content", {})
server = request.get("mcp_server_name", "")

# Audit log
log = {"ts": datetime.utcnow().isoformat(), "server": server,
       "action": request.get("action"), "fields": list((content or {}).keys())}
with open(Path.home() / ".claude" / "elicitation-audit.jsonl", "a") as f:
    f.write(json.dumps(log) + "\n")

# Block invalid emails
if content:
    for key, value in content.items():
        if "email" in key.lower() and isinstance(value, str):
            if not re.match(r"^[^@]+@[^@]+\.[^@]+$", value):
                print(f"Invalid email in field '{key}'", file=sys.stderr)
                sys.exit(2)  # Block the response
```

### More Hook Patterns

Read `references/hook-patterns.md` for: multi-server routing, secret manager integration
(1Password, AWS SSM), policy enforcement, rate limiting, chaining hooks, URL mode validation,
and local testing.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Elicitation dialog never appears | Server doesn't declare elicitation capability | Server must negotiate `elicitation` in capabilities |
| "Method not found" error | Client doesn't support elicitation | Update Claude Code to v2.1.76+ |
| Form fields don't render | Nested/complex schema | Flat objects with primitives only — no nested models |
| Hook doesn't fire | Wrong matcher pattern | Matcher matches `mcp_server_name` — check exact name |
| Hook fires but dialog still shows | Hook has no stdout output | Must print JSON to stdout to suppress dialog |
| `_validate_elicitation_schema()` error | Non-primitive Pydantic field | Only `str`, `int`, `float`, `bool`, `list[str]` |
| URL mode `accept` but auth not done | Accept = consented to navigate, not completion | Wait for `notifications/elicitation/complete` |
| `-32042` error from server | Server requires URL elicitation | Handle `URLElicitationRequiredError` |
| `ctx.sample()` fails in Claude Code | Claude Code doesn't support MCP sampling | Use `AnthropicSamplingHandler` or `OpenAISamplingHandler` fallback |
| Elicitation lost after disconnect | No durable storage | Use `@mcp.tool(task=True)` with Redis backend |
| `schema=` parameter not found | FastMCP v3 renamed to `response_type` | Use `response_type=MyModel` (not `schema=`) |

---

## Quick Reference

### Imports

```python
# FastMCP v3.1+ (recommended)
from fastmcp import FastMCP, Context

# Elicitation result types (from MCP SDK)
from mcp.server.elicitation import (
    AcceptedElicitation,      # Form accepted — has .data
    AcceptedUrlElicitation,   # URL accepted — no data
    DeclinedElicitation,      # User refused
    CancelledElicitation,     # User dismissed
)
```

### Result Types

| Result type | `.data` | When |
|------------|---------|------|
| `AcceptedElicitation[T]` | Validated `T` instance | Form: user submitted |
| `AcceptedUrlElicitation` | None | URL: user consented to navigate |
| `DeclinedElicitation` | None | User explicitly refused |
| `CancelledElicitation` | None | User dismissed / closed |

### Context Methods (commonly combined with elicitation)

| Method | Purpose |
|--------|---------|
| `ctx.elicit(message, response_type=Model)` | Request structured input |
| `ctx.elicit_url(message, url, elicitation_id)` | Request URL navigation |
| `ctx.set_state(key, value)` / `ctx.get_state(key)` | Session-scoped memory |
| `ctx.report_progress(current, total, message)` | Progress updates |
| `ctx.sample(messages, result_type=Model)` | LLM generation from tool |
| `ctx.enable_components(...)` / `ctx.disable_components(...)` | Dynamic tool visibility |
| `ctx.info(msg)` / `ctx.warning(msg)` | Logging |

### Hook Event Summary

| Hook | When | Can do | Exit 2 = |
|------|------|--------|----------|
| `Elicitation` | Server requests input | Auto-respond, skip dialog | Deny request |
| `ElicitationResult` | User responded | Validate, sanitize, block | Block response |
