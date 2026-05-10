# Architecture

## Operating model

```text
Slack cockpit
  → authorized mention/slash command selects a route/profile
  → pi-mom route detection / ack / progress / final response
  → Pi skill/agent/runtime on the trusted EC2 operator substrate or direct bounded tool
  → route/profile-allowed context from Slack/Linear/GitHub/docs/tools
  → route/profile-allowed mutation into Linear/GitHub/Slack/docs/artifacts
  → source links, audit trail, rollback/kill-switch path
```

## Trusted internal speed mode

Covent internal speed mode favors execution over repeated approval prompts. For authorized team members, an explicit Slack invocation is approval for the selected route/profile and its documented context, tools, and mutations. Broad Slack manifest scopes and MCP/tool permissions are acceptable when they are bound to declared profiles, observable, redacted, and revocable.

EC2 is the always-on trusted Pi operator substrate: a shared Linux workbench for shell, filesystem, repo context, generated artifacts, checks, and long-running agent workflows. EC2 runtime state is not canonical truth; durable outcomes still land in Linear, Git/GitHub, and repo docs.

## Layers

1. **Apps** — concrete runtimes such as `apps/pi-mom`.
2. **Skills/agents** — reusable reasoning workflows and specialist profiles.
3. **Extensions/lib** — bounded tools and shared implementation code.
4. **Packages** — installable Pi packages, e.g. Chrome browser access.
5. **EC2 operator substrate** — always-on trusted company machine for Pi execution, workspaces, artifacts, and checks.
6. **Docs/specs/runbooks** — source-linked operating knowledge.

## Current POC priorities

1. Make `apps/pi-mom` reliable from the trusted runtime lane.
2. Preserve and validate GPT Image route and Slack output behavior.
3. Keep Linear/source-of-truth writes explicit, source-linked, and route/profile-authorized by Slack invocation.
4. Make repo docs canonical and Whimsical visual, then productionize with audit, redaction, and kill-switch controls.
