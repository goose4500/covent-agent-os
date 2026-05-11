# Architecture

## Operating model

```text
Slack cockpit
  → pi-mom route detection / ack / progress / final response
  → Pi skill/agent/runtime or direct bounded tool
  → artifacts/source links
  → optional declared-route + current-approval mutation into Linear/GitHub/Slack/Whimsical
```

## Team-facing primitive: Actions

The engineering team should not have to understand Pi internals to use internal AI.

Use **Actions** as the product primitive:

```text
Action = a bounded, named thing Covent Agent can do for an engineer
Run = one execution of an Action
Artifact = the source-linked result of a Run
Approval = a human gate before risky execution
```

Implementation terms such as routes, skills, agents, extensions, runners, and policies stay behind the curtain. Slack UX should say things like “Run Action”, “Action running”, and “Action complete”.

This mirrors Pi’s core design: small harness, discoverable capabilities, progressive disclosure, and file-based extensibility.

## Layers

1. **Apps** — concrete runtimes such as `apps/pi-mom`.
2. **Actions/registry** — agent-readable catalog of team-facing AI actions and their policy/runner bindings.
3. **Skills/agents** — reusable reasoning workflows and specialist subagents behind actions.
4. **Extensions/lib** — bounded tools and shared implementation code.
5. **Packages** — installable Pi packages, e.g. Chrome browser access.
6. **Docs/specs/runbooks** — source-linked operating knowledge.

## Current POC priorities

1. Make `apps/pi-mom` reliable locally.
2. Preserve and validate GPT Image route and Slack output behavior.
3. Keep Linear/source-of-truth writes explicit, source-linked, and approval-gated by route.
4. Make repo docs canonical and Whimsical visual, then productionize.
