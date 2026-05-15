---
name: slack-spec-draft
description: >-
  Quick spec / PRD draft from a Slack thread or idea. Use when the user
  in Slack asks for "a spec", "draft this", "turn this into a PRD",
  "write a spec", "spec this out", "PRD this", or similar. Produces a
  scannable structured doc — not a full deep-research PRD; for that, use
  the `to-prd` skill instead.
---

# Slack spec draft

Turn the current Slack thread / idea into a concise spec draft. Output is a
markdown document with the following sections, in order:

1. **Problem** — one paragraph. What's broken or missing today, for whom.
2. **User / customer** — who feels this. If multiple, list them.
3. **Proposed solution** — one paragraph plus optional bullets. The
   shape of the fix, not the implementation.
4. **Non-goals** — explicit list of what's out of scope for this round.
5. **Success criteria** — measurable signals that the solution worked
   (latency, conversion, NPS, qualitative, etc.).
6. **Implementation notes** — high-level approach, dependencies,
   integration points. Skip if the team should design it freely.
7. **Risks** — what could go wrong. Include both technical and product
   risks.
8. **Validation plan** — how we'll know early whether to keep going.
9. **Open questions** — anything you couldn't answer from the thread.

## Operating guidelines

- **Pull from thread context first.** Use the conversation already in
  Slack — don't re-interview the user.
- **Stay concise.** Each section is short. The whole doc should fit in
  a Slack canvas without scrolling forever.
- **Surface ambiguity in Open questions** instead of inventing answers.
- **Use a Slack canvas for the output.** Before writing, call
  `slack_canvas_start({ title: "Spec — <short topic>" })` so the
  document streams into a canvas the user can share. End with
  `slack_canvas_finish` after the last section.
- After finishing the canvas, post a one-line summary to the chat
  thread (e.g. "Drafted spec → <canvas url>") so users who only watch
  the thread see the artifact.

## When NOT to use this

- The user wants a full PRD with codebase exploration → use `to-prd`.
- The user just wants a recap, not a spec → use `slack-thread-summary`.
- The user wants implementation issues → use `to-issues` after this.
