export const ROUTES = Object.freeze({
  summarize: {
    label: "Thread summary",
    instruction: "Summarize the current Slack thread into decisions, open questions, owners, risks/blockers, and next actions. Prefer compact bullets and cite Slack timestamps/permalinks if present in context.",
  },
  linear: {
    label: "Create Linear issue",
    instruction: "Create a Linear-ready issue spec from the current Slack thread. The first line must be exactly `Title: <concise issue title>`. Then write the issue description in Markdown with problem, context, proposed solution/spec, acceptance criteria, priority/severity suggestion, source Slack thread timestamp if inferable, and open questions. The bridge will create the Linear issue after you output this spec.",
  },
  agenda: {
    label: "Meeting agenda",
    instruction: "Turn the current Slack context into a meeting agenda. Output: meeting goal, required decisions, agenda items, pre-reads/context, attendee-specific questions if inferable, and desired outcomes.",
  },
  escalation: {
    label: "Escalation brief",
    instruction: "Create an escalation brief from the current Slack thread. Output: severity, customer/business impact, known facts, unknowns, blockers, recommended owner, immediate next action, and a concise suggested internal reply.",
  },
  spec: {
    label: "Spec / PRD draft",
    instruction: "Convert the Slack idea/context into a concise spec draft. Output: problem, user/customer, proposed solution, non-goals, success criteria, implementation notes, risks, validation plan, and open questions.",
  },
  digest: {
    label: "Digest",
    instruction: "Create a compact digest from the available Slack context. Output: important updates, decisions, asks, blockers, follow-ups, and anything that needs an owner. If broader channel/date context is needed, say exactly what scope is missing.",
  },
  image: {
    label: "GPT Image generation/edit",
    instruction: "Generate or edit an image with OpenAI GPT Image. In Slack, the bridge handles this route directly and uploads image files back to the thread.",
  },
  agent: {
    label: "Agent Run Card",
    instruction: "Show a Slack confirmation card before running a bounded fake or repo-health agent task.",
  },
});
