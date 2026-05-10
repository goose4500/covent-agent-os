import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

const agentRoots = [
  path.resolve(".pi", "agents"), // canonical executable project subagents
  path.resolve("agents"), // legacy/source agent definitions
];
const skillRoot = path.resolve("skills");
const strict = process.env.STRICT_AGENT_VALIDATION === "true";
const warnings = [];
const errors = [];
let count = 0;

const toolAllowlist = new Set([
  "bash",
  "code_search",
  "contact_supervisor",
  "edit",
  "fetch_content",
  "find",
  "get_search_content",
  "gpt_image_edit",
  "gpt_image_generate",
  "grep",
  "ls",
  "mcp",
  "mcp:context7",
  "read",
  "web_search",
  "write",
]);

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(file, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(file);
    }
  }
  return files;
}

function parseFrontmatter(text, sourceName) {
  if (!text.startsWith("---")) {
    throw new Error(`${sourceName}: missing frontmatter`);
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`${sourceName}: malformed frontmatter`);
  }
  let parsed;
  try {
    parsed = yaml.load(match[1], { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    throw new Error(`${sourceName}: invalid YAML frontmatter — ${error.message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourceName}: frontmatter must be a YAML mapping`);
  }
  return parsed;
}

function asList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function displayPath(file) {
  return path.relative(process.cwd(), file) || file;
}

const seenNames = new Map();

for (const root of agentRoots) {
  if (!(await exists(root))) continue;

  const files = (await walk(root)).sort();
  for (const file of files) {
    count++;
    const rel = displayPath(file);
    let frontmatter;
    try {
      frontmatter = parseFrontmatter(await readFile(file, "utf8"), rel);
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    const expectedName = path.basename(file, ".md");

    if (!name) errors.push(`${rel}: missing name`);
    if (!description) errors.push(`${rel}: missing description`);
    if (name && name !== expectedName) {
      errors.push(`${rel}: name ${name} does not match filename ${expectedName}`);
    }
    if (name) {
      const previous = seenNames.get(name);
      if (previous) {
        warnings.push(`${rel}: duplicate agent name ${name}; also defined in ${previous}`);
      } else {
        seenNames.set(name, rel);
      }
    }

    if (!frontmatter.systemPromptMode) warnings.push(`${rel}: missing systemPromptMode`);
    if (!frontmatter.defaultContext) warnings.push(`${rel}: missing defaultContext`);

    for (const tool of asList(frontmatter.tools)) {
      if (!toolAllowlist.has(tool)) {
        errors.push(`${rel}: unknown tool ${tool}`);
      }
    }

    for (const skill of asList(frontmatter.skills)) {
      const skillFile = path.join(skillRoot, skill, "SKILL.md");
      if (!(await exists(skillFile))) {
        errors.push(`${rel}: referenced skill ${skill} not found at ${displayPath(skillFile)}`);
      }
    }
  }
}

if (warnings.length) {
  const label = strict ? "Agent validation errors" : "Agent validation warnings";
  console.warn(`${label}:\n${warnings.join("\n")}`);
  if (strict) errors.push(...warnings);
}

if (errors.length) {
  console.error(`Agent validation errors:\n${errors.join("\n")}`);
  process.exit(1);
}

console.log(`validate:agents ok (${count} agents, ${warnings.length} warnings)`);
