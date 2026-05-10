#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSupportedUrls } from "./lib/insights/url-classifier.mjs";
import { INSIGHTS_CONFIG } from "./lib/insights/config.mjs";
import { analyzeUrl } from "./lib/insights/analyze.mjs";
import { createDedupeStore } from "./lib/insights/dedupe.mjs";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node test-insights-analyze.mjs <url>");
  console.error("Requires APIFY_API_TOKEN. Set INSIGHTS_DRY_RUN=true to skip Pi.");
  process.exit(2);
}

const [link] = extractSupportedUrls(url);
if (!link) {
  console.error(`Not a supported URL: ${url}`);
  process.exit(2);
}

async function runPiStandalone(prompt, { extraArgs = [] } = {}) {
  const PI_COMMAND = process.env.PI_COMMAND || "pi";
  const promptDir = await mkdtemp(join(tmpdir(), "pi-mom-test-prompt-"));
  const promptPath = join(promptDir, "prompt.md");
  await writeFile(promptPath, prompt, { mode: 0o600 });
  const baseExtra = (process.env.PI_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);
  const args = [...baseExtra, ...extraArgs, "--no-tools", "--no-extensions", "--no-session", "-p", `@${promptPath}`];
  return new Promise((resolve, reject) => {
    const child = spawn(PI_COMMAND, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`pi exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

const trace = (event, data) => console.log(`[trace] ${event}`, data);
const dedupe = createDedupeStore({ ttlMs: 60_000 });

const result = await analyzeUrl({
  link,
  config: INSIGHTS_CONFIG,
  requestId: `test_${Date.now().toString(36)}`,
  runPi: runPiStandalone,
  dedupe,
  trace,
});

console.log("\n=== RESULT ===");
console.log(JSON.stringify({ ok: result.ok, skipped: result.skipped, error: result.error?.message }, null, 2));
console.log("\n=== SLACK-READY TEXT ===\n");
console.log(result.text || "(no text)");
process.exit(result.ok ? 0 : 1);
