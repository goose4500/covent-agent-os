export const ROUTES = {
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
};

export function stripBotMentions(text = "") {
  return text
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>\s*/g, "")
    .replace(/^@?(?:covent[-\s]?agent|covent\s+pi)\s*/i, "")
    .trim();
}

export function parseCommand(text = "") {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (["help", "help:", "?"].includes(lower)) return { kind: "help" };
  if (["status", "status:"].includes(lower)) return { kind: "status" };

  const match = trimmed.match(/^([a-z][a-z0-9_-]*)\s*:\s*([\s\S]*)$/i);
  if (!match) return { kind: "plain", text: trimmed };

  const routeKey = match[1].toLowerCase();
  if (!ROUTES[routeKey]) return { kind: "plain", text: trimmed };
  return {
    kind: "route",
    routeKey,
    route: ROUTES[routeKey],
    text: match[2].trim() || `(No extra instructions after ${routeKey}:; use the Slack thread context.)`,
  };
}

export function parseThreadSpecIntent(text = "") {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const patterns = [
    /\b(?:draft|write|create|make|generate)\s+(?:a\s+|an\s+)?(?:spec|prd|product\s+requirements?(?:\s+doc(?:ument)?)?|requirements?\s+doc(?:ument)?)\b/i,
    /\b(?:turn|convert)\s+(?:this|thread|it)\s+into\s+(?:a\s+|an\s+)?(?:spec|prd|product\s+requirements?(?:\s+doc(?:ument)?)?|requirements?\s+doc(?:ument)?)\b/i,
    /\b(?:spec|prd)\s+(?:this|thread|it)\b/i,
  ];

  const pattern = patterns.find((candidate) => candidate.test(trimmed));
  if (!pattern) return undefined;

  const focus = trimmed.replace(pattern, "").replace(/^[\s:;,.\-–—]+/, "").trim();
  return {
    kind: "route",
    routeKey: "spec",
    route: ROUTES.spec,
    text: focus || "Turn this Slack thread into a concise PRD/spec draft.",
    naturalIntent: "thread_spec",
    requiresThread: true,
  };
}

export function parseLinearCreateIntent(text = "") {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const pattern = /\b(?:create|file|open|make)\s+(?:a\s+|an\s+)?(?:linear\s+)?(?:issue|ticket)\b|\b(?:linear\s+)?(?:issue|ticket)\s+(?:this|thread|it)\b/i;
  if (!pattern.test(trimmed)) return undefined;

  const focus = trimmed.replace(pattern, "").replace(/^[\s:;,\.\-–—]+/, "").trim();
  return {
    kind: "route",
    routeKey: "linear",
    route: ROUTES.linear,
    text: focus || "Create a Linear issue from this Slack thread.",
    naturalIntent: "linear_issue_create",
    requiresThread: true,
  };
}

export function parseSlackRequestCommand(text = "", { mode } = {}) {
  const command = parseCommand(text);
  if (command.kind !== "plain") return command;
  if (mode === "app_mention") return parseLinearCreateIntent(command.text || text) || parseThreadSpecIntent(command.text || text) || command;
  return command;
}
