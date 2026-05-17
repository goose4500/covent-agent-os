# ADR 0016: Slack HITL tools are sequential control boundaries

Date: 2026-05-17
Status: accepted
Related: ADR 0001 (Slack app mention primary UX), ADR 0011 (native Pi tools for high-leverage workflows), ADR 0015 (CLI-first GitHub operations)

## Context

Covent Pi exposes Slack human-in-the-loop (HITL) tools so the model can ask for approval, choice, or free-form input while a Slack-triggered Pi turn is running:

- `slack_approval_card`
- `slack_choice_card`
- `slack_input_request`

These tools bridge two different runtimes:

1. **Pi agent loop** — the model emits tool calls, Pi validates and executes them, and then the model receives tool results.
2. **Slack interactivity loop** — the bridge posts Block Kit, stores a pending approval/input entry, and a later Slack button/modal action resolves the pending promise.

The bug class we hit: after the human clicked approval in Slack, the visible workflow could appear to stop until the user reprompted with "continue". The root risk is not Slack MCP; it is the ordering contract between Pi tool execution and Slack interactivity.

Pi can execute tool calls in a batch. If a HITL tool is planned in the same parallel batch as the action that depends on it, the dependent action can run too early, fail, or leave the model without a clean continuation point. Even when the Slack promise resolves correctly, the UX feels broken because the approval was not treated as a hard control boundary.

## Decision

Treat Slack HITL tools as **sequential control boundaries**.

Concretely:

1. Register every Slack HITL tool with `executionMode: "sequential"`.
2. In tool prompt guidance, instruct the model to call the HITL tool as the only tool in that assistant step.
3. After the HITL result returns:
   - `approved` / selected id / input text → continue in the same Pi turn with the dependent action.
   - `rejected`, `timeout`, or `skipped` → stop or choose a safe fallback; do not silently proceed.
4. Mutating native tools that can own their full workflow should still prefer the stronger pattern: show the approval card inside the mutating tool and execute the mutation only after approval, using server-truth previews where possible.

## Implementation shape

The code boundary is:

- `extensions/slack-interactive-tools.ts` — tool definitions and model-facing guidelines.
- `apps/pi-mom/lib/slack-ui-context.mjs` — Slack pending approval/input lifecycle.
- `apps/pi-mom/index.mjs` — Bolt action handlers resolve pending entries.
- `apps/pi-mom/lib/pi-sdk-runner.mjs` — Pi SDK session execution and tool result continuation.

The first-order fix is in the tool definitions, because Pi's agent loop already honors a per-tool `executionMode`. Marking HITL tools sequential forces Pi to execute approval/choice/input before any later tool in the same assistant step can run.

## Why not solve this only in the bridge?

The Slack bridge can post buttons and resolve promises, but it should not infer which future tool calls depend on the user's approval. That dependency belongs in the Pi tool execution contract and model guidance.

Putting the boundary in the tool definition is idiomatic because it is:

- **Local to the tool** — any surface using the Slack HITL tool inherits the ordering rule.
- **Model-visible** — guidelines tell the model how to compose the interaction.
- **Runtime-enforced** — `executionMode: "sequential"` changes Pi scheduling, not just docs.

## Alternatives considered

**Do nothing and rely on prompt guidance.** Rejected. Prompt guidance alone cannot prevent Pi from executing a parallel tool batch where a dependent tool runs beside the HITL tool.

**Move all approvals inside mutating tools.** Good pattern for high-value native tools, but incomplete. Generic choice/input/approval tools still need to exist for ambiguous decisions, drafts, missing parameters, and workflows where no native mutating wrapper exists yet.

**Teach the bridge to pause the whole Slack turn.** Rejected for now. The bridge already awaits the Slack promise; the missing contract is tool scheduling and composition, not a second pause primitive.

## Consequences

- Slack approval/choice/input tools become slightly less parallel, by design. Human interaction is the slow path anyway, so there is no meaningful latency loss.
- The active tool prompt becomes clearer: collect human judgment first, then act.
- Tests should assert the sequential execution mode so future refactors do not accidentally reintroduce parallel HITL batching.
- Native mutating tools should continue to own approval internally when they can provide a safer server-truth preview.

## Operational test

A valid live smoke test is:

1. Ask Pi to post a harmless `slack_approval_card` in the current Slack thread.
2. Approve it.
3. Confirm the same Pi turn continues and executes a harmless follow-up tool, e.g. `printf 'hitl-continuation-ok\n'`, without a user reprompt.

That test proves the bridge can resolve the Slack interaction and Pi can continue after the tool result in the same run.
