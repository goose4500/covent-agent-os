# Architecture

## Operating model

```text
Slack cockpit
  → pi-mom route detection / ack / progress / final response
  → Pi skill/agent/runtime or direct bounded tool
  → artifacts/source links
  → optional declared-route + current-approval mutation into Linear/GitHub/Slack/Whimsical
```

## Layers

1. **Apps** — concrete runtimes such as `apps/pi-mom`.
2. **Skills/agents** — reusable reasoning workflows and specialist subagents.
3. **Extensions/lib** — bounded tools and shared implementation code.
4. **Packages** — installable Pi packages, e.g. Chrome browser access.
5. **Docs/specs/runbooks** — source-linked operating knowledge.

## Current POC priorities

1. Make `apps/pi-mom` reliable locally.
2. Preserve and validate GPT Image route and Slack output behavior.
3. Keep Linear/source-of-truth writes explicit, source-linked, and approval-gated by route.
4. Make repo docs canonical and Whimsical visual, then productionize.
