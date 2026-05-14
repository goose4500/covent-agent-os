import assert from "node:assert/strict";
import {
  TEAM_SUBAGENT_TOOLS,
  WEB_ACCESS_TOOLS,
  buildRoutes,
  formatHelpText,
  formatStatusText,
  subagentsEnabledFromEnv,
  webAccessEnabledFromEnv,
} from "./lib/routes.mjs";

// Case 1: PI_MOM_SUBAGENTS_ENABLED and PI_MOM_WEB_ACCESS_ENABLED are opt-in and false by default.
{
  assert.equal(subagentsEnabledFromEnv({}), false);
  assert.equal(subagentsEnabledFromEnv({ PI_MOM_SUBAGENTS_ENABLED: "" }), false);
  assert.equal(subagentsEnabledFromEnv({ PI_MOM_SUBAGENTS_ENABLED: "false" }), false);
  assert.equal(subagentsEnabledFromEnv({ PI_MOM_SUBAGENTS_ENABLED: "true" }), true);
  assert.equal(subagentsEnabledFromEnv({ PI_MOM_SUBAGENTS_ENABLED: "TRUE" }), true);

  assert.equal(webAccessEnabledFromEnv({}), false);
  assert.equal(webAccessEnabledFromEnv({ PI_MOM_WEB_ACCESS_ENABLED: "" }), false);
  assert.equal(webAccessEnabledFromEnv({ PI_MOM_WEB_ACCESS_ENABLED: "false" }), false);
  assert.equal(webAccessEnabledFromEnv({ PI_MOM_WEB_ACCESS_ENABLED: "true" }), true);
  assert.equal(webAccessEnabledFromEnv({ PI_MOM_WEB_ACCESS_ENABLED: "TRUE" }), true);
}

// Case 2: disabled team: route is still recognized but has no tools, so a
// `team:` request cannot fall through to the write-capable plain route.
{
  const routes = buildRoutes({ subagentsEnabled: false });
  assert.ok(routes.team, "team route should exist when disabled to avoid plain-route fallback");
  assert.equal(routes.team.label, "Team subagents (disabled)");
  assert.deepEqual(routes.team.tools, [], "disabled team route must not expose subagent");
  assert.match(routes.team.instruction, /PI_MOM_SUBAGENTS_ENABLED=true/);
}

// Case 3: enabled team: route exposes exactly the subagent + Slack HITL tools.
{
  const routes = buildRoutes({ subagentsEnabled: true });
  assert.deepEqual(routes.team.tools, TEAM_SUBAGENT_TOOLS);
  assert.deepEqual(routes.team.tools, [
    "subagent",
    "slack_approval_card",
    "slack_choice_card",
    "slack_input_request",
  ]);
  assert.equal(routes.team.tools.filter((tool) => tool === "subagent").length, 1);
}

// Case 4: plain stays broad for existing behavior, never gains subagent, and gets web tools only behind PI_MOM_WEB_ACCESS_ENABLED.
{
  for (const subagentsEnabled of [false, true]) {
    const routes = buildRoutes({ subagentsEnabled, webAccessEnabled: false });
    assert.ok(routes.plain.tools.includes("bash"), "plain route keeps existing tools");
    assert.ok(routes.plain.tools.includes("write"), "plain route keeps existing tools");
    assert.ok(!routes.plain.tools.includes("subagent"), "plain route must not expose subagent");
    for (const tool of WEB_ACCESS_TOOLS) {
      assert.ok(!routes.plain.tools.includes(tool), `plain route must not expose ${tool} by default`);
    }
  }

  const webRoutes = buildRoutes({ subagentsEnabled: true, webAccessEnabled: true });
  for (const tool of WEB_ACCESS_TOOLS) {
    assert.ok(webRoutes.plain.tools.includes(tool), `plain route exposes ${tool} when web access is enabled`);
    assert.ok(!webRoutes.team.tools.includes(tool), `team parent route must not directly expose ${tool}`);
  }
  assert.ok(!webRoutes.plain.tools.includes("subagent"), "web-enabled plain route still must not expose subagent");
  assert.match(webRoutes.plain.instruction, /workflow: "none"/);
  assert.match(webRoutes.plain.instruction, /Do not search or fetch secrets/);
  assert.match(webRoutes.plain.instruction, /Direct URL fetch is not exposed/);
}

// Case 5: team instruction constrains Slack subagents to foreground/read-only presets.
{
  const instruction = buildRoutes({ subagentsEnabled: true }).team.instruction;
  assert.match(instruction, /foreground/i);
  assert.match(instruction, /read-only/i);
  assert.match(instruction, /async false/i);
  assert.match(instruction, /clarify false/i);
  assert.match(instruction, /agentScope `project`/i);
  assert.match(instruction, /team-scout/);
  assert.match(instruction, /team-planner/);
  assert.match(instruction, /team-reviewer-readonly/);
  assert.match(instruction, /Never use write-capable agents/);
  assert.match(instruction, /Never use subagent management mutations/);
  assert.doesNotMatch(instruction, /team-worker/);
}

// Case 6: help and status clearly surface enabled/disabled subagent state.
{
  const disabledRoutes = buildRoutes({ subagentsEnabled: false });
  const disabledHelp = formatHelpText({ routes: disabledRoutes, subagentsEnabled: false });
  assert.match(disabledHelp, /`team:` Team subagents \(disabled\)/);
  assert.match(disabledHelp, /disabled until PI_MOM_SUBAGENTS_ENABLED=true/);

  const enabledRoutes = buildRoutes({ subagentsEnabled: true });
  const enabledHelp = formatHelpText({ routes: enabledRoutes, subagentsEnabled: true });
  assert.match(enabledHelp, /`team:` Team subagents/);
  assert.match(enabledHelp, /team: context/);

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
    traceEnabled: true,
    routes: enabledRoutes,
    subagentsEnabled: true,
    webAccessEnabled: true,
  });
  assert.match(status, /team subagents: `enabled`/);
  assert.match(status, /web access: `enabled`/);
  assert.match(status, /routes: `plain, help, status, summarize, linear, agenda, spec, bash, team`/);
}

console.log("route-config tests passed");
