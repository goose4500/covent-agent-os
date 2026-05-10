export const ROUTES = Object.freeze({
  summarize: Object.freeze({
    label: "Thread summary",
    instruction: "Summarize the current Slack thread into decisions, open questions, owners, risks/blockers, and next actions. Prefer compact bullets and cite Slack timestamps/permalinks if present in context.",
  }),
  linear: Object.freeze({
    label: "Create Linear issue",
    instruction: "Create a Linear-ready issue spec from the current Slack thread. The first line must be exactly `Title: <concise issue title>`. Then write the issue description in Markdown with problem, context, proposed solution/spec, acceptance criteria, priority/severity suggestion, source Slack thread timestamp if inferable, and open questions. The bridge will create the Linear issue after you output this spec.",
  }),
  agenda: Object.freeze({
    label: "Meeting agenda",
    instruction: "Turn the current Slack context into a meeting agenda. Output: meeting goal, required decisions, agenda items, pre-reads/context, attendee-specific questions if inferable, and desired outcomes.",
  }),
  escalation: Object.freeze({
    label: "Escalation brief",
    instruction: "Create an escalation brief from the current Slack thread. Output: severity, customer/business impact, known facts, unknowns, blockers, recommended owner, immediate next action, and a concise suggested internal reply.",
  }),
  spec: Object.freeze({
    label: "Spec / PRD draft",
    instruction: "Convert the Slack idea/context into a concise spec draft. Output: problem, user/customer, proposed solution, non-goals, success criteria, implementation notes, risks, validation plan, and open questions.",
  }),
  digest: Object.freeze({
    label: "Digest",
    instruction: "Create a compact digest from the available Slack context. Output: important updates, decisions, asks, blockers, follow-ups, and anything that needs an owner. If broader channel/date context is needed, say exactly what scope is missing.",
  }),
  image: Object.freeze({
    label: "GPT Image generation/edit",
    instruction: "Generate or edit an image with OpenAI GPT Image. In Slack, the bridge handles this route directly and uploads image files back to the thread.",
  }),
  agent: Object.freeze({
    label: "Agent Run Card",
    instruction: "Show a Slack confirmation card before running a bounded fake or repo-health agent task.",
  }),
});

export function stripBotMentions(text = "") {
  return String(text || "")
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>\s*/g, "")
    .replace(/^@?(?:covent[-\s]?agent|covent\s+pi)\s*/i, "")
    .trim();
}

export function parseCommand(text = "") {
  const trimmed = String(text || "").trim();
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
  const trimmed = String(text || "").trim();
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
  const trimmed = String(text || "").trim();
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

export function normalizeSlackTs(value = "") {
  const raw = String(value || "").trim().replace(/^p/i, "");
  if (/^\d{10}\.\d{6}$/.test(raw)) return raw;
  if (/^\d{16}$/.test(raw)) return `${raw.slice(0, 10)}.${raw.slice(10)}`;
  return "";
}

export function parseSlackThreadReference(text = "") {
  const rawText = String(text || "");
  const match = rawText.match(/<?(https?:\/\/[^\s>|]+\/archives\/([A-Z0-9]+)\/p(\d{16})(?:\?[^\s>|]+)?)>?/i);
  if (!match) return undefined;

  const urlText = match[1];
  let url;
  try {
    url = new URL(urlText);
  } catch {
    return undefined;
  }

  const messageTs = normalizeSlackTs(match[3]);
  const threadTs = normalizeSlackTs(url.searchParams.get("thread_ts") || "") || messageTs;
  if (!messageTs || !threadTs) return undefined;

  return {
    url: urlText,
    channel: match[2],
    messageTs,
    threadTs,
    remainingText: rawText.replace(match[0], "").trim(),
  };
}

export function redactSensitiveText(text = "") {
  return String(text || "")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "xox[REDACTED]")
    .replace(/xapp-[A-Za-z0-9-]+/g, "xapp-[REDACTED]")
    .replace(/xoxe[.-][A-Za-z0-9.-]+/g, "xoxe[REDACTED]")
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, "AWS_KEY[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh_[REDACTED]")
    .replace(/Authorization:\s*Bearer\s+[^\s'"`]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/Authorization:\s+lin_api_[^\s'"`]+/gi, "Authorization: lin_api_[REDACTED]")
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]")
    .replace(/slackauthticket\s+[A-Za-z0-9._-]+/gi, "slackauthticket [REDACTED]")
    .replace(/((?:SLACK|OPENAI|LINEAR)_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)[A-Z0-9_]*\s*=\s*)(['"]?)[^\s'"]+/gi, "$1$2[REDACTED]");
}

export function cleanTerminalSequences(text = "") {
  return String(text || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function cleanPiOutput(text = "") {
  return redactSensitiveText(cleanTerminalSequences(text));
}

export function clampLinearTitle(title = "") {
  const singleLine = String(title || "").replace(/\s+/g, " ").trim();
  if (!singleLine) return "Slack thread spec";
  return singleLine.length <= 240 ? singleLine : `${singleLine.slice(0, 237)}...`;
}

export function stripWrappingMarkdownFence(text = "") {
  return String(text || "")
    .trim()
    .replace(/^```(?:markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function extractLinearIssuePayload(piOutput = "") {
  const cleaned = stripWrappingMarkdownFence(cleanPiOutput(piOutput));
  const lines = cleaned.split(/\r?\n/);
  const titleLineIndex = lines.findIndex((line, index) => index < 12 && /^\s*(?:#{1,3}\s*)?(?:title|issue title)\s*:\s+/i.test(line));

  if (titleLineIndex >= 0) {
    const title = lines[titleLineIndex].replace(/^\s*(?:#{1,3}\s*)?(?:title|issue title)\s*:\s+/i, "").trim();
    const description = stripWrappingMarkdownFence(lines.filter((_, index) => index !== titleLineIndex).join("\n")) || cleaned;
    return { title: clampLinearTitle(title), description };
  }

  const headingLineIndex = lines.findIndex((line, index) => index < 12 && /^\s*#{1,3}\s+\S+/.test(line));
  if (headingLineIndex >= 0) {
    const title = lines[headingLineIndex].replace(/^\s*#{1,3}\s+/, "").trim();
    return { title: clampLinearTitle(title), description: cleaned };
  }

  const firstUsefulLine = lines.find((line) => line.trim()) || "Slack thread spec";
  return { title: clampLinearTitle(firstUsefulLine.replace(/^\*+|\*+$/g, "")), description: cleaned };
}
