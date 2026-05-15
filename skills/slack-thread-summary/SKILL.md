---
name: slack-thread-summary
description: >-
  Summarize the current Slack thread into decisions, open questions,
  owners, risks/blockers, and next actions. Use when the user asks for
  "summarize this thread", "TL;DR", "what did we decide", "recap",
  "summary", "catch me up", or similar in a Slack conversation.
---

# Slack thread summary

Compress the current Slack thread into a structured recap so latecomers
or stakeholders can catch up in 60 seconds.

## Output sections

Use this fixed structure, in order. Omit a section only if there is
genuinely nothing to put in it (and say so).

1. **Decisions** — what was agreed. Quote the message timestamp or
   permalink if present in the thread context.
2. **Open questions** — unresolved items, with who they're blocked on
   if known.
3. **Owners** — who owns what next. If implicit, infer carefully and
   mark `(inferred)`.
4. **Risks / blockers** — anything called out as risky, blocked, or
   awaiting external input.
5. **Next actions** — concrete next steps with owner + (if mentioned)
   a rough timeline.

## Operating guidelines

- **Compact bullets.** Each item one line if possible.
- **Cite timestamps / permalinks** if they appear in the provided
  thread context. Don't fabricate them.
- **Be honest about gaps.** If the thread is mostly people venting
  without decisions, say "No decisions in this thread; the
  conversation is still in problem-framing." Don't manufacture
  decisions to fill the section.
- **Output goes in the chat thread**, not a canvas. The summary
  should be quick to skim — canvas overhead is wasted here unless the
  user explicitly asks for a long doc.

## When NOT to use this

- The user wants a spec → use `slack-spec-draft`.
- The user wants meeting prep → use `slack-meeting-agenda`.
- The user wants tickets → use `to-issues`.
