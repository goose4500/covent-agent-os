# PR Spec — Wire `supervised-pi` runner for trusted internal speed mode

Status: implementation-ready
Owner: Jake + Pi
Base branch: `feat/pi-mom-agent-run-card`
Target PR branch: `feat/supervised-pi-runner`

## 1. Goal

Turn the current `supervised-pi` no-exec stub into a bounded, auditable runner that can launch Pi from a Slack Agent Run Card using a fixed argv array and a selected trusted profile.

The runner should support Covent's trusted internal speed-mode posture without turning raw Slack text into shell commands.

## 2. First-principles model

```text
Slack agent: request
  → Agent Run Card with Start/Cancel
  → PI_MOM_AGENT_RUNNER=supervised-pi
  → fixed Pi command argv, shell:false
  → prompt passed via 0600 temp file
  → scrubbed child env
  → timeout/output caps/redaction
  → Slack run update + optional Canvas
```

Explicit Slack invocation + button click is approval for this selected runner/profile. Safety comes from fixed command construction, env scrubbing, source-linked audit, output caps, timeout, and kill/cancel behavior — not from refusing to run Pi.

## 3. Non-goals

- Do not allow raw Slack text to become a shell command.
- Do not add arbitrary bash execution.
- Do not pass Slack/Linear/OpenAI/API tokens into the Pi child process by default.
- Do not push, deploy, or mutate remote systems from the implementation agent.
- Do not redesign all `pi-mom` routing or migrate to TypeScript.
- Do not alter the Slack manifest in this PR.

## 4. Required behavior

### 4.1 Runner mode

`PI_MOM_AGENT_RUNNER=supervised-pi` must be accepted by startup validation and by `createAgentRunner()`.

### 4.2 Env config

Add/document these env vars in `apps/pi-mom/.env.example`, `.env.railway.example`, and README:

```text
PI_MOM_SUPERVISED_PI_COMMAND=pi
PI_MOM_SUPERVISED_PI_PROFILE=covent-speed-operator
PI_MOM_SUPERVISED_PI_WORKDIR=/home/jfloyd/covent-agent-os
PI_MOM_SUPERVISED_PI_TIMEOUT_MS=300000
PI_MOM_SUPERVISED_PI_OUTPUT_CAP_CHARS=20000
PI_MOM_SUPERVISED_PI_EXTRA_ARGS=
```

Defaults should be safe and local-friendly:

- command: `pi`
- profile: `covent-speed-operator`
- workdir: existing agent runner workdir or `process.cwd()`
- timeout: bounded, e.g. 300000ms max unless existing bounds require less
- output cap: bounded
- extra args: parsed as whitespace-separated args; do not eval or shell-expand

### 4.3 Command construction

The supervised Pi runner must spawn with `shell: false`.

Expected shape:

```js
[
  ...extraArgs,
  "--profile", profile,
  "--no-session",
  "-p", `@${promptPath}`
]
```

If Pi does not support `--profile`, use the closest repo-supported mechanism, but keep argv fixed and document the choice in code/README.

### 4.4 Prompt file

Pass the run prompt through a temporary file with mode `0600`, not argv.

Prompt should include:

- run id
- runner mode
- source Slack URL if available
- original user/requester metadata if available
- user prompt
- instruction to summarize actions and validation
- instruction not to reveal secrets

Clean up temp files after run completion/failure where practical.

### 4.5 Environment scrubbing

Reuse/extend existing `scrubSensitiveEnv()` so the child does not inherit secrets by default.

Do not pass env keys matching token/secret/key/password/cookie/session/slack/linear/openai/anthropic/gemini/xai/aws.

### 4.6 Output handling

Capture stdout/stderr separately.

Return markdown containing:

- run id
- mode
- profile
- workdir
- prompt hash
- exit code/signal/timeout state
- capped redacted stdout/stderr

No token-like strings should survive redaction.

### 4.7 Cancel/timeout

Existing Agent Run Card cancel path should abort the child process.

Timeout must terminate child with SIGTERM and then SIGKILL fallback, consistent with existing command runner behavior.

### 4.8 Tests

Update/add tests for:

- supervised-pi mode is listed/accepted
- invalid mode still rejected
- commandRunner receives fixed command/args and `shell:false` semantics where testable
- prompt is not embedded directly in argv
- output is capped/redacted
- aborted signal rejects or terminates consistently
- check script includes new tests/files

Use fake `commandRunner` injection where possible. Do not run a real Pi process in tests.

## 5. Suggested implementation seams

Likely files:

- `apps/pi-mom/lib/agent-runners.mjs`
- `apps/pi-mom/test-agent-run-card.mjs` or new focused runner test
- `apps/pi-mom/index.mjs` for config plumbing into `createAgentRunner()`
- `apps/pi-mom/README.md`
- `apps/pi-mom/.env.example`
- `apps/pi-mom/.env.railway.example`
- `apps/pi-mom/package.json` if adding a new test file to check script

Keep changes PR-sized. Avoid moving modules unless necessary.

## 6. Acceptance criteria

- `PI_MOM_AGENT_RUNNER=supervised-pi` no longer returns the no-exec stub when configured with injected/fake runner in tests.
- Real execution path is implemented via fixed `spawn`/commandRunner contract with `shell:false`.
- Tests do not require real Slack, Linear, or Pi credentials.
- `npm --prefix apps/pi-mom run check` passes.
- `npm run check` passes.
- `git diff --check` passes.
- Final worker commit is created on isolated branch `feat/supervised-pi-runner`.

## 7. Review checklist

- No secrets in code/docs/tests.
- No raw Slack prompt as shell command.
- No broad refactor unrelated to supervised-pi.
- Docs explain speed-mode defaults and how to disable/restrict.
- Failure modes produce useful Slack-visible markdown without leaking secrets.

## 8. Commit message expectation

Use a detailed conventional commit, e.g.

```text
feat(pi-mom): wire supervised Pi agent runner
```

Body should explain:

- why this is the next speed-mode primitive
- how command execution remains bounded
- env/config knobs
- validation run
- what remains for future PRs
```
