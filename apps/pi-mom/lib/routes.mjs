const WEB_ACCESS_INSTRUCTION = `Web access tools are available by default. Use them when public web or code-search context helps answer the user's request. Cite useful public sources and keep Slack output compact.`;

const TEAM_ROUTE_INSTRUCTION = `Run a Team Subagents workflow. The subagent tool is available by default, so use the simplest subagent call that fits the user request and summarize useful artifacts/results back into Slack.`;

export function subagentsEnabledFromEnv(_env = process.env) {
  return true;
}

export function webAccessEnabledFromEnv(_env = process.env) {
  return true;
}

export function buildRoutes(_options = {}) {
  return {
    plain: {
      label: "Default Pi agent",
      instruction: WEB_ACCESS_INSTRUCTION,
    },
    help: { label: "Show help", instruction: "" },
    status: { label: "Show bridge status", instruction: "" },
    summarize: {
      label: "Thread summary",
      instruction: "Summarize the current Slack thread into decisions, open questions, owners, risks/blockers, and next actions. Prefer compact bullets and cite Slack timestamps/permalinks if present in context.",
    },
    linear: {
      label: "Create Linear issue",
      instruction: "Create a Linear issue from the current Slack thread. Search first when useful, then comment-or-create. Pass a concise title and Markdown description with problem, context, proposed solution/spec, acceptance criteria, priority/severity suggestion, source Slack thread reference, and open questions. After the tool returns, post a short Slack reply quoting the issue identifier and URL.",
    },
    agenda: {
      label: "Meeting agenda",
      instruction: "Turn the current Slack context into a meeting agenda. Output: meeting goal, required decisions, agenda items, pre-reads/context, attendee-specific questions if inferable, and desired outcomes.",
    },
    spec: {
      label: "Spec / PRD draft",
      instruction: "Convert the Slack idea/context into a concise spec draft. Output: problem, user/customer, proposed solution, non-goals, success criteria, implementation notes, risks, validation plan, and open questions.",
    },
    bash: {
      label: "Execute bash command",
      instruction: "Execute the user's bash command via the bash tool, then summarize the exit code, stdout, and stderr concisely.",
    },
    team: {
      label: "Team subagents",
      instruction: TEAM_ROUTE_INSTRUCTION,
    },
  };
}

export function formatHelpText({ routes = buildRoutes() } = {}) {
  const routeLines = Object.entries(routes)
    .map(([key, route]) => `• \`${key}:\` ${route.label}`)
    .join("\n");

  return `*Covent Pi commands*\n\n` +
    `All Pi tools, app extensions, bash, skills, web access, and subagents are enabled by default for Pi-backed routes. Prefixes shape the workflow; they do not restrict tools.\n\n` +
    `• \`help:\` show this menu\n` +
    `• \`status:\` show local bridge health/config\n` +
    `${routeLines}\n\n` +
    `Examples:\n` +
    `• in a thread: \`@Covent Pi draft spec\`\n` +
    `• in a thread: \`@Covent Pi create Linear issue\`\n` +
    `• \`@Covent Pi summarize: decisions, open questions, next actions\`\n` +
    `• \`@Covent Pi linear: create an issue from this thread\`\n` +
    `• \`@Covent Pi spec: turn this idea into a PRD draft\`\n` +
    `• \`@Covent Pi team: use subagents to inspect and plan this change\`\n` +
    `• \`@Covent Pi bash: pwd && git status --short\`\n`;
}

export function formatStatusText({
  mode,
  uptimeSeconds,
  authLine = "bot auth: not checked",
  testChannelName,
  allowedChannelId,
  piModelLabel,
  piThinkingLabel,
  linearConfigured = false,
  linearTeamId,
  linearProjectId,
  linearStateId,
  traceEnabled = false,
  routes = buildRoutes(),
} = {}) {
  return `*Covent Pi status*\n` +
    `• mode: \`${mode || "?"}\`\n` +
    `• streaming: \`on\` (slack-sink + heartbeat)\n` +
    `• uptime: \`${Number.isFinite(uptimeSeconds) ? uptimeSeconds : "?"}s\`\n` +
    `• ${authLine}\n` +
    `• test channel target: \`#${testChannelName || "?"}\`\n` +
    `• allowed channel: \`${allowedChannelId || "any"}\`\n` +
    `• pi model: \`${piModelLabel || "?"}\` (thinking: \`${piThinkingLabel || "?"}\`)\n` +
    `• pi tools: \`all registered tools active by default\`\n` +
    `• app extensions: \`default-on\` (Linear, Slack UI, subagents, browser-use, pi-web-access, git checkpoint)\n` +
    `• skills: \`repo + app/package skills enabled\`\n` +
    `• Linear issue creation: \`${linearConfigured ? "configured" : "LINEAR_API_KEY missing"}\`\n` +
    `• Linear target: team \`${linearTeamId || "?"}\`, project \`${linearProjectId || "?"}\`, state \`${linearStateId || "?"}\`\n` +
    `• trace: \`${traceEnabled ? "on" : "off"}\`\n` +
    `• routes: \`${Object.keys(routes).join(", ")}\``;
}
