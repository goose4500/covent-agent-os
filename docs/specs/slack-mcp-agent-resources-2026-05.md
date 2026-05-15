# Slack MCP + Agent Developer Resources — May 2026

Research note for issue #97: add Slack MCP, developer skills, and resources
without duplicating the existing `slack-cli` and `slack-dev-fundamentals` skills.

## Summary

Slack’s 2026 agent surface has three complementary layers:

| Layer | Use it for | Primary docs |
|---|---|---|
| Slack MCP Server | MCP clients/hosts that need Slack tools discovered at runtime | https://docs.slack.dev/ai/mcp-server/ |
| Real-time Search API | User-scoped Slack context retrieval inside AI-enabled Slack apps | https://docs.slack.dev/apis/web-api/real-time-search-api |
| Web API / Bolt / Block Kit | Deterministic product behavior, app runtime, writes, UI, tests | https://docs.slack.dev/tools/ |

The repo already has general Slack development skills. The useful addition is a
curated Slack MCP + agent UX skill that routes agents toward the right Slack
surface, makes safety boundaries explicit, and links official resources.

## Key findings

### Slack MCP Server

- Slack hosts the MCP server at `https://mcp.slack.com/mcp`.
- Transport is JSON-RPC 2.0 over Streamable HTTP.
- Tools cover searching Slack, retrieving/sending messages, users, channels,
  emoji, conversations, reactions, and canvases.
- MCP access is for internal apps or Marketplace/directory-published apps.
- It uses confidential OAuth with user authorization.
- Treat multi-MCP setups as a security boundary: do not pass Slack context to
  untrusted tools or servers.

### Real-time Search API

- `assistant.search.context` searches messages, files, channels, and users.
- Bot-token calls need an `action_token` from Slack events; user-token calls do
  not.
- Results include permalinks and context messages useful for citations.
- Slack warns not to store/copy retrieved data or use it for model training.
- Optimize for fewer than 10 search calls per user inquiry because rate limits
  are tight and paginated calls count.

### Agents & AI Apps

- Slack agent loop: receive input → reason → call tools → stream/render output →
  repeat when needed.
- Useful primitives: assistant threads, suggested prompts, status indicators,
  streaming, task/plan updates, citations, feedback controls, and graceful
  failure states.
- Explicit user control is a design requirement for writes: send/update/delete,
  channel/canvas creation, and actions taken on behalf of a user should be
  previewed and approved.

### Block Kit for agent UX

- Slack is expanding Block Kit for agentic responses with structured components
  such as Card, Alert, Carousel, Data Table, and work-object/code patterns.
- Use Block Kit to turn agent output into an actionable cockpit: summaries,
  approvals, choices, modals, progress, warnings, and citations.
- Verify component availability against current docs/Builder before shipping a
  specific new block type.

## Recommended repo changes

Implemented in this PR:

- Add `skills/slack-mcp-agent-ux/SKILL.md` as a compact May 2026 router skill.
- Update `skills/slack-dev-fundamentals/SKILL.md` to point deep Slack MCP/agent
  tasks at the new skill.
- Add this research note under `docs/specs/` as an issue-linked reference.

## Suggested definition of done for issue #97

- Existing Slack skills are not duplicated.
- Agents have a clear MCP vs RTS vs Web API decision tree.
- Official Slack resources are collected in one place.
- Safety rules cover Slack data boundaries, prompt injection, tokens, and
  approval-gated writes.
- Examples avoid secrets and default to draft/preview before mutation.

## Official resource index

- Slack MCP Server overview: https://docs.slack.dev/ai/mcp-server/
- Developing with Slack MCP: https://docs.slack.dev/ai/slack-mcp-server/developing
- Slack MCP + RTS announcement: https://docs.slack.dev/changelog/2026/02/17/slack-mcp
- Real-time Search API: https://docs.slack.dev/apis/web-api/real-time-search-api
- `assistant.search.context`: https://docs.slack.dev/reference/methods/assistant.search.context
- Building agents: https://docs.slack.dev/ai/agents
- Developing agents: https://docs.slack.dev/ai/developing-agents
- Agent design: https://docs.slack.dev/ai/agent-design/
- Agent quickstart: https://docs.slack.dev/ai/agent-quickstart
- Block Kit: https://docs.slack.dev/block-kit/
- Agent Block Kit components blog: https://slack.dev/build-richer-agent-experiences-with-block-kit
- Block Kit Builder: https://app.slack.com/block-kit-builder
- Slack developer tools: https://docs.slack.dev/tools/
- Slack CLI: https://docs.slack.dev/tools/slack-cli/
- Bolt JS Slack MCP sample: https://github.com/slack-samples/bolt-js-slack-mcp-server
