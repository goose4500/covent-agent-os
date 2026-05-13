import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { WebClient } from "@slack/web-api";
import { spawnSync } from "node:child_process";
import { subagentsEnabledFromEnv } from "./lib/routes.mjs";

const required = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
let ok = true;
for (const key of required) {
  if (!process.env[key]) {
    console.error(`✗ ${key} is not set`);
    ok = false;
  } else {
    const value = process.env[key];
    const prefix = key === "SLACK_BOT_TOKEN" ? "xoxb-" : "xapp-";
    console.log(`${value.startsWith(prefix) ? "✓" : "!"} ${key} is set${value.startsWith(prefix) ? "" : ` but does not start with ${prefix}`}`);
  }
}

if (process.env.SLACK_BOT_TOKEN) {
  try {
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    const auth = await client.auth.test();
    console.log(`✓ Slack bot auth: ${auth.user} (${auth.user_id}) on ${auth.team}`);
    const expected = process.env.EXPECTED_SLACK_BOT_USER || "covent_pi";
    if (auth.user !== expected) {
      console.error(`✗ Wrong Slack bot token loaded. Expected ${expected}, got ${auth.user}.`);
      ok = false;
    }
  } catch (error) {
    console.error(`✗ Slack auth.test failed: ${error?.data?.error || error.message}`);
    ok = false;
  }
}

if (process.env.OPENAI_API_KEY) {
  console.log(`✓ OPENAI_API_KEY is set (value hidden)`);
} else {
  console.log(`! OPENAI_API_KEY is not set; @Covent Pi image: route will not call OpenAI`);
}

if (process.env.LINEAR_API_KEY) {
  console.log(`✓ LINEAR_API_KEY is set (value hidden)`);
} else {
  console.log(`! LINEAR_API_KEY is not set; @Covent Pi linear: route will draft but cannot create Linear issues`);
}

console.log(`Linear target team: ${process.env.LINEAR_TEAM_ID || "c9c8376e-7fd3-4921-9996-8c98fc2274f2"}`);
console.log(`Linear target project: ${process.env.LINEAR_PROJECT_ID || "ba9682e2-c14e-4208-98a2-a89f3fb285b8"}`);
console.log(`Linear target state: ${process.env.LINEAR_STATE_ID || "adfdb6e9-b118-4d65-ada3-ad11087b7dab"}`);

console.log(`Image route: ${process.env.PI_MOM_IMAGE_ROUTE_ENABLED === "false" ? "disabled" : "enabled"}`);
console.log(`Image model: ${process.env.OPENAI_IMAGE_MODEL || "gpt-image-1"}`);
console.log(`Image quality/size: ${process.env.OPENAI_IMAGE_QUALITY || "low"}/${process.env.OPENAI_IMAGE_SIZE || "1024x1024"}`);

const subagentsEnabled = subagentsEnabledFromEnv(process.env);
console.log(`Team subagents route: ${subagentsEnabled ? "enabled" : "disabled"}`);
if (subagentsEnabled) {
  const piProbe = spawnSync("pi", ["--version"], { encoding: "utf-8" });
  if (piProbe.error?.code === "ENOENT") {
    console.error("✗ PI_MOM_SUBAGENTS_ENABLED=true but `pi` is not on PATH; child subagent runs will fail");
    ok = false;
  } else if (piProbe.error) {
    console.error(`✗ Failed to probe \`pi\` CLI for subagents: ${piProbe.error.message}`);
    ok = false;
  } else {
    const versionText = (piProbe.stdout || piProbe.stderr || "found").trim().split("\n")[0];
    console.log(`✓ pi CLI available for child subagent runs: ${versionText}`);
  }
} else {
  console.log("! team: route will acknowledge as disabled; set PI_MOM_SUBAGENTS_ENABLED=true only after canary verification");
}

try {
  const auth = await AuthStorage.create();
  const registry = ModelRegistry.create(auth);
  const modelId = process.env.PI_MOM_MODEL || "openai-codex/gpt-5.5";
  const slash = modelId.indexOf("/");
  const provider = slash >= 0 ? modelId.slice(0, slash) : modelId;
  const id = slash >= 0 ? modelId.slice(slash + 1) : "";
  const model = registry.find(provider, id);
  if (model) {
    console.log(`✓ Pi SDK model resolved: ${modelId} (thinking: ${process.env.PI_MOM_THINKING_LEVEL || "high"})`);
  } else {
    console.error(`✗ Pi SDK model not found: ${modelId}. Provider key missing or model id wrong?`);
    ok = false;
  }
} catch (error) {
  console.error(`✗ Pi SDK probe failed: ${error?.message || error}`);
  ok = false;
}

console.log(`Test channel name: #${process.env.SLACK_TEST_CHANNEL_NAME || "idea-specs"}`);
console.log(`Allowed channel ID: ${process.env.SLACK_ALLOWED_CHANNEL_ID || "not restricted yet"}`);

process.exit(ok ? 0 : 1);
