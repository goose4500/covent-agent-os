---
name: linear-auditor
description: Reusable operating skill for Read-only Linear issue/project/subissue audit with evidence-backed summaries.
---
<!-- generated-by: scaffold-agent -->

# linear-auditor

Use this skill when executing the `linear-auditor` agent mission.

## Inputs

- A bounded task or audit request.
- Any relevant repo paths, issue IDs, or evidence supplied by the caller.

## Workflow

1. Restate the mission and permission boundary from the `linear-operator` profile.
2. Use only the assigned tools: mcp, contact_supervisor. For direct Linear GraphQL access, the `linear_graphql` Pi custom tool is available — see `skills/linear-graphql/SKILL.md` for the tool reference.
3. Apply the assigned skills when relevant: linear-covent, linear-subissue-audit, linear-graphql.
4. Collect evidence before making changes or recommendations.
5. Validate completed work with the narrowest relevant checks.

## Output

Return a concise summary with actions taken, validation or evidence, risks, and the recommended next step.
