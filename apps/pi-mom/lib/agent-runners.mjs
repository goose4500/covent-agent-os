import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_HEALTH_COMMANDS = Object.freeze([
  Object.freeze(["git", ["rev-parse", "--show-toplevel"]]),
  Object.freeze(["git", ["status", "--short"]]),
  Object.freeze(["node", ["--check", "apps/pi-mom/index.mjs"]]),
  Object.freeze(["node", ["--check", "apps/pi-mom/doctor.mjs"]]),
  Object.freeze(["node", ["--check", "apps/pi-mom/lib/agent-run-card.mjs"]]),
  Object.freeze(["node", ["--check", "apps/pi-mom/lib/agent-run-store.mjs"]]),
  Object.freeze(["node", ["--check", "apps/pi-mom/lib/agent-runners.mjs"]]),
  Object.freeze(["node", ["--check", "apps/pi-mom/lib/slack-canvas.mjs"]]),
]);

const AGENT_RUNNER_MODES = Object.freeze(["fake", "repo-health", "supervised-pi"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SUPERVISED_PI_TIMEOUT_MS = 300_000;
const OUTPUT_CAP_CHARS = 12_000;
const DEFAULT_SUPERVISED_PI_OUTPUT_CAP_CHARS = 20_000;
const DEFAULT_SUPERVISED_PI_COMMAND = "pi";
const DEFAULT_SUPERVISED_PI_PROFILE = "covent-speed-operator";

export function getAgentRunnerModes() {
  return [...AGENT_RUNNER_MODES];
}

export function getRepoHealthCommandTuples() {
  return REPO_HEALTH_COMMANDS.map(([command, args]) => [command, [...args]]);
}

export function redactSensitiveText(text = "") {
  return String(text || "")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "xox[REDACTED]")
    .replace(/xapp-[A-Za-z0-9-]+/g, "xapp-[REDACTED]")
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, "sk-proj-[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]")
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, "AWS_KEY[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh_[REDACTED]")
    .replace(/Authorization:\s*Bearer\s+[^\s'"`]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/\b(token|secret|password|cookie|session|api[_-]?key)\s*[:=]\s*[^\s'"`]+/gi, "$1=[REDACTED]");
}

function cap(text = "", max = OUTPUT_CAP_CHARS) {
  const clean = redactSensitiveText(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n...output truncated by pi-mom agent runner...`;
}

export function scrubSensitiveEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/TOKEN|SECRET|KEY|PASSWORD|COOKIE|SESSION|SLACK|LINEAR|OPENAI|ANTHROPIC|GEMINI|XAI|AWS/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("agent run canceled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("agent run canceled"));
    }, { once: true });
  });
}

function promptHash(prompt = "") {
  return createHash("sha256").update(String(prompt)).digest("hex").slice(0, 12);
}

function boundedNumber(value, fallback, { min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function parseSupervisedPiExtraArgs(value = "") {
  return String(value || "").split(/\s+/).filter(Boolean);
}

function buildSupervisedPiPrompt(run = {}) {
  return [
    `Run ID: ${run.id || "unknown"}`,
    "Runner mode: supervised-pi",
    run.sourceUrl ? `Source Slack URL: ${run.sourceUrl}` : "Source Slack URL: unavailable",
    run.team || run.channel || run.threadTs || run.user
      ? `Requester metadata: team=${run.team || "unknown"} channel=${run.channel || "unknown"} threadTs=${run.threadTs || "unknown"} user=${run.user || "unknown"}`
      : "Requester metadata: unavailable",
    "",
    "User prompt:",
    String(run.prompt || ""),
    "",
    "Instructions:",
    "- Treat the Slack request as approved for this selected supervised-pi profile, but do not turn raw Slack text into shell commands.",
    "- Summarize actions taken and validation performed.",
    "- Do not reveal secrets, tokens, credentials, cookies, or session values.",
  ].join("\n");
}

async function writePromptFile(prompt) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mom-supervised-pi-"));
  const path = join(dir, "prompt.md");
  await writeFile(path, prompt, { mode: 0o600 });
  return { dir, path };
}

export async function runFakeAgent({ run, signal, onEvent = async () => {} }) {
  for (const text of ["queued fake runner", "inspected prompt", "completed fake plan"]) {
    if (signal?.aborted) throw new Error("agent run canceled");
    await onEvent({ ts: new Date().toISOString(), type: "runner", text });
    await sleep(10, signal);
  }
  const hash = promptHash(run.prompt || "");
  return {
    markdown: `# Agent Run ${run.id}\n\nMode: fake\nPrompt hash: ${hash}\n\n- No external tools executed.\n- No repository files changed.\n- This is a deterministic confirmation-flow smoke test.`,
    promptHash: hash,
  };
}

async function defaultCommandRunner({ command, args, cwd, env, signal, timeoutMs = DEFAULT_TIMEOUT_MS, outputCapChars = OUTPUT_CAP_CHARS }) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000).unref?.();
    }, timeoutMs);
    const abort = () => {
      try { child.kill("SIGTERM"); } catch {}
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout = cap(stdout + chunk.toString(), outputCapChars); });
    child.stderr.on("data", (chunk) => { stderr = cap(stderr + chunk.toString(), outputCapChars); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
      resolve({ command, args, code: null, signal: null, stdout: "", stderr: cap(error.message, outputCapChars), timedOut });
    });
    child.on("close", (code, closeSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abort);
      resolve({ command, args, code, signal: closeSignal, stdout: cap(stdout, outputCapChars), stderr: cap(stderr, outputCapChars), timedOut });
    });
  });
}

export async function runSupervisedPiAgent({
  run,
  signal,
  onEvent = async () => {},
  workdir = process.cwd(),
  commandRunner = defaultCommandRunner,
  command = DEFAULT_SUPERVISED_PI_COMMAND,
  profile = DEFAULT_SUPERVISED_PI_PROFILE,
  extraArgs = [],
  timeoutMs = DEFAULT_SUPERVISED_PI_TIMEOUT_MS,
  outputCapChars = DEFAULT_SUPERVISED_PI_OUTPUT_CAP_CHARS,
} = {}) {
  if (signal?.aborted) throw new Error("agent run canceled");
  const prompt = buildSupervisedPiPrompt(run);
  const hash = promptHash(prompt);
  const boundedTimeoutMs = boundedNumber(timeoutMs, DEFAULT_SUPERVISED_PI_TIMEOUT_MS, { min: 1000, max: DEFAULT_SUPERVISED_PI_TIMEOUT_MS });
  const boundedOutputCapChars = boundedNumber(outputCapChars, DEFAULT_SUPERVISED_PI_OUTPUT_CAP_CHARS, { min: 1000, max: DEFAULT_SUPERVISED_PI_OUTPUT_CAP_CHARS });
  const promptFile = await writePromptFile(prompt);
  try {
    const safeExtraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    const args = [
      ...safeExtraArgs.map(String),
      "--profile", String(profile || DEFAULT_SUPERVISED_PI_PROFILE),
      "--no-session",
      "-p", `@${promptFile.path}`,
    ];
    await onEvent({
      ts: new Date().toISOString(),
      type: "command",
      text: `running supervised Pi profile ${profile || DEFAULT_SUPERVISED_PI_PROFILE}`,
    });
    const env = scrubSensitiveEnv();
    const result = await commandRunner({ command, args, cwd: workdir, env, signal, timeoutMs: boundedTimeoutMs, outputCapChars: boundedOutputCapChars, shell: false });
    if (signal?.aborted) throw new Error("agent run canceled");
    const stdout = cap(result.stdout || "", boundedOutputCapChars);
    const stderr = cap(result.stderr || "", boundedOutputCapChars);
    const markdown = [
      `# Agent Run ${run?.id || "unknown"}`,
      "",
      "Mode: supervised-pi",
      `Profile: \`${profile || DEFAULT_SUPERVISED_PI_PROFILE}\``,
      `Workdir: \`${workdir}\``,
      `Prompt hash: ${hash}`,
      `Exit: ${result.code ?? result.signal ?? "error"}${result.timedOut ? " (timeout)" : ""}`,
      "",
      stdout ? `stdout:\n\`\`\`\n${stdout}\n\`\`\`` : "stdout: (empty)",
      stderr ? `stderr:\n\`\`\`\n${stderr}\n\`\`\`` : "stderr: (empty)",
    ].join("\n");
    return {
      markdown,
      promptHash: hash,
      wired: true,
      command: { command: result.command || command, args: result.args || args, code: result.code, signal: result.signal, timedOut: Boolean(result.timedOut) },
    };
  } finally {
    await rm(promptFile.dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runRepoHealthAgent({ run, signal, onEvent = async () => {}, workdir = process.cwd(), commandRunner = defaultCommandRunner, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const results = [];
  const env = scrubSensitiveEnv();
  for (const [command, args] of REPO_HEALTH_COMMANDS) {
    if (signal?.aborted) throw new Error("agent run canceled");
    await onEvent({ ts: new Date().toISOString(), type: "command", text: `running ${command} ${args.join(" ")}` });
    const result = await commandRunner({ command, args: [...args], cwd: workdir, env, signal, timeoutMs, shell: false });
    results.push(result);
    if (signal?.aborted) throw new Error("agent run canceled");
  }

  const markdown = [
    `# Agent Run ${run.id}`,
    "",
    "Mode: repo-health",
    `Workdir: \`${workdir}\``,
    "",
    ...results.map((result) => [
      `## \`${result.command} ${result.args.join(" ")}\``,
      `exit: ${result.code ?? result.signal ?? "error"}${result.timedOut ? " (timeout)" : ""}`,
      result.stdout ? `\nstdout:\n\`\`\`\n${cap(result.stdout, 4000)}\n\`\`\`` : "",
      result.stderr ? `\nstderr:\n\`\`\`\n${cap(result.stderr, 4000)}\n\`\`\`` : "",
    ].join("\n")),
  ].join("\n");

  return { markdown, commands: results.map(({ command, args, code, signal, timedOut }) => ({ command, args, code, signal, timedOut })) };
}

export function createAgentRunner({
  mode = "fake",
  trace = () => {},
  workdir,
  commandRunner,
  timeoutMs,
  supervisedPi = {},
} = {}) {
  if (!AGENT_RUNNER_MODES.includes(mode)) throw new Error(`invalid agent runner mode: ${mode}`);
  return {
    mode,
    async run({ run, signal, onEvent }) {
      trace("agent.runner_started", { runId: run.id, mode });
      if (mode === "fake") return runFakeAgent({ run, signal, onEvent });
      if (mode === "supervised-pi") {
        return runSupervisedPiAgent({
          run,
          signal,
          onEvent,
          workdir: supervisedPi.workdir || workdir,
          commandRunner,
          command: supervisedPi.command,
          profile: supervisedPi.profile,
          extraArgs: supervisedPi.extraArgs,
          timeoutMs: supervisedPi.timeoutMs ?? timeoutMs,
          outputCapChars: supervisedPi.outputCapChars,
        });
      }
      return runRepoHealthAgent({ run, signal, onEvent, workdir, commandRunner, timeoutMs });
    },
  };
}
