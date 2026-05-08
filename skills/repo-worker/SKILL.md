---
name: repo-worker
description: Reusable operating skill for Implement bounded repo changes, run validation, avoid external mutations, never push/deploy without approval.
---
<!-- generated-by: scaffold-agent -->

# repo-worker

Use this skill when executing the `repo-worker` agent mission.

## Inputs

- A bounded task or audit request.
- Any relevant repo paths, issue IDs, or evidence supplied by the caller.

## Workflow

1. Restate the mission and permission boundary from the `repo-writer` profile.
2. Use only the assigned tools: read, grep, find, ls, bash, edit, write.
3. Apply the assigned skills when relevant: git-workflow, diagnose, context7-docs, tdd.
4. Collect evidence before making changes or recommendations.
5. Validate completed work with the narrowest relevant checks.

## Output

Return a concise summary with actions taken, validation or evidence, risks, and the recommended next step.
