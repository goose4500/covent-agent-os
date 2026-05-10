#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { asList, parseYamlLite } from "../lib/yaml-lite.mjs";

const GENERATED_MARKER = "<!-- generated-by: scaffold-agent -->";
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh"]);
const REQUIRED_PROFILE_KEYS = [
  "name",
  "description",
  "tools",
  "skills",
  "extensions",
  "runtime",
  "allowShell",
  "allowWrites",
  "allowExternalMutation",
  "approval",
  "forbiddenFromSlack",
];

const usage = `Usage: node scripts/scaffold-agent.mjs <agent-name> --profile <profile-name> [options]\n\nOptions:\n  --description "<text>"\n  --skills "a,b,c"\n  --thinking "low|medium|high|xhigh"\n  --force`;

function fail(message) {
  console.error(`scaffold-agent: ${message}`);
  console.error(usage);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { force: false };
  let agentName;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!["profile", "description", "skills", "thinking"].includes(key)) {
        fail(`unknown option ${arg}`);
      }
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      options[key] = value;
      continue;
    }
    if (agentName) fail(`unexpected positional argument ${arg}`);
    agentName = arg;
  }

  if (!agentName) fail("missing <agent-name>");
  if (!NAME_RE.test(agentName)) fail(`invalid agent name ${agentName}; expected ${NAME_RE}`);
  if (!options.profile) fail("missing required --profile <profile-name>");
  if (!NAME_RE.test(options.profile)) fail(`invalid profile name ${options.profile}; expected ${NAME_RE}`);
  if (options.thinking && !THINKING_LEVELS.has(options.thinking)) {
    fail(`invalid --thinking ${options.thinking}; expected low, medium, high, or xhigh`);
  }

  return { agentName, options };
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function frontmatterValue(value) {
  return oneLine(value).replace(/\n/g, " ");
}

function csv(value) {
  return value.join(", ");
}

function yesNo(value) {
  return value ? "yes" : "no";
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeGenerated(file, content, force) {
  await mkdir(path.dirname(file), { recursive: true });
  if ((await exists(file)) && !force) {
    console.log(`skip existing ${file}`);
    return "skipped";
  }
  await writeFile(file, content, "utf8");
  console.log(`${force ? "wrote" : "created"} ${file}`);
  return "written";
}

function buildAgentMarkdown({ name, description, tools, skills, thinking, profile }) {
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${frontmatterValue(description)}`,
    `tools: ${csv(tools)}`,
  ];
  if (thinking) lines.push(`thinking: ${thinking}`);
  lines.push(
    "systemPromptMode: replace",
    "inheritProjectContext: false",
    "inheritSkills: false",
    "defaultContext: fresh",
  );
  if (skills.length) lines.push(`skills: ${csv(skills)}`);
  lines.push("---", GENERATED_MARKER, "");

  return `${lines.join("\n")}You are \`${name}\`, a Pi agent generated from the \`${profile.name}\` permission profile.\n\nMission: ${oneLine(description)}\n\nPermission profile:\n- Runtime: ${profile.runtime}\n- Shell allowed: ${yesNo(profile.allowShell)}\n- File writes allowed: ${yesNo(profile.allowWrites)}\n- External mutation allowed: ${yesNo(profile.allowExternalMutation)}\n- Approval policy: ${profile.approval}\n- Forbidden Slack-derived content: ${csv(asList(profile.forbiddenFromSlack, "forbiddenFromSlack")) || "none"}\n\nOperating rules:\n- Stay within the named mission and assigned tools.\n- Do not reveal, log, commit, or paste secrets.\n- Do not mutate Slack, Linear, Railway, Whimsical, Git remotes, or other external systems unless current explicit approval exists and this profile allows it.\n- Do not deploy or push unless the user or supervisor explicitly approves that action.\n- When blocked by scope or safety, state the blocker and the safe next step.\n\nReturn:\n- Actions taken\n- Validation or evidence\n- Risks or blockers\n- Recommended next step\n`;
}

function buildSkillMarkdown({ name, description, tools, skills, profile }) {
  return `---\nname: ${name}\ndescription: Reusable operating skill for ${frontmatterValue(description)}\n---\n${GENERATED_MARKER}\n\n# ${name}\n\nUse this skill when executing the \`${name}\` agent mission.\n\n## Inputs\n\n- A bounded task or audit request.\n- Any relevant repo paths, issue IDs, or evidence supplied by the caller.\n\n## Workflow\n\n1. Restate the mission and permission boundary from the \`${profile.name}\` profile.\n2. Use only the assigned tools: ${csv(tools) || "none"}.\n3. Apply the assigned skills when relevant: ${csv(skills) || "none"}.\n4. Collect evidence before making changes or recommendations.\n5. Validate completed work with the narrowest relevant checks.\n\n## Output\n\nReturn a concise summary with actions taken, validation or evidence, risks, and the recommended next step.\n`;
}

function buildPromptMarkdown({ name, description, profile }) {
  return `---\ndescription: ${frontmatterValue(description)}\nargument-hint: "[task]"\n---\n${GENERATED_MARKER}\n\nUse the \`${name}\` agent when the task matches this mission:\n\n${oneLine(description)}\n\nTask:\n\n$ARGUMENTS\n\nExpected output:\n\n- Summary of what was done or found.\n- Evidence, file paths, commands, issue identifiers, or links used.\n- Validation performed or why validation was not possible.\n- Risks, blockers, or approval needs.\n- Recommended next step.\n\nBoundary reminder: follow the \`${profile.name}\` profile and do not perform external mutations, deploys, pushes, or secret disclosure without explicit current approval.\n`;
}

async function main() {
  const { agentName, options } = parseArgs(process.argv.slice(2));
  const profilePath = path.join("agent-kits", "profiles", `${options.profile}.yaml`);

  let profileText;
  try {
    profileText = await readFile(profilePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") fail(`profile not found: ${profilePath}`);
    throw error;
  }

  let profile;
  try {
    profile = parseYamlLite(profileText, profilePath);
  } catch (error) {
    fail(error.message);
  }

  const missingProfileKeys = REQUIRED_PROFILE_KEYS.filter((key) => !(key in profile));
  if (missingProfileKeys.length) {
    fail(`${profilePath} missing required keys: ${missingProfileKeys.join(", ")}`);
  }
  if (profile.name !== options.profile) {
    fail(`${profilePath} name ${profile.name} does not match requested profile ${options.profile}`);
  }

  const tools = asList(profile.tools, "tools");
  const skills = options.skills ? splitCsv(options.skills) : asList(profile.skills, "skills");
  const description = options.description || profile.description || `${agentName} agent generated from ${profile.name}`;

  const agentFile = path.join(".pi", "agents", `${agentName}.md`);
  const skillFile = path.join("skills", agentName, "SKILL.md");
  const promptFile = path.join("prompts", `${agentName}.md`);

  await writeGenerated(
    agentFile,
    buildAgentMarkdown({ name: agentName, description, tools, skills, thinking: options.thinking, profile }),
    options.force,
  );
  await writeGenerated(
    skillFile,
    buildSkillMarkdown({ name: agentName, description, tools, skills, profile }),
    options.force,
  );
  await writeGenerated(
    promptFile,
    buildPromptMarkdown({ name: agentName, description, profile }),
    options.force,
  );
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
