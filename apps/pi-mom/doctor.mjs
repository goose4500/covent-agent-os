import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { WebClient } from "@slack/web-api";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { resolveProjectSkillsDir, subagentsEnabledFromEnv, webAccessEnabledFromEnv } from "./lib/pi-sdk-runner.mjs";

const require = createRequire(import.meta.url);
const TEAM_AGENT_NAMES = ["team-scout", "team-planner", "team-reviewer-readonly"];
const PROJECT_SKILL_SOURCES = new Set(["project", "project-package", "project-settings"]);

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function isUnderDir(filePath, dir) {
  const rel = path.relative(dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function countProjectSkills(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (fs.existsSync(path.join(dir, entry.name, "SKILL.md"))) count += 1;
  }
  return count;
}

function reportProjectSkillsManifest() {
  let checkOk = true;
  const projectSkillsDir = resolveProjectSkillsDir();
  try {
    fs.accessSync(projectSkillsDir, fs.constants.R_OK);
    console.log(`✓ Project skills directory resolved: ${projectSkillsDir} (${countProjectSkills(projectSkillsDir)} SKILL.md files)`);
  } catch (error) {
    console.error(`✗ Project skills directory missing or unreadable: ${projectSkillsDir} (${error?.message || error})`);
    checkOk = false;
  }

  try {
    const appPkg = readJsonFile(new URL("./package.json", import.meta.url));
    const appSkillPaths = Array.isArray(appPkg?.pi?.skills) ? appPkg.pi.skills : [];
    if (appSkillPaths.includes("../../skills")) {
      console.log("✓ apps/pi-mom package.json#pi.skills includes ../../skills for app-cwd discovery");
    } else {
      console.error(`✗ apps/pi-mom package.json#pi.skills does not include ../../skills (found: ${JSON.stringify(appSkillPaths)})`);
      checkOk = false;
    }
  } catch (error) {
    console.error(`✗ Failed to inspect apps/pi-mom package manifest: ${error?.message || error}`);
    checkOk = false;
  }

  return { ok: checkOk, projectSkillsDir };
}

function reportSubagentsPackageResolution() {
  try {
    const appPkg = readJsonFile(new URL("./package.json", import.meta.url));
    const declared = appPkg?.dependencies?.["pi-subagents"];
    const packageJsonPath = require.resolve("pi-subagents/package.json");
    const extensionPath = require.resolve("pi-subagents/src/extension/index.ts");
    const resolvedPkg = readJsonFile(packageJsonPath);
    if (!declared) {
      console.error(`✗ apps/pi-mom does not declare pi-subagents dependency`);
      return false;
    }
    console.log(`✓ pi-subagents app dependency resolves: declared ${declared}, installed ${resolvedPkg.version}, extension ${extensionPath}`);
    return true;
  } catch (error) {
    console.error(`✗ pi-subagents did not resolve from app dependencies: ${error?.message || error}`);
    return false;
  }
}

async function reportTeamSkillDiscovery(projectSkillsDir) {
  let checkOk = true;
  try {
    const [{ discoverAgents }, { clearSkillCache, resolveSkillPath }] = await Promise.all([
      import("pi-subagents/src/agents/agents.ts"),
      import("pi-subagents/src/agents/skills.ts"),
    ]);
    clearSkillCache();
    const { agents } = discoverAgents(process.cwd(), "project");
    const byName = new Map(agents.map((agent) => [agent.name, agent]));
    const resolvedLines = [];

    for (const name of TEAM_AGENT_NAMES) {
      const agent = byName.get(name);
      if (!agent) {
        console.error(`✗ Team agent missing from project discovery: ${name}`);
        checkOk = false;
        continue;
      }
      if (agent.inheritSkills !== true) {
        console.error(`✗ ${name} should keep inheritSkills:true for default skill availability`);
        checkOk = false;
      }
      const skills = agent.skills || [];
      if (skills.length === 0) {
        console.log(`! ${name} declares no explicit skills`);
        continue;
      }
      for (const skillName of skills) {
        const resolved = resolveSkillPath(skillName, process.cwd());
        if (!resolved) {
          console.error(`✗ ${name} skill missing from app-cwd discovery: ${skillName}`);
          checkOk = false;
          continue;
        }
        const projectOwned = PROJECT_SKILL_SOURCES.has(resolved.source) && isUnderDir(resolved.path, projectSkillsDir);
        if (!projectOwned) {
          console.error(`✗ ${name} skill ${skillName} resolves from ${resolved.source} at ${resolved.path}; expected repo-owned ${projectSkillsDir}`);
          checkOk = false;
          continue;
        }
        resolvedLines.push(`${name}:${skillName} (${resolved.source})`);
      }
    }

    if (resolvedLines.length > 0) {
      console.log(`✓ Team agent explicit skills resolve from project-owned paths: ${resolvedLines.join(", ")}`);
    }
  } catch (error) {
    console.error(`✗ Failed to inspect team skill discovery: ${error?.message || error}`);
    checkOk = false;
  }
  return checkOk;
}

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
  console.log(`! OPENAI_API_KEY is not set; Pi model calls may fail if PI_MOM_MODEL requires OpenAI credentials`);
}

if (process.env.LINEAR_API_KEY) {
  console.log(`✓ LINEAR_API_KEY is set (value hidden)`);
} else {
  console.log(`! LINEAR_API_KEY is not set; @Covent Pi linear: route will draft but cannot create Linear issues`);
}

console.log(`Linear target team: ${process.env.LINEAR_TEAM_ID || "c9c8376e-7fd3-4921-9996-8c98fc2274f2"}`);
console.log(`Linear target project: ${process.env.LINEAR_PROJECT_ID || "ba9682e2-c14e-4208-98a2-a89f3fb285b8"}`);
console.log(`Linear target state: ${process.env.LINEAR_STATE_ID || "adfdb6e9-b118-4d65-ada3-ad11087b7dab"}`);

const projectSkillsCheck = reportProjectSkillsManifest();
if (!projectSkillsCheck.ok) ok = false;

const subagentsEnabled = subagentsEnabledFromEnv(process.env);
console.log(`Team subagents: ${subagentsEnabled ? "enabled by default" : "disabled"}`);
if (subagentsEnabled) {
  if (!reportSubagentsPackageResolution()) ok = false;
  const piProbe = spawnSync("pi", ["--version"], { encoding: "utf-8" });
  if (piProbe.error?.code === "ENOENT") {
    console.error("✗ `pi` is not on PATH; child subagent runs will fail");
    ok = false;
  } else if (piProbe.error) {
    console.error(`✗ Failed to probe \`pi\` CLI for subagents: ${piProbe.error.message}`);
    ok = false;
  } else {
    const versionText = (piProbe.stdout || piProbe.stderr || "found").trim().split("\n")[0];
    console.log(`✓ pi CLI available for child subagent runs: ${versionText}`);
  }
}
if (!(await reportTeamSkillDiscovery(projectSkillsCheck.projectSkillsDir))) ok = false;

// pi-mcp-adapter is loaded inline as a Pi extension factory; report its
// resolution and which mcp.json the adapter will read at startup so the
// MCP wiring is observable without booting a session.
try {
  const appPkg = readJsonFile(new URL("./package.json", import.meta.url));
  const declared = appPkg?.dependencies?.["pi-mcp-adapter"];
  const pkgJsonPath = require.resolve("pi-mcp-adapter/package.json");
  const resolvedPkg = readJsonFile(pkgJsonPath);
  if (!declared) {
    console.error("✗ apps/pi-mom does not declare pi-mcp-adapter dependency");
    ok = false;
  } else {
    console.log(`✓ pi-mcp-adapter app dependency resolves: declared ${declared}, installed ${resolvedPkg.version}`);
  }
} catch (error) {
  console.error(`✗ pi-mcp-adapter did not resolve from app dependencies: ${error?.message || error}`);
  ok = false;
}

{
  const agentDir = process.env.PI_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "/root", ".pi", "agent");
  const mcpJsonPath = path.join(agentDir, "mcp.json");
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const raw = readJsonFile(mcpJsonPath);
      const serverCount = raw?.mcpServers ? Object.keys(raw.mcpServers).length : 0;
      console.log(`✓ Pi global override mcp.json present: ${mcpJsonPath} (${serverCount} server${serverCount === 1 ? "" : "s"})`);
    } catch (error) {
      console.error(`✗ ${mcpJsonPath} exists but is not valid JSON: ${error?.message || error}`);
      ok = false;
    }
  } else if (process.env.PI_MCP_JSON_B64) {
    console.log(`! ${mcpJsonPath} missing; will be seeded from PI_MCP_JSON_B64 on next cold boot`);
  } else {
    console.log(`! ${mcpJsonPath} missing and PI_MCP_JSON_B64 is unset; pi-mcp-adapter will register the proxy with zero servers`);
  }
}

const webAccessEnabled = webAccessEnabledFromEnv(process.env);
console.log(`Web access: ${webAccessEnabled ? "enabled by default" : "disabled"}`);
if (webAccessEnabled) {
  try {
    const pkgJsonPath = require.resolve("pi-web-access/package.json");
    const root = path.dirname(pkgJsonPath);
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    const extensionPath = path.join(root, "index.ts");
    const skillsPath = path.join(root, "skills");
    if (pkg.version === "0.10.7" && fs.existsSync(extensionPath) && fs.existsSync(skillsPath)) {
      console.log(`✓ pi-web-access ${pkg.version} resolved from app dependency`);
      console.log(`✓ web extension path: ${extensionPath}`);
      console.log(`✓ web skills path: ${skillsPath}`);
      console.log(`✓ web tools are default-on from the app-pinned pi-web-access package`);
    } else {
      console.error(`✗ pi-web-access resolved but expected version/path is missing (version=${pkg.version || "?"})`);
      ok = false;
    }
  } catch (error) {
    console.error(`✗ pi-web-access cannot be resolved: ${error?.message || error}`);
    ok = false;
  }
  if (process.env.PI_ALLOW_BROWSER_COOKIES === "1") {
    console.error("! PI_ALLOW_BROWSER_COOKIES=1; browser-cookie Gemini Web is operator-enabled (keep unset/0 by default)");
  } else {
    console.log("✓ PI_ALLOW_BROWSER_COOKIES is not enabled by env");
  }
  console.log(`Web provider keys: EXA=${process.env.EXA_API_KEY ? "set" : "unset"}, PERPLEXITY=${process.env.PERPLEXITY_API_KEY ? "set" : "unset"}, GEMINI=${process.env.GEMINI_API_KEY ? "set" : "unset"}`);
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

  // Read-only/scout-like subagents (team-scout, team-reviewer-readonly, and
  // global scout/auditor profiles) pin google/gemini-3.1-flash-lite-preview
  // via frontmatter. Probe it here so cold boot fails loudly when the google
  // provider is not seeded (GEMINI_API_KEY missing) instead of failing later
  // at child CLI spawn.
  const SUBAGENT_MODEL_ID = "google/gemini-3.1-flash-lite-preview";
  const subSlash = SUBAGENT_MODEL_ID.indexOf("/");
  const subProvider = SUBAGENT_MODEL_ID.slice(0, subSlash);
  const subId = SUBAGENT_MODEL_ID.slice(subSlash + 1);
  const subModel = registry.find(subProvider, subId);
  if (subModel) {
    console.log(`✓ Subagent model resolved: ${SUBAGENT_MODEL_ID}`);
  } else {
    console.error(`✗ Subagent model not found: ${SUBAGENT_MODEL_ID}. Set GEMINI_API_KEY (Google AI Studio) so Pi's google provider can resolve it.`);
    ok = false;
  }
} catch (error) {
  console.error(`✗ Pi SDK probe failed: ${error?.message || error}`);
  ok = false;
}

console.log(`Test channel name: #${process.env.SLACK_TEST_CHANNEL_NAME || "idea-specs"}`);
console.log(`Allowed channel IDs: ${process.env.SLACK_ALLOWED_CHANNEL_IDS || process.env.SLACK_ALLOWED_CHANNEL_ID || "not restricted yet"}`);

process.exit(ok ? 0 : 1);
