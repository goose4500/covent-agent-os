import assert from "node:assert/strict";
import {
  buildRoutes,
  formatHelpText,
  formatStatusText,
  subagentsEnabledFromEnv,
  webAccessEnabledFromEnv,
} from "./lib/routes.mjs";

// Case 1: subagents and web access are default-on.
{
  assert.equal(subagentsEnabledFromEnv({}), true);
  assert.equal(subagentsEnabledFromEnv({ PI_MOM_SUBAGENTS_ENABLED: "false" }), true);
  assert.equal(webAccessEnabledFromEnv({}), true);
  assert.equal(webAccessEnabledFromEnv({ PI_MOM_WEB_ACCESS_ENABLED: "false" }), true);
}

// Case 2: routes are workflow instructions, not tool allowlists.
{
  const routes = buildRoutes({ subagentsEnabled: false, webAccessEnabled: false });
  for (const [key, route] of Object.entries(routes)) {
    assert.ok(route.label, `${key} route has label`);
    assert.equal(route.tools, undefined, `${key} route does not carry a tool gate`);
  }
  assert.match(routes.plain.instruction, /Web access tools are available by default/);
  assert.match(routes.team.instruction, /subagent tool is available by default/);
  assert.match(routes.slack.instruction, /slack-mcp-agent-ux/);
  assert.match(routes.slack.instruction, /Slack MCP/);
  assert.match(routes.bash.instruction, /bash tool/);
}

// Case 3: help/status clearly state default-all posture.
{
  const routes = buildRoutes();
  const help = formatHelpText({ routes });
  assert.match(help, /All Pi tools, app extensions, bash, skills, web access, and subagents are enabled by default/);
  assert.match(help, /team: use subagents/);
  assert.match(help, /slack: design an approval modal/);
  assert.match(help, /bash: pwd/);

  const status = formatStatusText({
    mode: "pi",
    uptimeSeconds: 12,
    authLine: "bot auth: ok",
    testChannelName: "idea-specs",
    allowedChannelId: "C123",
    piModelLabel: "openai-codex/gpt-5.5",
    piThinkingLabel: "high",
    linearConfigured: true,
    linearTeamId: "T",
    linearProjectId: "P",
    linearStateId: "S",
    integrationHealth: {
      slackStreaming: { label: "ok" },
      browserUse: { label: "configured (env)" },
      linear: { label: "configured" },
    },
    traceEnabled: true,
    routes,
  });
  assert.match(status, /pi tools: `all registered tools active by default`/);
  assert.match(status, /app extensions: `default-on`/);
  assert.match(status, /MCP adapter/);
  assert.match(status, /Slack streaming support: `ok`/);
  assert.match(status, /Browser Use key: `configured \(env\)`/);
  assert.match(status, /Linear config: `configured`/);
  assert.match(status, /skills: `repo \+ app\/package skills enabled`/);
  assert.match(status, /routes: `plain, help, status, summarize, linear, agenda, spec, slack, bash, team`/);
}

console.log("route-config tests passed");
