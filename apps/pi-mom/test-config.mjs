import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "./lib/config.mjs";

const baseEnv = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  HOME: "/tmp/home",
};

test("config accepts minimal echo mode", () => {
  const config = readConfig(baseEnv, { cwd: "/repo", home: "/tmp/home" });
  assert.deepEqual(config.errors, []);
  assert.equal(config.mode, "echo");
  assert.equal(config.streamingEnabled, true);
  assert.equal(config.agentRunnerMode, "fake");
  assert.equal(config.runStatePath, "/tmp/home/.pi/agent/pi-mom/runs.json");
});

test("config requires allowed channel in pi mode unless local override is set", () => {
  const denied = readConfig({ ...baseEnv, PI_MOM_MODE: "pi" });
  assert(denied.errors.some((error) => error.includes("SLACK_ALLOWED_CHANNEL_ID")));

  const allowed = readConfig({ ...baseEnv, PI_MOM_MODE: "pi", SLACK_ALLOWED_CHANNEL_ID: "C123" });
  assert.deepEqual(allowed.errors, []);

  const override = readConfig({ ...baseEnv, PI_MOM_MODE: "pi", PI_MOM_ALLOW_ANY_CHANNEL: "true" });
  assert.deepEqual(override.errors, []);
  assert(override.warnings.some((warning) => warning.includes("allows all Slack channels")));
});

test("config rejects dangerous allow-any-channel in production", () => {
  const config = readConfig({ ...baseEnv, NODE_ENV: "production", PI_MOM_ALLOW_ANY_CHANNEL: "true" });
  assert(config.errors.some((error) => error.includes("not allowed")));
});

test("config rejects invalid enum-like env values", () => {
  assert(readConfig({ ...baseEnv, PI_MOM_MODE: "prod" }).errors.some((error) => error.includes("PI_MOM_MODE")));
  assert(readConfig({ ...baseEnv, PI_MOM_STREAMING: "yes" }).errors.some((error) => error.includes("PI_MOM_STREAMING")));
  assert(readConfig({ ...baseEnv, PI_MOM_AGENT_RUNNER: "shell" }).errors.some((error) => error.includes("PI_MOM_AGENT_RUNNER")));
});

test("config reports missing Slack credentials without printing values", () => {
  const config = readConfig({});
  assert(config.errors.includes("Missing SLACK_BOT_TOKEN."));
  assert(config.errors.includes("Missing SLACK_APP_TOKEN."));
});

test("config clamps bounded integer envs", () => {
  const config = readConfig({ ...baseEnv, PI_MOM_AGENT_MAX_CONCURRENT: "99", PI_MOM_IMAGE_MAX_INPUTS: "-1" });
  assert.equal(config.agentMaxConcurrent, 3);
  assert.equal(config.imageMaxInputs, 0);
});
