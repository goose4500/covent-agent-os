import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_AGENT_CONFIG_PATH, loadAgentConfig } from "../apps/pi-mom/lib/agent-config.mjs";

const configPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_AGENT_CONFIG_PATH;

if (!existsSync(configPath)) {
  console.error(`validate:agent failed: agent.yaml not found at ${configPath}`);
  process.exit(1);
}

let config;
try {
  config = loadAgentConfig(configPath);
} catch (error) {
  console.error(`validate:agent failed: ${error.message}`);
  process.exit(1);
}

const profileCount = Object.keys(config.profiles).length;
const actionCount = config.actions.length;
const channelCount = config.channels?.length ?? 0;
const handlerSummary = config.actions
  .map((a) => `${a.key} → ${a.handler} (${a.profile})`)
  .join(", ");

console.log(
  `validate:agent ok (${profileCount} profile${profileCount === 1 ? "" : "s"}, ${actionCount} action${actionCount === 1 ? "" : "s"}, ${channelCount} channel${channelCount === 1 ? "" : "s"}): ${handlerSummary}`,
);
