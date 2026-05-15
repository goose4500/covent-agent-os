// Tests for lib/slash-command-discovery.mjs.
//
// Drives the discoverer against a synthetic temp repo with skill, extension,
// and MCP fixtures, plus failure cases (collision, invalid command, missing
// description). Also sanity-checks discovery against the real repo so a
// malformed real SKILL.md fails CI immediately rather than at sync time.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SLASH_COMMAND_PATTERN,
  discoverSlashCommands,
} from "./lib/slash-command-discovery.mjs";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REAL_REPO_ROOT = resolve(HERE, "..", "..");

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "slash-discovery-"));
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "extensions"), { recursive: true });
  return root;
}

function writeSkill(root, name, frontmatter, body = "# body") {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n${body}\n`,
  );
}

// 1. Happy path: skill with one slash command.
{
  const root = makeRepo();
  try {
    writeSkill(
      root,
      "thread-summary",
      `name: thread-summary\ndescription: Summarize a Slack thread\nslash_commands:\n  - command: /thread-summary\n    description: Summarize the current Slack thread`,
    );
    const { commands, collisions } = discoverSlashCommands({ repoRoot: root });
    assert.equal(collisions.length, 0);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, "/thread-summary");
    assert.equal(commands[0].description, "Summarize the current Slack thread");
    assert.equal(commands[0].should_escape, false);
    assert.equal(commands[0].source.kind, "skill");
    assert.equal(commands[0].source.name, "thread-summary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 2. Sorted output across multiple skills.
{
  const root = makeRepo();
  try {
    writeSkill(root, "b-skill", `name: b-skill\ndescription: b\nslash_commands:\n  - command: /b-cmd\n    description: b cmd`);
    writeSkill(root, "a-skill", `name: a-skill\ndescription: a\nslash_commands:\n  - command: /a-cmd\n    description: a cmd`);
    const { commands } = discoverSlashCommands({ repoRoot: root });
    assert.deepEqual(commands.map((c) => c.command), ["/a-cmd", "/b-cmd"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 3. Skills without slash_commands are skipped silently.
{
  const root = makeRepo();
  try {
    writeSkill(root, "quiet", `name: quiet\ndescription: nothing to declare`);
    const { commands } = discoverSlashCommands({ repoRoot: root });
    assert.equal(commands.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 4. Extension declarations via sibling .slash-commands.json.
{
  const root = makeRepo();
  try {
    writeFileSync(
      join(root, "extensions", "linear-tools.slash-commands.json"),
      JSON.stringify([
        { command: "/linear-new", description: "File a Linear issue from this thread" },
      ]),
    );
    const { commands } = discoverSlashCommands({ repoRoot: root });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, "/linear-new");
    assert.equal(commands[0].source.kind, "extension");
    assert.equal(commands[0].source.name, "linear-tools");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 5. MCP server declarations via .mcp.json.
{
  const root = makeRepo();
  try {
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          linear: {
            slashCommands: [
              { command: "/linear-search", description: "Search Linear issues from Slack" },
            ],
          },
        },
      }),
    );
    const { commands } = discoverSlashCommands({ repoRoot: root });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].source.kind, "mcp");
    assert.equal(commands[0].source.name, "linear");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 6. Collisions across sources are reported.
{
  const root = makeRepo();
  try {
    writeSkill(root, "alpha", `name: alpha\ndescription: a\nslash_commands:\n  - command: /clash\n    description: alpha owns it`);
    writeFileSync(
      join(root, "extensions", "beta.slash-commands.json"),
      JSON.stringify([{ command: "/clash", description: "beta wants it too" }]),
    );
    const { collisions } = discoverSlashCommands({ repoRoot: root });
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].command, "/clash");
    assert.equal(collisions[0].sources[0].kind, "skill");
    assert.equal(collisions[0].sources[1].kind, "extension");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 7. Invalid command name rejected.
{
  const root = makeRepo();
  try {
    writeSkill(root, "bad", `name: bad\ndescription: x\nslash_commands:\n  - command: NoSlash\n    description: oops`);
    assert.throws(
      () => discoverSlashCommands({ repoRoot: root }),
      /invalid command name/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 8. Missing description rejected.
{
  const root = makeRepo();
  try {
    writeSkill(root, "bad", `name: bad\ndescription: x\nslash_commands:\n  - command: /ok\n    description:`);
    assert.throws(
      () => discoverSlashCommands({ repoRoot: root }),
      /missing description/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 9. Description over 200 chars rejected (Slack limit).
{
  const root = makeRepo();
  try {
    const long = "x".repeat(201);
    writeSkill(root, "long", `name: long\ndescription: x\nslash_commands:\n  - command: /long\n    description: ${long}`);
    assert.throws(
      () => discoverSlashCommands({ repoRoot: root }),
      /exceeds 200 chars/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 10. usage_hint and should_escape pass through.
{
  const root = makeRepo();
  try {
    writeSkill(
      root,
      "hinted",
      `name: hinted\ndescription: x\nslash_commands:\n  - command: /hinted\n    description: hi\n    usage_hint: '<url>'\n    should_escape: true`,
    );
    const { commands } = discoverSlashCommands({ repoRoot: root });
    assert.equal(commands[0].usage_hint, "<url>");
    assert.equal(commands[0].should_escape, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 11. The pattern itself accepts hyphens, digits, underscores; rejects spaces.
assert.ok(SLASH_COMMAND_PATTERN.test("/thread-spec"));
assert.ok(SLASH_COMMAND_PATTERN.test("/abc_123"));
assert.ok(!SLASH_COMMAND_PATTERN.test("/Thread"));
assert.ok(!SLASH_COMMAND_PATTERN.test("/with space"));

// 12. Real repo: discovery succeeds and includes /thread-spec from slack-spec-draft.
{
  const { commands, collisions } = discoverSlashCommands({ repoRoot: REAL_REPO_ROOT });
  assert.equal(collisions.length, 0, `unexpected collisions: ${JSON.stringify(collisions)}`);
  const threadSpec = commands.find((c) => c.command === "/thread-spec");
  assert.ok(threadSpec, "real repo should declare /thread-spec via a skill or extension");
  assert.equal(threadSpec.source.kind, "skill");
}

console.log("slash command discovery tests passed");
