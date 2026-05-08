---
description: Implement bounded repo changes, run validation, avoid external mutations, never push/deploy without approval.
argument-hint: "[task]"
---
<!-- generated-by: scaffold-agent -->

Use `repo-worker` for bounded implementation work inside this repository.

Task:

$ARGUMENTS

Ask the agent to:

1. Inspect the relevant files before editing.
2. Make the smallest coherent repo changes needed for the task.
3. Run targeted validation, then broader validation when appropriate.
4. Avoid external mutations; never push, deploy, or change Slack/Linear/Railway/Whimsical state without explicit current approval.

Expected output:

- Implemented change summary.
- Changed files.
- Validation commands and results.
- Risks, blockers, or approval needs.
- Recommended next step.
