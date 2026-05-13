const SLACK_INTERACTIVE_TOOLS = [
  "slack_approval_card",
  "slack_choice_card",
  "slack_input_request",
];

export const TEAM_SUBAGENT_TOOLS = ["subagent", ...SLACK_INTERACTIVE_TOOLS];

const TEAM_ROUTE_ENABLED_INSTRUCTION = `Run a Slack-owned Team Subagents preset. This route is foreground and read-only only.

Allowed presets from the user text after \`team:\`:
- \`doctor\`: call the subagent tool with { "action": "doctor" }.
- \`context <scope>\`: call the subagent tool once with agent \`team-scout\`, agentScope \`project\`, context \`fresh\`, async false, and a concise task to inspect that scope.
- \`plan <task>\`: call the subagent tool once in chain mode with project agents \`team-scout\` then \`team-planner\`, agentScope \`project\`, context \`fresh\`, async false.
- \`review <target>\`: call the subagent tool once with agent \`team-reviewer-readonly\`, agentScope \`project\`, context \`fresh\`, async false.

Hard rules:
- Call \`subagent\` at most once per Slack request.
- Always foreground: set async false or omit async; never start background jobs.
- Never use write-capable agents such as \`worker\` or \`delegate\` from Slack.
- Never use subagent management mutations (create/update/delete), interrupt/resume, worktree, push, deploy, or external mutation flows from this route.
- Prefer project-scoped agents and summarize the result back to Slack with artifacts/next steps, not raw transcript dumps.
- If the request needs mutation, stop and ask for explicit next-step approval instead of mutating.`;

const TEAM_ROUTE_DISABLED_INSTRUCTION =
  "Team subagents are disabled in this environment. Do not call tools. Tell the user that PI_MOM_SUBAGENTS_ENABLED=true is required to enable the team: route.";

export function subagentsEnabledFromEnv(env = process.env) {
  return String(env.PI_MOM_SUBAGENTS_ENABLED || "").toLowerCase() === "true";
}

export function buildRoutes({ subagentsEnabled = subagentsEnabledFromEnv() } = {}) {
  return {
    plain: {
      label: "Default Pi agent",
      instruction: "",
      tools: [
        "bash", "read", "grep", "find", "edit", "write",
        ...SLACK_INTERACTIVE_TOOLS,
      ],
    },
    help: { label: "Show help", instruction: "", tools: [] },
    status: { label: "Show bridge status", instruction: "", tools: [] },
    summarize: {
      label: "Thread summary",
      instruction: "Summarize the current Slack thread into decisions, open questions, owners, risks/blockers, and next actions. Prefer compact bullets and cite Slack timestamps/permalinks if present in context.",
      tools: [],
    },
    linear: {
      label: "Create Linear issue",
      instruction: "Create a Linear issue from the current Slack thread by calling the linear_create_issue tool exactly once. Pass a single-line title (≤240 chars), a Markdown description (problem, context, proposed solution/spec, acceptance criteria, priority/severity suggestion, source Slack thread reference, open questions), and an optional priority (0–4). After the tool returns, post a short Slack reply quoting the new issue identifier and URL.",
      tools: [
        "linear_search_issues", "linear_create_issue", "linear_add_comment",
        ...SLACK_INTERACTIVE_TOOLS,
      ],
    },
    agenda: {
      label: "Meeting agenda",
      instruction: "Turn the current Slack context into a meeting agenda. Output: meeting goal, required decisions, agenda items, pre-reads/context, attendee-specific questions if inferable, and desired outcomes.",
      tools: [],
    },
    spec: {
      label: "Spec / PRD draft",
      instruction: "Convert the Slack idea/context into a concise spec draft. Output: problem, user/customer, proposed solution, non-goals, success criteria, implementation notes, risks, validation plan, and open questions.",
      tools: [],
    },
    bash: {
      label: "Execute bash command",
      instruction: "Execute the user's bash command verbatim via the bash tool exactly once. After it returns, summarize the exit code, stdout, and stderr in a single concise paragraph.",
      tools: ["bash", ...SLACK_INTERACTIVE_TOOLS],
    },
    team: {
      label: subagentsEnabled ? "Team subagents" : "Team subagents (disabled)",
      instruction: subagentsEnabled ? TEAM_ROUTE_ENABLED_INSTRUCTION : TEAM_ROUTE_DISABLED_INSTRUCTION,
      tools: subagentsEnabled ? [...TEAM_SUBAGENT_TOOLS] : [],
    },
  };
}

export function formatHelpText({ routes = buildRoutes(), subagentsEnabled = subagentsEnabledFromEnv() } = {}) {
  const routeLines = Object.entries(routes)
    .map(([key, route]) => `• \`${key}:\` ${route.label}`)
    .join("\n");

  const teamExample = subagentsEnabled
    ? `• \`@Covent Pi team: context apps/pi-mom Slack route handling\`\n`
    : `• \`@Covent Pi team: doctor\` _(disabled until PI_MOM_SUBAGENTS_ENABLED=true)_\n`;

  return `*Covent Pi commands*\n\n` +
    `• \`help:\` show this menu\n` +
    `• \`status:\` show local bridge health/config\n` +
    `${routeLines}\n\n` +
    `Examples:\n` +
    `• in a thread: \`@Covent Pi draft spec\`\n` +
    `• in a thread: \`@Covent Pi create Linear issue\`\n` +
    `• \`@Covent Pi summarize: decisions, open questions, next actions\`\n` +
    `• \`@Covent Pi linear: create an issue from this thread\`\n` +
    `• \`@Covent Pi spec: turn this thread into a PRD draft\`\n` +
    teamExample;
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
  subagentsEnabled = subagentsEnabledFromEnv(),
} = {}) {
  return `*Covent Pi status*\n` +
    `• mode: \`${mode || "?"}\`\n` +
    `• streaming: \`on\` (slack-sink + heartbeat)\n` +
    `• uptime: \`${Number.isFinite(uptimeSeconds) ? uptimeSeconds : "?"}s\`\n` +
    `• ${authLine}\n` +
    `• test channel target: \`#${testChannelName || "?"}\`\n` +
    `• allowed channel: \`${allowedChannelId || "any"}\`\n` +
    `• pi model: \`${piModelLabel || "?"}\` (thinking: \`${piThinkingLabel || "?"}\`)\n` +
    `• pi tools: per-route from lib/routes.mjs\n` +
    `• team subagents: \`${subagentsEnabled ? "enabled" : "disabled"}\` (PI_MOM_SUBAGENTS_ENABLED)\n` +
    `• Linear issue creation: \`${linearConfigured ? "configured" : "LINEAR_API_KEY missing"}\`\n` +
    `• Linear target: team \`${linearTeamId || "?"}\`, project \`${linearProjectId || "?"}\`, state \`${linearStateId || "?"}\`\n` +
    `• trace: \`${traceEnabled ? "on" : "off"}\`\n` +
    `• routes: \`${Object.keys(routes).join(", ")}\``;
}
