---
name: context7-docs
description: Use Context7 for up-to-date, version-specific external library/framework/API documentation in Pi. Trigger when answering or coding against package APIs, SDKs, framework setup/configuration, code examples, migrations, or when the user says "use context7".
---

# Context7 Docs

Context7 is available in Pi through `pi-mcp-adapter` as the MCP server `context7`.

## When to use

Use Context7 before relying on model memory when the task depends on current external docs:
- package/framework APIs, SDK calls, configuration, setup, migrations, or version-specific behavior
- code examples for libraries not defined in the local repository
- user explicitly says `use context7`

Do **not** use Context7 for local repo APIs, private project conventions, or general conceptual explanations unless current external docs matter.

## Tool workflow

Preferred via MCP proxy (always safe after `/reload`):
1. If the user did not provide a Context7 library ID (`/org/project` or `/org/project/version`), resolve it:
   ```text
   mcp({ tool: "context7_resolve-library-id", args: '{"libraryName":"next.js","query":"App Router middleware auth"}' })
   ```
2. Query the docs with a specific task-oriented query:
   ```text
   mcp({ tool: "context7_query-docs", args: '{"libraryId":"/vercel/next.js","query":"middleware authentication in App Router"}' })
   ```

If direct Context7 tools are available in the current session, use them directly instead of the proxy. Tool names are server-prefixed by Pi's MCP adapter: `context7_resolve-library-id` and `context7_query-docs`.

## Response rules

- Prefer exact/versioned library IDs returned by Context7.
- Make the query specific; avoid one-word queries like `auth` or `hooks`.
- Summarize only the relevant docs, then explain implementation implications.
- Mention the Context7 library ID used. If Context7 has no matching docs, say so and fall back to official docs/web search.
- Never store API keys in repo files; use `CONTEXT7_API_KEY` or Pi MCP headers only if the user provides a key.
