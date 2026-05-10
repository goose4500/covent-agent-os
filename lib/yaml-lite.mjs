/**
 * Minimal YAML subset used by:
 *   - scripts/validate-agents.mjs   (markdown frontmatter)
 *   - scripts/scaffold-agent.mjs    (agent-kits/profiles/*.yaml)
 *
 * Supports: scalars (string/bool), `[a, b, c]` inline arrays,
 * and block sequences (`key:` followed by `- item` lines).
 * Does NOT support nested maps. Throws on unsupported syntax.
 */

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

export function parseYamlLite(text, sourceName) {
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
      throw new Error(`${sourceName}:${index + 1}: unsupported YAML-lite syntax`);
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

export function parseFrontmatter(text, sourceName) {
  if (!text.startsWith("---")) {
    throw new Error(`${sourceName}: missing frontmatter`);
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`${sourceName}: malformed frontmatter`);
  }
  return parseYamlLite(match[1], sourceName);
}

export function asList(value, fieldName = "value") {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (value == null) return [];
  throw new Error(`${fieldName} must be an array or comma-separated string`);
}
