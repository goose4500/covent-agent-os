// Regenerates the `slash_commands:` block in apps/pi-mom/manifest.yaml from
// the slash commands discovered across skills, extensions, and MCP servers.
//
// We do line-based replacement instead of a full YAML round-trip so the rest
// of the manifest (scope ordering, comments-via-spacing, ordering of feature
// blocks) is preserved exactly. The manifest has a stable shape today and is
// edited via this script for the slash_commands surface only.

const FEATURE_INDENT = "  ";
const ITEM_INDENT = "  ";
const KEY_INDENT = "    ";

export function renderSlashCommandsBlock(commands) {
  if (!commands || commands.length === 0) {
    return `${FEATURE_INDENT}slash_commands: []\n`;
  }
  const out = [`${FEATURE_INDENT}slash_commands:`];
  for (const cmd of commands) {
    out.push(`${ITEM_INDENT}- command: ${cmd.command}`);
    out.push(`${KEY_INDENT}description: ${yamlScalar(cmd.description)}`);
    if (cmd.usage_hint) {
      out.push(`${KEY_INDENT}usage_hint: ${yamlScalar(cmd.usage_hint)}`);
    }
    out.push(`${KEY_INDENT}should_escape: ${cmd.should_escape ? "true" : "false"}`);
  }
  return out.join("\n") + "\n";
}

function yamlScalar(value) {
  const needsQuoting = /[:#&*!|>%@`,?\[\]{}'"]/.test(value) || /^\s|\s$/.test(value);
  if (!needsQuoting) return value;
  // Single-quote escape: double any embedded single quotes.
  return `'${value.replace(/'/g, "''")}'`;
}

// Finds the `^  slash_commands:` block under `features:` and returns
// [startLineIndex, endLineIndexExclusive]. The block ends at the next line that
// is not indented past the feature key (i.e., another `^  word:` sibling or EOF).
export function findSlashCommandsRange(lines) {
  const headerIdx = lines.findIndex((line) => /^  slash_commands:(?:\s*$|\s+\[.*)/.test(line));
  if (headerIdx < 0) return null;
  let end = headerIdx + 1;
  while (end < lines.length) {
    const line = lines[end];
    // Stop at next feature sibling (`^  \w...:`) or top-level key (`^\w...:`) or EOF.
    if (/^  [A-Za-z_]/.test(line) && !/^   /.test(line)) break;
    if (/^[A-Za-z_]/.test(line)) break;
    end += 1;
  }
  return [headerIdx, end];
}

export function applySlashCommandsToManifest(manifestText, commands) {
  const lines = manifestText.split("\n");
  const range = findSlashCommandsRange(lines);
  const block = renderSlashCommandsBlock(commands);
  const blockLines = block.split("\n");
  // renderSlashCommandsBlock always ends with "\n" so split yields a trailing
  // empty string; drop it so we don't introduce a blank line in the manifest.
  if (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
    blockLines.pop();
  }
  if (range) {
    const [start, end] = range;
    const before = lines.slice(0, start);
    const after = lines.slice(end);
    return [...before, ...blockLines, ...after].join("\n");
  }
  // Insert before `oauth_config:` (the section that follows `features:` in our manifest).
  const oauthIdx = lines.findIndex((line) => /^oauth_config:/.test(line));
  if (oauthIdx < 0) {
    throw new Error("manifest.yaml: cannot find slash_commands: block or oauth_config: anchor");
  }
  const before = lines.slice(0, oauthIdx);
  const after = lines.slice(oauthIdx);
  return [...before, ...blockLines, ...after].join("\n");
}
