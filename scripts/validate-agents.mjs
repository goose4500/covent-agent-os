import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const agentRoots = [
  path.resolve(".pi", "agents"), // canonical executable project subagents
];
const skillRoot = path.resolve("skills");
const strict = process.env.STRICT_AGENT_VALIDATION === "true";
const warnings = [];
const errors = [];
let count = 0;

const toolAllowlist = new Set([
  "bash",
  "cloudwatch_log_audit",
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
  "s3_put_artifact",
  "sqs_send_event",
  "ssm_get_secret",
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

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return stripQuotes(trimmed);
}

function parseYamlValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item)).filter((item) => item !== "");
  }
  return parseScalar(trimmed);
}

function parseFrontmatterYaml(text, sourceName) {
  const result = {};
  let currentListKey = null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("- ")) {
      if (!currentListKey) {
        throw new Error(`${sourceName}:${index + 1}: list item without a preceding key`);
      }
      result[currentListKey].push(parseScalar(line.slice(2)));
      continue;
    }

    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) {
      throw new Error(`${sourceName}:${index + 1}: unsupported frontmatter syntax`);
    }

    const [, key, value = ""] = match;
    if (value === "") {
      result[key] = [];
      currentListKey = key;
    } else {
      result[key] = parseYamlValue(value);
      currentListKey = null;
    }
  }

  return result;
}

function parseFrontmatter(text, sourceName) {
  if (!text.startsWith("---")) {
    throw new Error(`${sourceName}: missing frontmatter`);
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`${sourceName}: malformed frontmatter`);
  }
  return parseFrontmatterYaml(match[1], sourceName);
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
