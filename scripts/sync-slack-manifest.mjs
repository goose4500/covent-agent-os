#!/usr/bin/env bun
// Sync the Slack app manifest's slash_commands block from declarations in
// skills/, extensions/, and .mcp.json. Optionally pushes the manifest to
// Slack via apps.manifest.update.
//
// Modes:
//   (default)  : regenerate, write file if changed, print summary
//   --check    : regenerate to memory only, exit 1 if drift detected
//   --push     : regenerate + write, then call Slack apps.manifest.update
//                (requires SLACK_APP_CONFIG_TOKEN and SLACK_APP_ID)
//
// Idempotent: re-running with no source changes is a no-op.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverSlashCommands,
  formatCollisions,
} from "../apps/pi-mom/lib/slash-command-discovery.mjs";
import {
  applySlashCommandsToManifest,
} from "../apps/pi-mom/lib/slack-manifest-sync.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = resolve(REPO_ROOT, "apps/pi-mom/manifest.yaml");

function parseArgs(argv) {
  const out = { mode: "write" };
  for (const arg of argv) {
    if (arg === "--check") out.mode = "check";
    else if (arg === "--push") out.mode = "push";
    else if (arg === "--write") out.mode = "write";
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown arg: ${arg}`);
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    `Usage: bun scripts/sync-slack-manifest.mjs [--check | --write | --push]\n\n` +
      `  --write   (default) regenerate slash_commands block and write manifest.yaml if changed\n` +
      `  --check            regenerate in memory and exit 1 if manifest.yaml is out of sync\n` +
      `  --push             regenerate + write, then POST to Slack apps.manifest.update\n`,
  );
}

async function pushToSlack(manifestText) {
  const token = process.env.SLACK_APP_CONFIG_TOKEN;
  const appId = process.env.SLACK_APP_ID;
  if (!token) throw new Error("SLACK_APP_CONFIG_TOKEN is required for --push (xoxe-… app configuration token)");
  if (!appId) throw new Error("SLACK_APP_ID is required for --push");

  const body = new URLSearchParams({
    token,
    app_id: appId,
    manifest: manifestText,
  });

  const res = await fetch("https://slack.com/api/apps.manifest.update", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body,
  });
  const data = await res.json();
  if (!data.ok) {
    const detail = data.errors
      ? `${data.error}: ${JSON.stringify(data.errors)}`
      : data.error || JSON.stringify(data);
    throw new Error(`apps.manifest.update failed: ${detail}`);
  }
  return data;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n`);
    printHelp();
    process.exit(2);
  }
  if (opts.help) {
    printHelp();
    return;
  }

  const { commands, collisions } = discoverSlashCommands({ repoRoot: REPO_ROOT });

  if (collisions.length > 0) {
    process.stderr.write(
      `slash command name collisions:\n${formatCollisions(collisions)}\n`,
    );
    process.exit(1);
  }

  const current = readFileSync(MANIFEST_PATH, "utf-8");
  const next = applySlashCommandsToManifest(current, commands);
  const changed = current !== next;

  const summary = commands
    .map((c) => `  ${c.command.padEnd(28)} ← ${c.source.kind}:${c.source.name}`)
    .join("\n");
  process.stdout.write(
    `Discovered ${commands.length} slash command(s):\n${summary || "  (none)"}\n\n`,
  );

  if (opts.mode === "check") {
    if (!changed) {
      process.stdout.write("manifest.yaml is up to date.\n");
      return;
    }
    process.stderr.write(
      `manifest.yaml is OUT OF SYNC with slash command declarations.\n` +
        `Run \`bun scripts/sync-slack-manifest.mjs\` and commit the result.\n`,
    );
    process.exit(1);
  }

  if (changed) {
    writeFileSync(MANIFEST_PATH, next);
    process.stdout.write(`Wrote ${MANIFEST_PATH}\n`);
  } else {
    process.stdout.write("manifest.yaml is up to date (no write).\n");
  }

  if (opts.mode === "push") {
    process.stdout.write("Pushing manifest to Slack via apps.manifest.update…\n");
    const result = await pushToSlack(next);
    const permalink = result.permalink || `app_id=${process.env.SLACK_APP_ID}`;
    process.stdout.write(`✓ Slack manifest updated (${permalink}).\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`sync-slack-manifest: ${err?.stack || err}\n`);
  process.exit(1);
});
