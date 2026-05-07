---
name: cognitive-toolbelt
description: Use this skill whenever the user wants deeper reasoning, problem solving, critique, planning, debugging, strategy, architecture review, issue decomposition, or asks to combine cognitive modes instead of invoking many individual skills. This is a routing layer for Jake's cognitive/reasoning skills.
---

# Cognitive Toolbelt

Use this as a reasoning router. Pick the smallest useful combo; do not blindly use every mode.

## Core modes

- `sequential-thinking`: decompose complex problems step by step; revise assumptions as new info appears.
- `critical-thinking-logical-reasoning`: critique arguments, claims, articles, plans, and reasoning quality.
- `systems-thinking`: model feedback loops, second-order effects, incentives, stakeholders, and constraints.
- `diagnose`: debug bugs/performance failures with reproduce → minimize → hypothesize → instrument → fix → test.
- `grill-me`: interrogate a plan/design aggressively until weak points and hidden assumptions surface.
- `grill-with-docs`: grill a plan against repo docs, ADRs, domain language, and existing decisions.
- `improve-codebase-architecture`: find refactors, coupling problems, missing boundaries, and testability improvements.
- `tdd`: implement or fix via red → green → refactor with tests first.
- `elon-es`: compress messy context into blunt first-principles founder/operator bullets.
- `solution-finder`: search prior notes/code before reinventing an approach.
- `librarian`: research open-source/library internals with citations to real source code.
- `to-prd`: convert conversation/context into a product requirements document.
- `to-issues`: split a plan/PRD into independently implementable issues.
- `triage`: classify, clarify, and prepare bugs/features/issues for execution.
- `yesterdays-pi-context-prime`: recover context from recent Pi logs/sessions.

## Default combo

For ambiguous hard problems:
1. Use `sequential-thinking` to frame the problem.
2. Use `systems-thinking` for broader effects.
3. Use `critical-thinking-logical-reasoning` to challenge assumptions.
4. Use the domain-specific mode only if needed: `diagnose`, `tdd`, `improve-codebase-architecture`, `to-prd`, `to-issues`, etc.

Return concise synthesis, not process theater.
