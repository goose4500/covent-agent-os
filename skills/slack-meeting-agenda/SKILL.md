---
name: slack-meeting-agenda
description: >-
  Turn the current Slack thread / context into a meeting agenda. Use
  when the user asks for "an agenda", "meeting agenda", "what should
  we talk about in the meeting", "prep for the standup/sync/review",
  "agenda for tomorrow", or similar.
---

# Slack meeting agenda

Turn the current Slack context into a meeting agenda the organizer can
paste into a calendar invite.

## Output sections

1. **Meeting goal** — one sentence. What does the meeting need to
   produce (a decision, alignment, a list of next steps, etc.)?
2. **Required decisions** — bullets. What MUST be decided in this
   meeting for the goal to be met. Order by importance.
3. **Agenda items** — timed bullets if a duration is given (`5m`,
   `10m`, …); otherwise just bullets. Cover the required decisions
   first; non-decision discussion last.
4. **Pre-reads / context** — links, docs, threads attendees should
   skim before the meeting. Pull from the thread context when present.
5. **Attendee-specific questions** — only if attendee names are
   inferable from the thread. Otherwise omit.
6. **Desired outcomes** — what good looks like at the end of the
   meeting (decisions made, action items assigned, owners chosen).

## Operating guidelines

- **One agenda, not three.** Pick a single coherent shape; don't list
  alternatives.
- **Concrete > generic.** "Decide on the launch date for the spec
  intake form" beats "Discuss spec intake form."
- **Use a Slack canvas** if the agenda is long enough to warrant one
  (≥ 6 agenda items or pre-reads present): call `slack_canvas_start({
  title: "Agenda — <meeting topic>" })` first and `slack_canvas_finish`
  after the final section. For short agendas, post inline in the chat
  thread.

## When NOT to use this

- The user wants a summary of past decisions → use `slack-thread-summary`.
- The user wants a doc, not a meeting → use `slack-spec-draft`.
