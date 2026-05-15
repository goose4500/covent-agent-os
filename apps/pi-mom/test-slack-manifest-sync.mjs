// Tests for lib/slack-manifest-sync.mjs and an end-to-end drift check
// against the live apps/pi-mom/manifest.yaml.
//
// The drift check is the auto-sync's load-bearing CI signal: if anyone adds a
// slash command via SKILL.md/extension/MCP declaration without running the
// sync script, this test fails and CI blocks the PR.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applySlashCommandsToManifest,
  findSlashCommandsRange,
  renderSlashCommandsBlock,
} from "./lib/slack-manifest-sync.mjs";
import { discoverSlashCommands } from "./lib/slash-command-discovery.mjs";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..");
const MANIFEST_PATH = resolve(REPO_ROOT, "apps/pi-mom/manifest.yaml");

// 1. renderSlashCommandsBlock: stable formatting.
{
  const out = renderSlashCommandsBlock([
    { command: "/foo", description: "Foo", should_escape: false },
  ]);
  assert.equal(
    out,
    "  slash_commands:\n  - command: /foo\n    description: Foo\n    should_escape: false\n",
  );
}

// 2. renderSlashCommandsBlock: empty list emits []
{
  assert.equal(renderSlashCommandsBlock([]), "  slash_commands: []\n");
}

// 3. renderSlashCommandsBlock: quoting for values with reserved chars.
{
  const out = renderSlashCommandsBlock([
    { command: "/x", description: "Has: colon", should_escape: false },
  ]);
  assert.match(out, /description: 'Has: colon'/);
}

// 4. findSlashCommandsRange against the live manifest.
{
  const text = readFileSync(MANIFEST_PATH, "utf-8");
  const range = findSlashCommandsRange(text.split("\n"));
  assert.ok(range, "live manifest must contain a slash_commands: block");
  const [start, end] = range;
  assert.ok(end > start);
}

// 5. applySlashCommandsToManifest: round-trip preserves all other content.
{
  const text = readFileSync(MANIFEST_PATH, "utf-8");
  const before = text.split("\n");
  const out = applySlashCommandsToManifest(text, [
    { command: "/thread-spec", description: "Draft a spec from a Slack thread", should_escape: false },
  ]);
  const after = out.split("\n");
  const range = findSlashCommandsRange(before);
  const [start, end] = range;
  // Lines outside the replaced range must be byte-identical.
  assert.deepEqual(before.slice(0, start), after.slice(0, start));
  const afterRange = findSlashCommandsRange(after);
  const [, afterEnd] = afterRange;
  assert.deepEqual(before.slice(end), after.slice(afterEnd));
}

// 6. applySlashCommandsToManifest: replacing with a different command set.
{
  const text = readFileSync(MANIFEST_PATH, "utf-8");
  const out = applySlashCommandsToManifest(text, [
    { command: "/alpha", description: "alpha", should_escape: false },
    { command: "/beta", description: "beta", should_escape: false },
  ]);
  assert.match(out, /\n  slash_commands:\n  - command: \/alpha\n    description: alpha\n    should_escape: false\n  - command: \/beta\n/);
  // The next sibling key (oauth_config) must still be present and at the top level.
  assert.match(out, /\noauth_config:/);
}

// 7. DRIFT CHECK: live manifest matches discovered commands.
//    If this fails, run `bun scripts/sync-slack-manifest.mjs` and commit the diff.
{
  const text = readFileSync(MANIFEST_PATH, "utf-8");
  const { commands, collisions } = discoverSlashCommands({ repoRoot: REPO_ROOT });
  assert.equal(collisions.length, 0, `manifest sync would fail due to collisions: ${JSON.stringify(collisions)}`);
  const expected = applySlashCommandsToManifest(text, commands);
  assert.equal(
    text,
    expected,
    "apps/pi-mom/manifest.yaml is out of sync with declared slash commands. Run: bun scripts/sync-slack-manifest.mjs",
  );
}

console.log("slack manifest sync tests passed");
