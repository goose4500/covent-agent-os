// Enforces that every slash command declared by a skill/extension/MCP server
// is wired to an `app.command("/xxx", ...)` handler in index.mjs.
//
// This is the second half of the auto-sync contract: the manifest sync keeps
// Slack's declared command list in lockstep with declarations, and this test
// keeps the bridge's runtime routing in lockstep. Either drift fails CI.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSlashCommands } from "./lib/slash-command-discovery.mjs";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..");
const INDEX_PATH = resolve(HERE, "index.mjs");

const indexSrc = readFileSync(INDEX_PATH, "utf-8");

// Capture every registered `app.command("/xxx", ...)` regardless of quote style.
const registered = new Set();
for (const match of indexSrc.matchAll(/app\.command\(\s*["'`](\/[a-z0-9_-]+)["'`]/g)) {
  registered.add(match[1]);
}

const { commands, collisions } = discoverSlashCommands({ repoRoot: REPO_ROOT });
assert.equal(collisions.length, 0, `collisions detected: ${JSON.stringify(collisions)}`);

for (const cmd of commands) {
  assert.ok(
    registered.has(cmd.command),
    `Slash command ${cmd.command} is declared by ${cmd.source.kind}:${cmd.source.name} ` +
      `but has no \`app.command("${cmd.command}", ...)\` handler in apps/pi-mom/index.mjs. ` +
      `Add a handler before merging.`,
  );
}

console.log(`slash command handler enforcement passed (${commands.length} command(s) wired)`);
