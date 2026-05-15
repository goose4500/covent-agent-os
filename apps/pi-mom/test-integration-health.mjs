import assert from "node:assert/strict";
import {
  buildIntegrationHealth,
  formatIntegrationHealthLogLines,
} from "./lib/integration-health.mjs";

// All core integrations configured; logs must only expose presence/status.
{
  const health = buildIntegrationHealth({
    env: {
      BROWSER_USE_API_KEY: "bu_live_secret_value",
      LINEAR_API_KEY: "lin_api_secret_value",
    },
    slackClient: { chatStream() {} },
    fileExists: () => false,
    linearTeamId: "team-id",
    linearProjectId: "project-id",
    linearStateId: "state-id",
  });
  assert.equal(health.slackStreaming.ok, true);
  assert.equal(health.browserUse.ok, true);
  assert.equal(health.browserUse.source, "env");
  assert.equal(health.linear.ok, true);

  const lines = formatIntegrationHealthLogLines(health).join("\n");
  assert.match(lines, /Slack streaming support: ok/);
  assert.match(lines, /Browser Use key: configured \(env\)/);
  assert.match(lines, /Linear config: configured/);
  assert.doesNotMatch(lines, /bu_live_secret_value/);
  assert.doesNotMatch(lines, /lin_api_secret_value/);
}

// Missing env Browser Use key can still be present via the local secret file;
// missing chatStream and Linear key are explicit health warnings.
{
  const health = buildIntegrationHealth({
    env: {},
    slackClient: {},
    fileExists: (path) => path.endsWith("browser-use.env"),
    readFileSyncFn: () => "BROWSER_USE_API_KEY=bu_secret_from_file\n",
    browserUseSecretFile: "/tmp/browser-use.env",
    linearTeamId: "team-id",
    linearProjectId: "project-id",
    linearStateId: "state-id",
  });
  assert.equal(health.slackStreaming.ok, false);
  assert.equal(health.slackStreaming.label, "missing client.chatStream");
  assert.equal(health.browserUse.ok, true);
  assert.equal(health.browserUse.source, "secret file");
  assert.equal(health.linear.ok, false);
  assert.equal(health.linear.label, "LINEAR_API_KEY missing");
}

// An empty Browser Use secret file should not be reported as configured.
{
  const health = buildIntegrationHealth({
    env: {},
    slackClient: { chatStream() {} },
    fileExists: () => true,
    readFileSyncFn: () => "# no key here\n",
    browserUseSecretFile: "/tmp/browser-use.env",
    linearTeamId: "team-id",
    linearProjectId: "project-id",
    linearStateId: "state-id",
  });
  assert.equal(health.browserUse.ok, false);
  assert.equal(health.browserUse.source, "missing");
}

console.log("integration-health tests passed");
