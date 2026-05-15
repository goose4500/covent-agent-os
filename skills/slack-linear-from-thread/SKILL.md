---
name: slack-linear-from-thread
description: >-
  Create or update a Linear issue based on the current Slack thread.
  Use when the user asks "file a Linear issue", "create a ticket",
  "log this in Linear", "make a Linear", "track this", "open a ticket",
  or similar in a Slack conversation. Performs search-before-create
  so re-runs don't duplicate.
---

# Slack → Linear issue

Create a Linear issue (or comment on an existing one) from the current
Slack thread. Tools used: `linear_search_issues`,
`linear_create_issue`, `linear_add_comment`.

## Process

1. **Search first.** Call `linear_search_issues` with the topic / key
   nouns from the thread before creating anything. Re-runs from the
   same Slack thread should not produce duplicates.
2. **If a clear match exists** (same topic, open or recent), comment
   on it with the new context from the thread via
   `linear_add_comment`. Quote the Slack permalink if present.
3. **If no match exists**, draft and create a new issue via
   `linear_create_issue` with:
   - **Title** — concise, action-oriented (`<verb> <noun>`). Max 240 chars.
   - **Description (markdown)** — these sections, in order:
     - Problem (what's broken / requested)
     - Context (who reported it, when, from where — link the Slack thread)
     - Proposed solution / spec
     - Acceptance criteria
     - Priority / severity suggestion (with brief reasoning)
     - Open questions
   - **Priority** — only set if the thread provides clear signal
     (user impact, deadline, blocker mention). Otherwise leave default.
4. **If multiple candidate matches** are returned by search and the
   right one is ambiguous, use `slack_choice_card` to ask the user
   to pick one rather than guessing.

## Post-action reply

After the tool returns, post a short Slack reply quoting the issue
identifier and URL:

> ✅ Filed as `ENG-1234` → https://linear.app/.../ENG-1234

Or for a comment:

> 💬 Commented on `ENG-1234` → https://linear.app/.../ENG-1234

Keep the reply to one or two lines so it doesn't clutter the thread.

## Operating guidelines

- **Idempotent by default.** Same thread → same issue. Lean toward
  comment rather than new issue when uncertain.
- **Don't ask for confirmation before searching.** Search is free.
- **Do call `slack_approval_card`** before creating a new issue if the
  user hasn't explicitly asked for one ("file this" is explicit
  approval; "what should we do here" is not).
- **Strip secrets** from anything pulled out of the Slack thread before
  putting it in the Linear description.
