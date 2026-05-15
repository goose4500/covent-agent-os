// Slash command discovery.
//
// Walks the repo to enumerate every `/`-command declared by:
//   - a skill            via `slash_commands:` in skills/<name>/SKILL.md frontmatter
//   - an extension       via a sibling extensions/<name>.slash-commands.json
//   - an MCP server      via `slashCommands` on a server entry in .mcp.json
//
// Returns a deterministic, sorted list of commands with their source so
// downstream tooling (manifest sync, route enforcement) can act on them.
//
// Why a custom YAML parser: the skill frontmatter shape we need is tiny
// (`name`, `description`, `slash_commands:` list-of-objects). Pulling in a
// full YAML dep just for the sync script is overkill; this parser is scoped
// to the shapes we accept and refuses anything else.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const SLASH_COMMAND_PATTERN = /^\/[a-z][a-z0-9_-]*$/;

export function repoRootFromLib(libDir = new URL(".", import.meta.url).pathname) {
  return resolve(libDir, "..", "..", "..");
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const rest = text.slice(4);
  const end = rest.search(/\n---(?:\r?\n|$)/);
  if (end < 0) return null;
  return rest.slice(0, end);
}

// Minimal YAML reader: top-level scalars and list-of-objects only.
// Supports the shapes the discoverer actually consumes; throws on anything else.
function parseFrontmatterBlock(block) {
  const lines = block.split(/\r?\n/);
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i += 1; continue; }
    const scalarMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!scalarMatch) {
      throw new Error(`unrecognized frontmatter line: ${JSON.stringify(line)}`);
    }
    const key = scalarMatch[1];
    const rawValue = scalarMatch[2];

    if (rawValue === "" || rawValue === ">-" || rawValue === "|") {
      // Either a folded/literal scalar continuation OR a list/map below.
      // Peek next non-blank line to disambiguate.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (j < lines.length && /^\s+-\s/.test(lines[j])) {
        const { items, nextIndex } = readListOfObjects(lines, j);
        out[key] = items;
        i = nextIndex;
        continue;
      }
      // Folded/literal scalar — slurp indented continuation lines.
      const parts = [];
      let k = i + 1;
      while (k < lines.length && /^\s+\S/.test(lines[k])) {
        parts.push(lines[k].trim());
        k += 1;
      }
      out[key] = parts.join(" ");
      i = k;
      continue;
    }

    out[key] = unquote(rawValue.trim());
    i += 1;
  }
  return out;
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function readListOfObjects(lines, startIndex) {
  const items = [];
  let i = startIndex;
  let baseIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const match = line.match(/^(\s+)-\s+(.*)$/);
    if (!match) break;
    const indent = match[1].length;
    if (baseIndent === null) baseIndent = indent;
    if (indent !== baseIndent) break;
    const first = match[2];
    const obj = {};
    const firstKv = first.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!firstKv) throw new Error(`expected key: value at ${JSON.stringify(line)}`);
    obj[firstKv[1]] = unquote(firstKv[2].trim());
    i += 1;
    while (i < lines.length) {
      const cont = lines[i];
      if (!cont.trim()) { i += 1; continue; }
      const contMatch = cont.match(/^(\s+)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!contMatch) break;
      if (contMatch[1].length <= baseIndent) break;
      obj[contMatch[2]] = unquote(contMatch[3].trim());
      i += 1;
    }
    items.push(obj);
  }
  return { items, nextIndex: i };
}

function validateCommandEntry(entry, sourceLabel) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`${sourceLabel}: slash command entry must be an object`);
  }
  const command = entry.command;
  const description = entry.description;
  if (typeof command !== "string" || !SLASH_COMMAND_PATTERN.test(command)) {
    throw new Error(
      `${sourceLabel}: invalid command name ${JSON.stringify(command)}; must match ${SLASH_COMMAND_PATTERN}`,
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`${sourceLabel}: command ${command} is missing description`);
  }
  if (description.length > 200) {
    throw new Error(`${sourceLabel}: command ${command} description exceeds 200 chars (Slack limit)`);
  }
  const usageHint = entry.usage_hint !== undefined ? entry.usage_hint : entry.usageHint;
  const result = { command, description: description.trim() };
  if (typeof usageHint === "string" && usageHint.trim()) {
    result.usage_hint = usageHint.trim();
  }
  if (entry.should_escape !== undefined) {
    result.should_escape = entry.should_escape === true || entry.should_escape === "true";
  } else {
    result.should_escape = false;
  }
  return result;
}

function discoverFromSkills(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const skillDir = join(skillsDir, name);
    let stat;
    try { stat = statSync(skillDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const text = readFileSync(skillPath, "utf-8");
    const block = parseFrontmatter(text);
    if (!block) continue;
    let frontmatter;
    try {
      frontmatter = parseFrontmatterBlock(block);
    } catch (err) {
      throw new Error(`${skillPath}: ${err.message}`);
    }
    const list = frontmatter.slash_commands;
    if (!Array.isArray(list) || list.length === 0) continue;
    for (const raw of list) {
      const validated = validateCommandEntry(raw, `${skillPath}`);
      out.push({
        ...validated,
        source: { kind: "skill", name: frontmatter.name || name, path: skillPath },
      });
    }
  }
  return out;
}

function discoverFromExtensions(extensionsDir) {
  if (!existsSync(extensionsDir)) return [];
  const out = [];
  for (const file of readdirSync(extensionsDir).sort()) {
    if (!file.endsWith(".slash-commands.json")) continue;
    const path = join(extensionsDir, file);
    const text = readFileSync(path, "utf-8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${path}: invalid JSON: ${err.message}`);
    }
    const list = Array.isArray(parsed) ? parsed : parsed?.slash_commands;
    if (!Array.isArray(list)) {
      throw new Error(`${path}: expected an array or { slash_commands: [...] }`);
    }
    const extensionName = file.replace(/\.slash-commands\.json$/, "");
    for (const raw of list) {
      const validated = validateCommandEntry(raw, path);
      out.push({
        ...validated,
        source: { kind: "extension", name: extensionName, path },
      });
    }
  }
  return out;
}

function discoverFromMcp(repoRoot) {
  // Repo-checked-in .mcp.json is the only path we read at sync time.
  // The Railway-seeded ${PI_AGENT_DIR}/mcp.json is host-specific and not
  // appropriate for build-time discovery.
  const path = join(repoRoot, ".mcp.json");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: invalid JSON: ${err.message}`);
  }
  const servers = parsed?.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
  const out = [];
  for (const [serverName, server] of Object.entries(servers)) {
    const list = server?.slashCommands;
    if (!Array.isArray(list) || list.length === 0) continue;
    for (const raw of list) {
      const validated = validateCommandEntry(raw, `${path} (${serverName})`);
      out.push({
        ...validated,
        source: { kind: "mcp", name: serverName, path },
      });
    }
  }
  return out;
}

export function discoverSlashCommands({ repoRoot = repoRootFromLib() } = {}) {
  const commands = [
    ...discoverFromSkills(join(repoRoot, "skills")),
    ...discoverFromExtensions(join(repoRoot, "extensions")),
    ...discoverFromMcp(repoRoot),
  ];

  const byName = new Map();
  const collisions = [];
  for (const entry of commands) {
    const existing = byName.get(entry.command);
    if (existing) {
      collisions.push({
        command: entry.command,
        sources: [existing.source, entry.source],
      });
      continue;
    }
    byName.set(entry.command, entry);
  }

  const sorted = [...byName.values()].sort((a, b) => a.command.localeCompare(b.command));
  return { commands: sorted, collisions };
}

export function formatCollisions(collisions) {
  return collisions
    .map((c) => {
      const where = c.sources
        .map((s) => `${s.kind}:${s.name} (${s.path})`)
        .join(" and ");
      return `  - ${c.command} declared by ${where}`;
    })
    .join("\n");
}
