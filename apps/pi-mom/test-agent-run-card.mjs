import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentRunCard, buildAgentRunUpdate, parseAgentRequest } from "./lib/agent-run-card.mjs";
import { createRunStore } from "./lib/agent-run-store.mjs";
import { createAgentRunner, getAgentRunnerModes, getRepoHealthCommandTuples, parseSupervisedPiExtraArgs, runFakeAgent, runRepoHealthAgent, runSupervisedPiAgent, scrubSensitiveEnv } from "./lib/agent-runners.mjs";
import { createRunCanvas } from "./lib/slack-canvas.mjs";

const sampleRun = {
  id: "run_test",
  status: "pending_confirmation",
  runnerMode: "fake",
  prompt: "repo health please",
  channel: "C123",
  threadTs: "1.2",
  user: "U123",
  events: [],
};

assert.deepEqual(parseAgentRequest("repo health please"), { prompt: "repo health please" });
assert.equal(parseAgentRequest("   "), undefined);

const card = buildAgentRunCard(sampleRun);
const encoded = JSON.stringify(card);
assert.match(encoded, /agent_run_start/);
assert.match(encoded, /agent_run_cancel/);
assert.match(encoded, /run_test/);
assert.match(encoded, /supervised-pi/);

const supervisedCard = buildAgentRunCard({ ...sampleRun, runnerMode: "supervised-pi" });
assert.match(JSON.stringify(supervisedCard), /supervised-pi/);
assert.match(JSON.stringify(buildAgentRunUpdate({ ...sampleRun, runnerMode: "supervised-pi" })), /supervised-pi launches Pi with fixed argv/);

const dir = await mkdtemp(join(tmpdir(), "pi-mom-agent-test-"));
try {
  const path = join(dir, "runs.json");
  const store = createRunStore({ path });
  await store.load();
  await store.create(sampleRun);
  await store.update("run_test", { status: "running", events: [{ type: "started", text: "Started" }] });
  const reloaded = createRunStore({ path });
  await reloaded.load();
  const run = await reloaded.get("run_test");
  assert.equal(run.status, "running");
  assert.equal(run.events[0].type, "started");
} finally {
  await rm(dir, { recursive: true, force: true });
}

const fakeA = await runFakeAgent({ run: sampleRun, onEvent: async () => {} });
const fakeB = await runFakeAgent({ run: sampleRun, onEvent: async () => {} });
assert.equal(fakeA.promptHash, fakeB.promptHash);
assert.match(fakeA.markdown, /No external tools executed/);

assert.deepEqual(getAgentRunnerModes(), ["fake", "repo-health", "supervised-pi"]);
assert.deepEqual(parseSupervisedPiExtraArgs("--model test  --safe"), ["--model", "test", "--safe"]);
const scrubbed = scrubSensitiveEnv({ PATH: "/bin", SLACK_BOT_TOKEN: "xoxb-secret", LINEAR_API_KEY: "lin_api_secret", OPENAI_API_KEY: "sk-secret", NORMAL: "ok" });
assert.deepEqual(scrubbed, { PATH: "/bin", NORMAL: "ok" });
const supervisedEvents = [];
let promptPathSeen = "";
const supervised = await runSupervisedPiAgent({
  run: { ...sampleRun, runnerMode: "supervised-pi", sourceUrl: "https://slack.example/archives/C123/p12", team: "T123" },
  workdir: "/tmp/repo",
  command: "pi-test",
  profile: "covent-speed-operator",
  extraArgs: ["--model", "safe-test"],
  outputCapChars: 1000,
  onEvent: async (event) => supervisedEvents.push(event),
  commandRunner: async ({ command, args, cwd, shell, env }) => {
    assert.equal(command, "pi-test");
    assert.equal(cwd, "/tmp/repo");
    assert.equal(shell, false);
    assert.equal(env.SLACK_BOT_TOKEN, undefined);
    assert.deepEqual(args.slice(0, 2), ["--model", "safe-test"]);
    assert.deepEqual(args.slice(2, 5), ["--profile", "covent-speed-operator", "--no-session"]);
    assert.equal(args[5], "-p");
    assert.match(args[6], /^@/);
    assert.doesNotMatch(args.join(" "), /repo health please/);
    promptPathSeen = args[6].slice(1);
    const promptStat = await stat(promptPathSeen);
    assert.equal(promptStat.mode & 0o777, 0o600);
    return { command, args, code: 0, signal: null, stdout: `ok sk-proj-${"a".repeat(20)} ${"x".repeat(1500)}`, stderr: "", timedOut: false };
  },
});
assert.equal(supervised.wired, true);
assert.match(supervised.markdown, /Mode: supervised-pi/);
assert.match(supervised.markdown, /Profile: `covent-speed-operator`/);
assert.doesNotMatch(supervised.markdown, /sk-proj-[a-z]+/);
assert.match(supervised.markdown, /output truncated/);
assert.equal(supervisedEvents[0].type, "command");
await assert.rejects(() => stat(promptPathSeen), /ENOENT/);

const supervisedRunner = createAgentRunner({
  mode: "supervised-pi",
  workdir: "/tmp/fallback",
  commandRunner: async ({ command, args, cwd, shell }) => ({ command, args, cwd, shell, code: 0, signal: null, stdout: "ok", stderr: "", timedOut: false }),
  supervisedPi: { command: "pi-test", profile: "profile-test", extraArgs: [] },
});
assert.equal(supervisedRunner.mode, "supervised-pi");
const supervisedRunnerResult = await supervisedRunner.run({ run: { ...sampleRun, runnerMode: "supervised-pi" }, onEvent: async () => {} });
assert.equal(supervisedRunnerResult.wired, true);
assert.equal(supervisedRunnerResult.command.args.includes("--profile"), true);
assert.throws(() => createAgentRunner({ mode: "bash -c nope" }), /invalid agent runner mode/);

const controller = new AbortController();
controller.abort();
await assert.rejects(() => runFakeAgent({ run: sampleRun, signal: controller.signal }), /canceled/);
await assert.rejects(() => runSupervisedPiAgent({ run: sampleRun, signal: controller.signal }), /canceled/);

assert.deepEqual(getRepoHealthCommandTuples(), [
  ["git", ["rev-parse", "--show-toplevel"]],
  ["git", ["status", "--short"]],
  ["node", ["--check", "apps/pi-mom/index.mjs"]],
  ["node", ["--check", "apps/pi-mom/doctor.mjs"]],
  ["node", ["--check", "apps/pi-mom/lib/agent-run-card.mjs"]],
  ["node", ["--check", "apps/pi-mom/lib/agent-run-store.mjs"]],
  ["node", ["--check", "apps/pi-mom/lib/agent-runners.mjs"]],
  ["node", ["--check", "apps/pi-mom/lib/slack-canvas.mjs"]],
]);

const calls = [];
const repoResult = await runRepoHealthAgent({
  run: { ...sampleRun, runnerMode: "repo-health" },
  workdir: "/tmp/repo",
  onEvent: async () => {},
  commandRunner: async ({ command, args, cwd, shell }) => {
    calls.push({ command, args, cwd, shell });
    return { command, args, code: 0, signal: null, stdout: "ok", stderr: "", timedOut: false };
  },
});
assert.equal(calls.length, getRepoHealthCommandTuples().length);
assert.equal(calls.every((call) => call.shell === false), true);
assert.deepEqual(calls.map((call) => [call.command, call.args]), getRepoHealthCommandTuples());
assert.doesNotMatch(repoResult.markdown, /rm -rf|bash -c|sh -c/);

const canvas = await createRunCanvas({
  client: { apiCall: async (method, payload) => ({ ok: true, canvas_id: "F123", canvas_url: "https://slack.example/canvas/F123", method, payload }) },
  run: sampleRun,
  markdown: "# Result",
});
assert.deepEqual(canvas, { id: "F123", url: "https://slack.example/canvas/F123" });
const synthesizedCanvas = await createRunCanvas({
  client: { apiCall: async () => ({ ok: true, canvas_id: "F456" }) },
  run: { ...sampleRun, team: "T123" },
  markdown: "# Result",
});
assert.deepEqual(synthesizedCanvas, { id: "F456", url: "https://app.slack.com/docs/T123/F456" });
const failedCanvas = await createRunCanvas({ client: { apiCall: async () => { throw new Error("nope"); } }, run: sampleRun, markdown: "x" });
assert.equal(failedCanvas, undefined);

console.log("agent run card tests passed");
